import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

const BASE_URL =
  "https://twenty-crm-redis-free-canary.rikitrader.workers.dev";
const POLL_INTERVAL_MS = 2_000;
const SCENARIO_TIMEOUT_MS = 4 * 60_000;

async function rotateToken() {
  const token = randomBytes(32).toString("base64url");
  const child = spawn(
    "./node_modules/.bin/wrangler",
    ["secret", "put", "CANARY_TOKEN", "--config", "wrangler.canary.jsonc"],
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
    throw new Error(`CANARY_TOKEN rotation failed (${code}): ${output}`);
  return token;
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
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const { response } = await request("/_canary/keys", token);
    if (response.ok) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error("rotated canary token did not become active");
}

async function waitForExecutorReady(token) {
  const deadline = Date.now() + 6 * 60_000;
  let last = "not attempted";
  while (Date.now() < deadline) {
    try {
      const result = await request("/_canary/executor", token, {
        method: "POST",
      });
      last = `${result.response.status}:${JSON.stringify(result.body)}`;
      if (
        result.response.status === 200 &&
        result.body.executorStatus === 204
      )
        return;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`canary executor did not become ready: ${last}`);
}

async function runScenario(scenario, token) {
  const started = await request("/_canary/job", token, {
    method: "POST",
    body: JSON.stringify({ scenario }),
  });
  if (started.response.status !== 202 || typeof started.body.jobId !== "string")
    throw new Error(
      `${scenario} enqueue failed (${started.response.status}): ${JSON.stringify(started.body)}`,
    );

  const deadline = Date.now() + SCENARIO_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await request(
      `/_canary/job-result?id=${encodeURIComponent(started.body.jobId)}`,
      token,
    );
    if (result.response.status === 200) {
      const sideEffects =
        scenario === "fail-after-side-effect"
          ? await request(
              `/_canary/job-side-effects?id=${encodeURIComponent(started.body.jobId)}`,
              token,
            )
          : undefined;
      return {
        scenario,
        jobId: started.body.jobId,
        status: result.body.status,
        reason: result.body.value?.reason,
        ...(sideEffects ? { sideEffectCount: sideEffects.body.count } : {}),
      };
    }
    if (result.response.status !== 202)
      throw new Error(
        `${scenario} result failed (${result.response.status}): ${JSON.stringify(result.body)}`,
      );
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`${scenario} did not settle before the canary timeout`);
}

async function runFullContainerCrash(token) {
  const started = await request("/_canary/job", token, {
    method: "POST",
    body: JSON.stringify({ scenario: "full-container-crash" }),
  });
  if (started.response.status !== 202 || typeof started.body.jobId !== "string")
    throw new Error(
      `full-container-crash enqueue failed (${started.response.status}): ${JSON.stringify(started.body)}`,
    );
  console.log(`full-container-crash-job: ${started.body.jobId}`);

  const startDeadline = Date.now() + SCENARIO_TIMEOUT_MS;
  while (Date.now() < startDeadline) {
    const observed = await request(
      `/_canary/job-started?id=${encodeURIComponent(started.body.jobId)}`,
      token,
    );
    if (observed.response.status === 200) break;
    if (observed.response.status !== 202)
      throw new Error(
        `full-container-crash start observation failed (${observed.response.status}): ${JSON.stringify(observed.body)}`,
      );
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  const observed = await request(
    `/_canary/job-started?id=${encodeURIComponent(started.body.jobId)}`,
    token,
  );
  if (observed.response.status !== 200)
    throw new Error("full-container-crash handler did not start");

  const destroyed = await request("/_canary/restart-worker", token, {
    method: "POST",
  });
  if (
    destroyed.response.status !== 202 ||
    destroyed.body.target !== "worker"
  )
    throw new Error(
      `full-container-crash destroy failed (${destroyed.response.status}): ${JSON.stringify(destroyed.body)}`,
    );

  const deadline = Date.now() + SCENARIO_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await request(
      `/_canary/job-result?id=${encodeURIComponent(started.body.jobId)}`,
      token,
    );
    if (result.response.status === 200) {
      return {
        scenario: "full-container-crash",
        jobId: started.body.jobId,
        status: result.body.status,
        reason: result.body.value?.reason,
        handlerStartedBeforeDestroy: true,
        containerDestroyed: true,
      };
    }
    if (result.response.status !== 202)
      throw new Error(
        `full-container-crash result failed (${result.response.status}): ${JSON.stringify(result.body)}`,
      );
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error("full-container-crash did not settle before timeout");
}

const token = process.argv.includes("--rotate-token")
  ? await rotateToken()
  : process.env.CANARY_TOKEN;
if (!token)
  throw new Error("set CANARY_TOKEN or pass --rotate-token");

await waitForAuth(token);
const preflightRestart = await request("/_canary/restart-worker", token, {
  method: "POST",
});
if (
  preflightRestart.response.status !== 202 ||
  preflightRestart.body.target !== "worker"
)
  throw new Error(
    `canary worker preflight restart failed (${preflightRestart.response.status}): ${JSON.stringify(preflightRestart.body)}`,
  );
console.log("preflight-worker-restart: accepted");
await waitForExecutorReady(token);
console.log("preflight-executor-ready: 204");

const expected = new Map([
  ["ping", { status: "completed", reason: undefined }],
  [
    "fail-permanent",
    { status: "quarantined", reason: "permanent-executor-response" },
  ],
  [
    "fail-transient",
    { status: "quarantined", reason: "retry-limit-exceeded" },
  ],
  [
    "fail-after-side-effect",
    {
      status: "quarantined",
      reason: "executor-outcome-ambiguous",
      sideEffectCount: 1,
    },
  ],
  [
    "disconnect",
    { status: "quarantined", reason: "executor-outcome-ambiguous" },
  ],
  [
    "crash",
    { status: "quarantined", reason: "executor-outcome-ambiguous" },
  ],
]);

const results = [];
for (const scenario of expected.keys()) {
  const result = await runScenario(scenario, token);
  const wanted = expected.get(scenario);
  if (
    result.status !== wanted.status ||
    result.reason !== wanted.reason ||
    (wanted.sideEffectCount !== undefined &&
      result.sideEffectCount !== wanted.sideEffectCount)
  )
    throw new Error(
      `${scenario} settled unexpectedly: ${JSON.stringify(result)}`,
    );
  results.push(result);
  console.log(
    `${scenario}: ${result.status}${result.reason ? ` (${result.reason})` : ""}`,
  );
}

const fullContainerCrash = await runFullContainerCrash(token);
if (
  fullContainerCrash.status !== "quarantined" ||
  fullContainerCrash.reason !== "executor-outcome-ambiguous"
)
  throw new Error(
    `full-container-crash settled unexpectedly: ${JSON.stringify(fullContainerCrash)}`,
  );
results.push(fullContainerCrash);
console.log(
  "full-container-crash: quarantined (executor-outcome-ambiguous)",
);

const recovery = await runScenario("ping", token);
if (recovery.status !== "completed")
  throw new Error(`post-crash recovery failed: ${JSON.stringify(recovery)}`);
results.push({ ...recovery, scenario: "post-crash-ping" });
console.log("post-crash-ping: completed");

console.log(
  JSON.stringify(
    {
      worker: "twenty-crm-redis-free-canary",
      passed: true,
      scenarios: results,
    },
    null,
    2,
  ),
);
