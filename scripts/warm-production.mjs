import assert from "node:assert/strict";

const baseUrl = (
  process.env.PRODUCTION_URL ??
  "https://twenty-crm.rikitrader.workers.dev"
).replace(/\/$/, "");
const deadline = Date.now() + 6 * 60_000;
const attempts = [];

async function timedFetch(path, init = {}) {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    signal: AbortSignal.timeout(310_000),
  });
  const body = await response.text();
  return {
    response,
    body,
    durationMs: Math.round(performance.now() - startedAt),
  };
}

let health;
while (Date.now() < deadline) {
  try {
    health = await timedFetch("/healthz");
    attempts.push({
      status: health.response.status,
      durationMs: health.durationMs,
    });
    if (health.response.ok) break;
  } catch (error) {
    attempts.push({
      error: error instanceof Error ? error.message : String(error),
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}

assert.ok(health?.response.ok, `production did not become ready: ${JSON.stringify(attempts)}`);

const navigationHeaders = { accept: "text/html" };
const shellSeed = await timedFetch("/", { headers: navigationHeaders });
assert.equal(shellSeed.response.status, 200);
assert.match(shellSeed.response.headers.get("content-type") ?? "", /text\/html/);

// KV propagation is usually immediate, but allow a short bounded window.
let edgeShell;
for (let attempt = 0; attempt < 10; attempt += 1) {
  edgeShell = await timedFetch("/", { headers: navigationHeaders });
  if (edgeShell.response.headers.get("x-twenty-edge-shell") === "hit") break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}

assert.equal(edgeShell?.response.status, 200);
assert.equal(
  edgeShell?.response.headers.get("x-twenty-edge-shell"),
  "hit",
  "versioned edge shell was not populated",
);

const status = await timedFetch("/_status");
const statusBody = JSON.parse(status.body);
assert.equal(status.response.status, 200);
assert.equal(statusBody.productionReady, true);
assert.equal(statusBody.redisBackend, "cloudflare");

console.log(
  JSON.stringify(
    {
      result: "ready",
      baseUrl,
      healthAttempts: attempts,
      serverWarmMs: health.durationMs,
      shellSeedMs: shellSeed.durationMs,
      edgeShellMs: edgeShell.durationMs,
      edgeShell: edgeShell.response.headers.get("x-twenty-edge-shell"),
      productionReady: statusBody.productionReady,
      redisBackend: statusBody.redisBackend,
    },
    null,
    2,
  ),
);
