import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const CONFIG = "wrangler.canary.jsonc";
const BASE_URL =
  "https://twenty-crm-redis-free-canary.rikitrader.workers.dev";
const EVIDENCE_PATH = "docs/evidence/g12-rollback-drill.json";
const JOB_COUNT = 25;
const JOB_DELAY_SECONDS = 45;
const TARGET_ROLLBACK_MS = 15 * 60_000;
const token = randomBytes(32).toString("base64url");
const startedAt = Date.now();

function command(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: options.input ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    if (options.input) child.stdin.end(options.input);
    child.once("error", reject);
    child.once("exit", (code) => {
      const result = {
        code,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
      };
      if (code === 0 || options.allowFailure) resolve(result);
      else
        reject(
          new Error(
            `${command} ${args.join(" ")} failed (${code}): ${(result.stderr || result.stdout).slice(-3_000)}`,
          ),
        );
    });
  });
}

async function request(path, init = {}) {
  const response = await fetch(new URL(path, BASE_URL), {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(init.timeoutMs ?? 60_000),
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function waitForBackend(expected, timeoutMs = 10 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await request("/_status").catch(() => null);
    if (last?.body?.redisBackend === expected) return last.body;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(
    `backend did not become ${expected}: ${JSON.stringify(last?.body)}`,
  );
}

async function waitForAuth() {
  const deadline = Date.now() + 5 * 60_000;
  const stableForMs = 30_000;
  let stableSince = null;
  while (Date.now() < deadline) {
    const checks = await Promise.all(
      Array.from({ length: 10 }, () =>
        request("/_canary/keys").catch(() => null),
      ),
    );
    if (checks.every((result) => result?.response.ok)) {
      stableSince ??= Date.now();
      if (Date.now() - stableSince >= stableForMs) return;
    } else {
      stableSince = null;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("canary token did not remain stable across Worker versions");
}

async function metrics() {
  const result = await request("/_canary/queue-metrics");
  assert.equal(result.response.ok, true, JSON.stringify(result.body));
  return result.body;
}

async function waitForQueueReconciliation(canaryBefore, dlqBefore) {
  const deadline = Date.now() + 5 * 60_000;
  let last;
  let zeroSince = null;
  while (Date.now() < deadline) {
    last = await metrics();
    if (
      last.canary.backlogCount <= canaryBefore &&
      last.dlq.backlogCount <= dlqBefore
    ) {
      zeroSince ??= Date.now();
      if (Date.now() - zeroSince >= 10_000) return last;
    } else {
      zeroSince = null;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`queue reconciliation increased backlog: ${JSON.stringify(last)}`);
}

async function waitForJobs(jobs) {
  const pending = new Map(jobs.map((job) => [job.jobId, job]));
  const completed = [];
  const deadline = Date.now() + 12 * 60_000;
  while (Date.now() < deadline && pending.size > 0) {
    await Promise.all(
      [...pending.values()].map(async (job) => {
        const result = await request(
          `/_canary/job-result?id=${encodeURIComponent(job.jobId)}`,
        );
        if (result.response.status === 200) {
          assert.equal(result.body.status, "completed");
          completed.push({
            ...job,
            completedAt: new Date().toISOString(),
            value: result.body.value,
          });
          pending.delete(job.jobId);
        } else {
          assert.equal(result.response.status, 202, JSON.stringify(result.body));
        }
      }),
    );
    if (pending.size > 0)
      await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  assert.equal(pending.size, 0, `${pending.size} rollback-window jobs missing`);
  return completed;
}

async function productionVersion() {
  const result = await command("./node_modules/.bin/wrangler", [
    "deployments",
    "status",
    "--config",
    "wrangler.jsonc",
  ]);
  return result.stdout.match(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/)?.[0];
}

async function deployCurrent(message) {
  await command("./node_modules/.bin/wrangler", [
    "deploy",
    "--config",
    CONFIG,
    "--message",
    message,
  ]);
}

async function rollbackWorker(message) {
  await command("./node_modules/.bin/wrangler", [
    "rollback",
    "--config",
    CONFIG,
    "--message",
    message,
  ]);
}

async function ensureCanaryExists() {
  const status = await command(
    "./node_modules/.bin/wrangler",
    ["deployments", "status", "--config", CONFIG],
    { allowFailure: true },
  );
  if (status.code !== 0)
    await deployCurrent("G12 bootstrap Redis-free canary");
}

const productionBefore = await productionVersion();
let rollbackPerformed = false;
let evidenceWritten = false;

try {
  await ensureCanaryExists();
  await command(
    "./node_modules/.bin/wrangler",
    ["secret", "put", "CANARY_TOKEN", "--config", CONFIG],
    { input: `${token}\n` },
  );
  await deployCurrent("G12 Redis-free rollback drill checkpoint");
  await waitForAuth();
  await waitForBackend("cloudflare");

  const beforeMetrics = await metrics();
  const jobs = await Promise.all(
    Array.from({ length: JOB_COUNT }, async () => {
      const enqueued = await request("/_canary/job", {
        method: "POST",
        body: {
          // Worker-native execution isolates the rollback/Queue/DO contract
          // from database or Container availability.
          scenario: "scheduler-ping",
          delaySeconds: JOB_DELAY_SECONDS,
        },
      });
      assert.equal(enqueued.response.status, 202, JSON.stringify(enqueued.body));
      assert.equal(typeof enqueued.body.jobId, "string");
      return enqueued.body;
    }),
  );
  assert.equal(new Set(jobs.map(({ jobId }) => jobId)).size, JOB_COUNT);

  // Roll back Worker code, never the coordination architecture. Wrangler
  // reverts to the immediately preceding version while the canary remains on
  // the Cloudflare state/queue/pub-sub backend.
  const decisionAt = Date.now();
  await rollbackWorker("G12 Redis-free Worker version rollback drill");
  rollbackPerformed = true;
  await waitForAuth();
  const rollbackStatus = await waitForBackend("cloudflare");
  const rollbackCompletedAt = Date.now();
  const rollbackMs = rollbackCompletedAt - decisionAt;
  assert.ok(
    rollbackMs < TARGET_ROLLBACK_MS,
    `rollback exceeded target: ${rollbackMs}ms`,
  );

  const completed = await waitForJobs(jobs);
  const afterMetrics = await waitForQueueReconciliation(
    beforeMetrics.canary.backlogCount,
    beforeMetrics.dlq.backlogCount,
  );
  const reconciledAt = Date.now();

  const productionAfter = await productionVersion();
  assert.equal(productionAfter, productionBefore);
  const evidence = {
    gate: "G12",
    passed: true,
    environment: "isolated-redis-free-canary",
    productionTouched: false,
    productionVersionBefore: productionBefore,
    productionVersionAfter: productionAfter,
    startedAt: new Date(startedAt).toISOString(),
    decisionAt: new Date(decisionAt).toISOString(),
    rollbackCompletedAt: new Date(rollbackCompletedAt).toISOString(),
    reconciledAt: new Date(reconciledAt).toISOString(),
    rollback: {
      from: "latest-worker-version",
      to: "previous-worker-version",
      mechanism: "wrangler rollback",
      statusReportedBackend: rollbackStatus.redisBackend,
      decisionToCompletionMs: rollbackMs,
      targetMs: TARGET_ROLLBACK_MS,
    },
    queueReconciliation: {
      delayedJobsEnqueued: JOB_COUNT,
      delayedBySeconds: JOB_DELAY_SECONDS,
      uniqueJobIds: JOB_COUNT,
      completedJobs: completed.length,
      missingJobs: 0,
      dlqBefore: beforeMetrics.dlq.backlogCount,
      dlqAfter: afterMetrics.dlq.backlogCount,
      queueBacklogAfter: afterMetrics.canary.backlogCount,
      decisionToReconciledMs: reconciledAt - decisionAt,
    },
  };
  await writeFile(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
  evidenceWritten = true;
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  if (rollbackPerformed) {
    await deployCurrent("G12 drill cleanup: restore current Redis-free canary");
    await waitForAuth();
    await waitForBackend("cloudflare");
  }
  if (!evidenceWritten)
    console.error("G12 evidence was not written; canary backend cleanup attempted");
}
