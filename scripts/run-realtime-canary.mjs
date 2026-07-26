import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import WebSocket from "ws";

const staging = process.argv.includes("--staging");
const baseUrl = (
  staging
    ? "https://twenty-crm-enterprise-staging.rikitrader.workers.dev"
    : (process.env.CANARY_BASE_URL ??
      "https://twenty-crm-redis-free-canary.rikitrader.workers.dev")
).replace(/\/$/, "");
const probeUrl =
  "https://twenty-enterprise-staging-probe.rikitrader.workers.dev";
const targetConfig = "wrangler.staging.jsonc";
const probeConfig = "wrangler.staging-probe.jsonc";

async function putSecrets(values, config) {
  const child = spawn(
    "./node_modules/.bin/wrangler",
    ["secret", "bulk", "--config", config],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output = (output + chunk.toString()).slice(-8_192);
  });
  child.stderr.on("data", (chunk) => {
    output = (output + chunk.toString()).slice(-8_192);
  });
  child.stdin.end(JSON.stringify(values));
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (code !== 0)
    throw new Error(`bulk secret rotation failed (${code}): ${output}`);
}

let token = process.env.CANARY_TOKEN;
let probeToken = process.env.PROBE_TOKEN;
if (process.argv.includes("--rotate-tokens")) {
  token = randomBytes(32).toString("base64url");
  probeToken = randomBytes(32).toString("base64url");
  await putSecrets({ CANARY_TOKEN: token }, targetConfig);
  await putSecrets(
    { CANARY_TOKEN: token, PROBE_TOKEN: probeToken },
    probeConfig,
  );
}
assert.ok(token, "Set CANARY_TOKEN or pass --rotate-tokens");
if (staging)
  assert.ok(probeToken, "Set PROBE_TOKEN or pass --rotate-tokens");

const channel = `realtime-canary:${crypto.randomUUID()}`;
const authorization = { authorization: `Bearer ${token}` };

async function probeRequest(path, init = {}) {
  const response = await fetch(`${probeUrl}/probe`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${probeToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      path,
      method: init.method ?? "GET",
      ...(init.body ? { body: JSON.parse(init.body) } : {}),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function json(path, init = {}) {
  if (staging) {
    const { response, body } = await probeRequest(path, init);
    assert.equal(
      response.ok,
      true,
      `${path} failed (${response.status}): ${JSON.stringify(body)}`,
    );
    return body;
  }
  const headers = new Headers(init.headers);
  headers.set("authorization", authorization.authorization);
  if (init.body) headers.set("content-type", "application/json");
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const body = await response.json().catch(() => ({}));
  assert.equal(
    response.ok,
    true,
    `${path} failed (${response.status}): ${JSON.stringify(body)}`,
  );
  return body;
}

async function waitForStagingAuth() {
  if (!staging) return;
  const deadline = Date.now() + 120_000;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    const { response } = await probeRequest("/_canary/keys");
    lastStatus = response.status;
    if (response.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`rotated staging credentials did not settle (${lastStatus})`);
}

async function publish(sequence) {
  return json("/_canary/realtime/publish", {
    method: "POST",
    body: JSON.stringify({ channel, payload: { sequence } }),
  });
}

function openSocket(after) {
  const url = new URL(
    staging ? `${probeUrl}/realtime` : `${baseUrl}/_canary/realtime`,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("channel", channel);
  url.searchParams.set("after", String(after));
  const socket = new WebSocket(url, {
    headers: staging
      ? { authorization: `Bearer ${probeToken}` }
      : authorization,
  });
  const frames = [];
  const waiters = [];
  const errors = [];
  let closeDetails;
  const opened = new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("unexpected-response", (_request, response) => {
      reject(
        new Error(
          `realtime upgrade rejected (${response.statusCode}): ${response.statusMessage}`,
        ),
      );
    });
  });
  socket.on("message", (raw) => {
    const frame = JSON.parse(String(raw));
    const waiterIndex = waiters.findIndex((waiter) => waiter.match(frame));
    if (waiterIndex >= 0) {
      const [waiter] = waiters.splice(waiterIndex, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
    } else frames.push(frame);
  });
  socket.on("error", (error) => errors.push(error));
  const next = (match, timeoutMs = 15_000) => {
    const index = frames.findIndex(match);
    if (index >= 0) return Promise.resolve(frames.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = {
        match,
        resolve,
        reject,
        timer: setTimeout(() => {
          const position = waiters.indexOf(waiter);
          if (position >= 0) waiters.splice(position, 1);
          reject(
            new Error(
              `timed out waiting for realtime frame; readyState=${socket.readyState}; ` +
                `close=${JSON.stringify(closeDetails)}; errors=${errors
                  .map((error) => error.message)
                  .join(",")}; frames=${JSON.stringify(frames)}`,
            ),
          );
        }, timeoutMs),
      };
      waiters.push(waiter);
    });
  };
  const closed = new Promise((resolve) =>
    socket.once("close", (code, reason) => {
      closeDetails = { code, reason: String(reason) };
      resolve(closeDetails);
    }),
  );
  return { socket, opened, next, closed, errors };
}

await waitForStagingAuth();

const denied = await fetch(`${baseUrl}/_canary/realtime/replay`, {
  headers: { accept: "application/json" },
  redirect: "manual",
});
assert.ok(
  [302, 401, 403].includes(denied.status),
  `unauthenticated realtime endpoint did not fail closed (${denied.status})`,
);

const first = await publish(1);
const primary = openSocket(0);
await primary.opened;
const replayed = await primary.next(
  (frame) => frame.type === "event" && frame.event.id === first.id,
);
assert.deepEqual(replayed.event.payload, { sequence: 1 });
await primary.next((frame) => frame.type === "ready");

const second = await publish(2);
const live = await primary.next(
  (frame) => frame.type === "event" && frame.event.id === second.id,
);
assert.deepEqual(live.event.payload, { sequence: 2 });
primary.socket.close(1000, "fault injection");
await primary.closed;

const third = await publish(3);
const reconnected = openSocket(second.id);
await reconnected.opened;
const recovered = await reconnected.next(
  (frame) => frame.type === "event" && frame.event.id === third.id,
);
assert.deepEqual(recovered.event.payload, { sequence: 3 });
await reconnected.next((frame) => frame.type === "ready");

const peer = openSocket(third.id);
await peer.opened;
await peer.next((frame) => frame.type === "ready");
const fourth = await publish(4);
const [primaryFanout, peerFanout] = await Promise.all([
  reconnected.next(
    (frame) => frame.type === "event" && frame.event.id === fourth.id,
  ),
  peer.next((frame) => frame.type === "event" && frame.event.id === fourth.id),
]);
assert.deepEqual(primaryFanout.event.payload, { sequence: 4 });
assert.deepEqual(peerFanout.event.payload, { sequence: 4 });

await json("/_canary/realtime/prune", {
  method: "POST",
  body: JSON.stringify({ channel, throughId: fourth.id }),
});
const replay = await json(
  `/_canary/realtime/replay?channel=${encodeURIComponent(channel)}&after=0`,
);
assert.equal(replay.gap, true);
assert.equal(replay.retentionFloor, fourth.id);

const stale = openSocket(0);
await stale.opened;
const gap = await stale.next((frame) => frame.type === "gap");
assert.equal(gap.retentionFloor, fourth.id);
const staleClose = await stale.closed;
assert.equal(staleClose.code, 4009);

for (const connection of [reconnected, peer]) {
  connection.socket.close(1000, "verification complete");
  await connection.closed;
  assert.equal(connection.errors.length, 0);
}

console.log(
  JSON.stringify(
    {
      capturedAt: new Date().toISOString(),
      worker: staging
        ? "twenty-crm-enterprise-staging"
        : "twenty-crm-redis-free-canary",
      accessProtected: staging,
      productionChanged: false,
      channel,
      results: {
        unauthenticatedDenied: true,
        backlogReplay: true,
        liveDelivery: true,
        reconnectMissedEventRecovery: true,
        multiSubscriberFanout: true,
        retentionGapDetected: true,
        staleSocketClosedWith4009: true,
      },
      eventIds: [first.id, second.id, third.id, fourth.id],
    },
    null,
    2,
  ),
);
