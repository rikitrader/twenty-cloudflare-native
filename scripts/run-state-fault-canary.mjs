import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const BASE_URL =
  process.env.CANARY_BASE_URL ??
  "https://twenty-crm-redis-free-canary.rikitrader.workers.dev";
const POLL_INTERVAL_MS = 1_000;
const TIMEOUT_MS = 90_000;

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function putToken(token) {
  const child = spawn(
    "rtk",
    [
      "./node_modules/.bin/wrangler",
      "secret",
      "put",
      "CANARY_TOKEN",
      "--config",
      "wrangler.canary.jsonc",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output = (output + chunk.toString()).slice(-8_192);
  });
  child.stderr.on("data", (chunk) => {
    output = (output + chunk.toString()).slice(-8_192);
  });
  child.stdin.end(`${token}\n`);
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (code !== 0)
    throw new Error(`CANARY_TOKEN update failed (${code}): ${output}`);
}

async function request(path, token, init = {}) {
  const response = await fetch(new URL(path, BASE_URL), {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function waitForAuth(token) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await request("/_canary/keys", token);
    if (result.response.ok) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error("canary token did not become active before timeout");
}

function alarmCleanupComplete(body) {
  return (
    body.values === 2 &&
    body.sets === 0 &&
    body.hashes === 0 &&
    body.lists === 0 &&
    body.keyExpiries === 0 &&
    body.locks === 0 &&
    body.expiredValues === 0 &&
    body.expiredCollections === 0 &&
    body.expiredLocks === 0 &&
    (body.alarmAt === null || body.alarmAt > Date.now())
  );
}

async function waitForResetAndCleanup(runId, token, initialIncarnationId) {
  const deadline = Date.now() + TIMEOUT_MS;
  let last;
  while (Date.now() < deadline) {
    const result = await request(
      `/_canary/state/inspect?runId=${encodeURIComponent(runId)}`,
      token,
    );
    if (result.response.ok) {
      last = result.body;
      if (
        last.incarnationId !== initialIncarnationId &&
        alarmCleanupComplete(last)
      )
        return last;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(
    `state reset/alarm cleanup did not complete: ${JSON.stringify(last)}`,
  );
}

const phase = option("--phase") ?? "full";
const tokenFile = option("--token-file");
const suppliedToken = tokenFile
  ? readFileSync(tokenFile, "utf8").trim()
  : process.env.CANARY_TOKEN;
const managesToken = process.argv.includes("--rotate-token");
const token = suppliedToken ?? randomBytes(32).toString("base64url");
if (!suppliedToken && !managesToken)
  throw new Error(
    "set CANARY_TOKEN, pass --token-file, or use --rotate-token in an authenticated environment",
  );
const runId = option("--run-id") ?? randomUUID();
const startedAt = new Date().toISOString();

if (managesToken) await putToken(token);
await waitForAuth(token);

let prepared;
let initialIncarnationId = option("--initial-incarnation-id");
if (phase !== "verify") {
  prepared = await request("/_canary/state/prepare", token, {
    method: "POST",
    body: JSON.stringify({ runId }),
  });
  if (!prepared.response.ok || prepared.body.passed !== true)
    throw new Error(
      `state preparation failed (${prepared.response.status}): ${JSON.stringify(prepared.body)}`,
    );
  initialIncarnationId = prepared.body.diagnostics?.incarnationId;
  if (typeof initialIncarnationId !== "string")
    throw new Error("state preparation omitted the incarnation identifier");
  if (phase === "prepare") {
    console.log(
      JSON.stringify(
        {
          runId,
          initialIncarnationId,
          concurrency: prepared.body.concurrency,
          fencing: prepared.body.fencing,
          ttl: prepared.body.ttl,
          diagnostics: prepared.body.diagnostics,
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }
}

if (typeof initialIncarnationId !== "string")
  throw new Error("--initial-incarnation-id is required for verify phase");

// Updating only the isolated canary secret creates a new Worker version. The
// token value remains unchanged so the probe can prove SQLite state survives
// the resulting Durable Object incarnation reset without persisting a secret.
if (phase === "full") {
  if (!managesToken)
    throw new Error(
      "full phase requires --rotate-token; use prepare/verify phases when secret rotation is external",
    );
  await putToken(token);
  await waitForAuth(token);
}
const afterReset = await waitForResetAndCleanup(
  runId,
  token,
  initialIncarnationId,
);

const verified = await request(
  `/_canary/state/verify?runId=${encodeURIComponent(runId)}`,
  token,
);
if (!verified.response.ok || verified.body.passed !== true)
  throw new Error(
    `state verification failed (${verified.response.status}): ${JSON.stringify(verified.body)}`,
  );

console.log(
  JSON.stringify(
    {
      worker: new URL(BASE_URL).hostname,
      runId,
      startedAt,
      completedAt: new Date().toISOString(),
      passed: true,
      ...(prepared
        ? {
            concurrency: prepared.body.concurrency,
            initialFencing: prepared.body.fencing,
            ttl: prepared.body.ttl,
          }
        : {}),
      resetPersistence: {
        passed:
          afterReset.incarnationId !== initialIncarnationId &&
          verified.body.persistence?.passed === true,
        beforeIncarnationId: initialIncarnationId,
        afterIncarnationId: afterReset.incarnationId,
        persistedCounter: verified.body.persistence?.counter,
        persistedCounterVersion: verified.body.persistence?.counterVersion,
      },
      alarmCleanup: verified.body.alarmCleanup,
      logicalExpiry: verified.body.logicalExpiry,
      fencingAfterExpiry: verified.body.fencing,
    },
    null,
    2,
  ),
);
