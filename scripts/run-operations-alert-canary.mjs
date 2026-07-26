import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

const BASE_URL =
  process.env.CANARY_BASE_URL ??
  "https://twenty-crm-redis-free-canary.rikitrader.workers.dev";
const TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 1_000;

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
    headers: { authorization: `Bearer ${token}` },
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

const token = randomBytes(32).toString("base64url");
await putToken(token);
await waitForAuth(token);

const result = await request("/_canary/alert-test", token, { method: "POST" });
assert.equal(
  result.response.status,
  200,
  `alert delivery failed (${result.response.status}): ${JSON.stringify(result.body)}`,
);
assert.deepEqual(result.body, {
  sent: true,
  channel: "email",
  alertCodes: ["dlq-age", "executor-not-ready", "job-queue-age"],
});

console.log(
  JSON.stringify(
    {
      worker: new URL(BASE_URL).hostname,
      testedAt: new Date().toISOString(),
      passed: true,
      delivery: result.body,
      productionTouched: false,
    },
    null,
    2,
  ),
);
