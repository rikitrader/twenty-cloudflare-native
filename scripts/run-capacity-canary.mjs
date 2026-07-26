import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

const PROBE_CONFIG = "wrangler.staging-probe.jsonc";
const TARGET_URL =
  "https://twenty-crm-enterprise-staging.rikitrader.workers.dev";
const PROBE_URL =
  "https://twenty-enterprise-staging-probe.rikitrader.workers.dev";
const BASELINE_WINDOW_DAYS = 14;
const BASELINE_PEAK_REQUESTS_PER_MINUTE = 1_525;
const TARGET_MULTIPLIER = 5;
const TARGET_OPERATIONS =
  BASELINE_PEAK_REQUESTS_PER_MINUTE * TARGET_MULTIPLIER;
const LOAD_DURATION_MS = 60_000;
const CLIENT_CONCURRENCY = 256;
const EXPECTED_SERVER_REPLICAS = 2;
const EXPECTED_WORKER_REPLICAS = 4;
const RUN_ID = `g8-${randomBytes(12).toString("hex")}`;
const CHANNEL = `realtime-canary:${RUN_ID}`;

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

const probeToken = randomBytes(32).toString("base64url");
await putSecrets({ PROBE_TOKEN: probeToken }, PROBE_CONFIG);

async function probe(path, init = {}, timeoutMs = 30_000) {
  const response = await fetch(`${PROBE_URL}/probe`, {
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
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function waitForCredentials() {
  const deadline = Date.now() + 300_000;
  const requiredStableMs = 90_000;
  let stableSince = null;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    const checks = await Promise.all(
      Array.from({ length: 25 }, () => probe("/_canary/keys")),
    );
    const allReady = checks.every(({ response }) => response.ok);
    lastStatus =
      checks.find(({ response }) => !response.ok)?.response.status ?? 200;
    if (allReady) {
      stableSince ??= Date.now();
      if (Date.now() - stableSince >= requiredStableMs) return;
    } else {
      stableSince = null;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(
    `rotated staging credentials did not remain stable for ${requiredStableMs}ms (${lastStatus})`,
  );
}

function percentile(values, percentage) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil((percentage / 100) * sorted.length) - 1];
}

function operationType(index) {
  const position = index % 20;
  if (position === 0) return "job";
  if (position <= 2) return "server";
  if (position <= 7) return "realtime";
  return "state";
}

await waitForCredentials();

const denied = await fetch(`${TARGET_URL}/_canary/load/state`, {
  method: "POST",
  redirect: "manual",
});
assert.ok([302, 401, 403].includes(denied.status));

const serverInstances = new Set();
const warmupDeadline = Date.now() + 12 * 60_000;
let lastWarmup = {};
while (
  Date.now() < warmupDeadline &&
  serverInstances.size < EXPECTED_SERVER_REPLICAS
) {
  try {
    const { response, body } = await probe(
      "/_canary/load/server",
      {},
      190_000,
    );
    lastWarmup = { status: response.status, body };
    if (response.ok && typeof body.instanceId === "string")
      serverInstances.add(body.instanceId);
  } catch (error) {
    lastWarmup = {
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (serverInstances.size < EXPECTED_SERVER_REPLICAS)
    await new Promise((resolve) => setTimeout(resolve, 2_000));
}
assert.equal(
  serverInstances.size,
  EXPECTED_SERVER_REPLICAS,
  `expected ${EXPECTED_SERVER_REPLICAS} server replicas, observed ${serverInstances.size}; ` +
    `last=${JSON.stringify(lastWarmup)}`,
);

const workerRestart = await probe(
  "/_canary/restart-worker",
  { method: "POST", body: "{}" },
  60_000,
);
assert.equal(workerRestart.response.status, 202);
assert.equal(workerRestart.body.legacyMainRetired, true);

const workerInstances = new Set();
let lastWorkerWarmup = {};
while (
  Date.now() < warmupDeadline &&
  workerInstances.size < EXPECTED_WORKER_REPLICAS
) {
  try {
    const { response, body } = await probe(
      "/_canary/executor",
      { method: "POST", body: "{}" },
      190_000,
    );
    lastWorkerWarmup = { status: response.status, body };
    if (
      response.ok &&
      body.executorStatus >= 200 &&
      body.executorStatus < 300 &&
      typeof body.executorInstance === "string"
    )
      workerInstances.add(body.executorInstance);
  } catch (error) {
    lastWorkerWarmup = {
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (workerInstances.size < EXPECTED_WORKER_REPLICAS)
    await new Promise((resolve) => setTimeout(resolve, 2_000));
}
assert.equal(
  workerInstances.size,
  EXPECTED_WORKER_REPLICAS,
  `expected ${EXPECTED_WORKER_REPLICAS} worker replicas, observed ${workerInstances.size}; ` +
    `last=${JSON.stringify(lastWorkerWarmup)}`,
);

const beforeMetrics = await probe("/_canary/queue-metrics");
assert.equal(beforeMetrics.response.ok, true);

const records = [];
const jobEnqueues = [];
const stateValues = [];
const realtimeIds = [];
const observedServerInstances = new Set(serverInstances);
let nextIndex = 0;
const startedAt = Date.now();

async function execute(index) {
  const type = operationType(index);
  const requestStarted = performance.now();
  let result;
  if (type === "state") {
    result = await probe("/_canary/load/state", {
      method: "POST",
      body: JSON.stringify({ runId: RUN_ID, sequence: index }),
    });
  } else if (type === "realtime") {
    result = await probe("/_canary/realtime/publish", {
      method: "POST",
      body: JSON.stringify({
        channel: CHANNEL,
        payload: { sequence: index },
      }),
    });
  } else if (type === "server") {
    result = await probe("/_canary/load/server", {}, 190_000);
  } else {
    result = await probe("/_canary/job", {
      method: "POST",
      body: JSON.stringify({ scenario: "ping" }),
    });
  }
  const latencyMs = performance.now() - requestStarted;
  records.push({ type, status: result.response.status, latencyMs });
  if (!result.response.ok) return;
  if (type === "state" && typeof result.body.value === "number")
    stateValues.push(result.body.value);
  if (type === "realtime" && typeof result.body.id === "number")
    realtimeIds.push(result.body.id);
  if (type === "server" && typeof result.body.instanceId === "string")
    observedServerInstances.add(result.body.instanceId);
  if (type === "job" && typeof result.body.jobId === "string")
    jobEnqueues.push({ id: result.body.jobId, enqueuedAt: Date.now() });
}

async function loadWorker() {
  while (true) {
    const index = nextIndex++;
    if (index >= TARGET_OPERATIONS) return;
    const dueAt =
      startedAt + Math.floor((index * LOAD_DURATION_MS) / TARGET_OPERATIONS);
    const delay = dueAt - Date.now();
    if (delay > 0)
      await new Promise((resolve) => setTimeout(resolve, delay));
    await execute(index);
  }
}

await Promise.all(
  Array.from({ length: CLIENT_CONCURRENCY }, () => loadWorker()),
);
const loadCompletedAt = Date.now();

const failed = records.filter(({ status }) => status < 200 || status >= 300);
assert.equal(records.length, TARGET_OPERATIONS);
assert.equal(failed.length, 0, JSON.stringify(failed.slice(0, 10)));

const expectedByType = Object.groupBy(
  Array.from({ length: TARGET_OPERATIONS }, (_, index) =>
    operationType(index),
  ),
  (type) => type,
);
const counts = Object.fromEntries(
  Object.entries(expectedByType).map(([type, values]) => [
    type,
    values.length,
  ]),
);
assert.equal(stateValues.length, counts.state);
assert.equal(new Set(stateValues).size, counts.state);
assert.equal(Math.max(...stateValues), counts.state);
assert.equal(realtimeIds.length, counts.realtime);
assert.equal(new Set(realtimeIds).size, counts.realtime);
assert.equal(jobEnqueues.length, counts.job);
assert.ok(observedServerInstances.size >= 2);

const pending = new Map(jobEnqueues.map((job) => [job.id, job]));
const jobCompletionLatencyMs = [];
const executorInstances = new Set(workerInstances);
const jobsDeadline = Date.now() + 180_000;
while (pending.size > 0 && Date.now() < jobsDeadline) {
  const ids = [...pending.keys()];
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batch = ids.slice(offset, offset + 100);
    const { response, body } = await probe("/_canary/load/jobs/status", {
      method: "POST",
      body: JSON.stringify({ ids: batch }),
    });
    assert.equal(response.ok, true);
    for (const result of body.results ?? []) {
      if (!result.completed) continue;
      const enqueued = pending.get(result.id);
      if (!enqueued) continue;
      const completedAt = Date.parse(result.value?.completedAt ?? "");
      if (Number.isFinite(completedAt))
        jobCompletionLatencyMs.push(completedAt - enqueued.enqueuedAt);
      if (typeof result.value?.executorInstance === "string")
        executorInstances.add(result.value.executorInstance);
      pending.delete(result.id);
    }
  }
  if (pending.size > 0)
    await new Promise((resolve) => setTimeout(resolve, 2_000));
}
assert.ok(executorInstances.size >= EXPECTED_WORKER_REPLICAS);

let afterMetrics;
const metricsDeadline = Date.now() + 120_000;
const initialCanaryBacklog =
  beforeMetrics.body.canary?.backlogCount ?? 0;
while (Date.now() < metricsDeadline) {
  afterMetrics = await probe("/_canary/queue-metrics");
  assert.equal(afterMetrics.response.ok, true);
  if (
    (afterMetrics.body.canary?.backlogCount ?? Number.POSITIVE_INFINITY) <=
    initialCanaryBacklog
  )
    break;
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}
assert.ok(afterMetrics);
assert.ok(
  (afterMetrics.body.canary?.backlogCount ?? Number.POSITIVE_INFINITY) <=
    initialCanaryBacklog,
  `canary Queue metrics did not converge: before=${initialCanaryBacklog}, ` +
    `after=${afterMetrics.body.canary?.backlogCount}`,
);

const latenciesByType = Object.fromEntries(
  Object.keys(counts).map((type) => {
    const values = records
      .filter((record) => record.type === type)
      .map((record) => record.latencyMs);
    return [
      type,
      {
        p50Ms: percentile(values, 50),
        p95Ms: percentile(values, 95),
        p99Ms: percentile(values, 99),
        maxMs: Math.max(...values),
      },
    ];
  }),
);
const overallLatencies = records.map(({ latencyMs }) => latencyMs);
const overallP95Ms = percentile(overallLatencies, 95);
const overallP99Ms = percentile(overallLatencies, 99);
const jobP95Ms = percentile(jobCompletionLatencyMs, 95);
const jobP99Ms = percentile(jobCompletionLatencyMs, 99);
const passed =
  pending.size === 0 &&
  overallP95Ms < 5_000 &&
  overallP99Ms < 10_000 &&
  typeof jobP95Ms === "number" &&
  jobP95Ms < 30_000 &&
  typeof jobP99Ms === "number" &&
  jobP99Ms < 120_000;

console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      scope: "production-topology-staging",
      result: passed ? "passed" : "failed",
      productionChanged: false,
      baseline: {
        source: "Cloudflare GraphQL workersInvocationsAdaptive",
        worker: "twenty-crm",
        windowDays: BASELINE_WINDOW_DAYS,
        peakRequestsPerMinute: BASELINE_PEAK_REQUESTS_PER_MINUTE,
      },
      target: {
        multiplier: TARGET_MULTIPLIER,
        operations: TARGET_OPERATIONS,
        intendedDurationMs: LOAD_DURATION_MS,
        achievedDurationMs: loadCompletedAt - startedAt,
        intendedRequestsPerSecond: TARGET_OPERATIONS / 60,
        clientConcurrency: CLIENT_CONCURRENCY,
      },
      mix: counts,
      results: {
        successfulOperations: records.length,
        failedOperations: failed.length,
        overallLatency: {
          p50Ms: percentile(overallLatencies, 50),
          p95Ms: overallP95Ms,
          p99Ms: overallP99Ms,
          maxMs: Math.max(...overallLatencies),
        },
        latencyByType: latenciesByType,
        stateUniqueAtomicValues: new Set(stateValues).size,
        realtimeUniqueEventIds: new Set(realtimeIds).size,
        jobsCompleted: jobCompletionLatencyMs.length,
        jobsPending: pending.size,
        jobCompletionLatency: {
          p50Ms: percentile(jobCompletionLatencyMs, 50),
          p95Ms: jobP95Ms,
          p99Ms: jobP99Ms,
          maxMs: Math.max(...jobCompletionLatencyMs),
        },
        serverReplicaCount: observedServerInstances.size,
        workerReplicaCount: executorInstances.size,
        finalCanaryQueueBacklog: afterMetrics.body.canary?.backlogCount,
      },
      queueMetrics: {
        before: beforeMetrics.body,
        after: afterMetrics.body,
      },
      privacy: {
        tokensPersisted: false,
        jobIdsPersisted: false,
        instanceIdsPersisted: false,
        applicationPayloadsPersisted: false,
      },
    },
    null,
    2,
  ),
);

assert.equal(pending.size, 0, `${pending.size} jobs did not complete`);
assert.ok(overallP95Ms < 5_000, `overall p95 ${overallP95Ms}ms`);
assert.ok(overallP99Ms < 10_000, `overall p99 ${overallP99Ms}ms`);
assert.ok(jobP95Ms < 30_000, `job completion p95 ${jobP95Ms}ms`);
assert.ok(jobP99Ms < 120_000, `job completion p99 ${jobP99Ms}ms`);
