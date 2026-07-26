import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

const staging = process.argv.includes("--staging");
const BASE_URL = staging
  ? "https://twenty-crm-enterprise-staging.rikitrader.workers.dev"
  : "https://twenty-crm-redis-free-canary.rikitrader.workers.dev";
const PROBE_URL = staging
  ? "https://twenty-enterprise-staging-probe.rikitrader.workers.dev"
  : "https://twenty-g9-access-probe.rikitrader.workers.dev";
const TARGET_CONFIG = staging
  ? "wrangler.staging.jsonc"
  : "wrangler.canary.jsonc";
const PROBE_CONFIG = staging
  ? "wrangler.staging-probe.jsonc"
  : "wrangler.g9-probe.jsonc";
const POLL_INTERVAL_MS = 2_000;
const TIMEOUT_MS = 2 * 60_000;

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

async function directRequest(path, token, init = {}) {
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (init.body) headers.set("content-type", "application/json");
  const response = await fetch(new URL(path, BASE_URL), {
    ...init,
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

let activeProbeToken;

async function waitFor(label, operation) {
  const deadline = Date.now() + TIMEOUT_MS;
  let last;
  while (Date.now() < deadline) {
    last = await operation();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`${label} did not settle: ${JSON.stringify(last)}`);
}

async function probeRequest(probeToken, path, init = {}) {
  const response = await fetch(new URL("/probe", PROBE_URL), {
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

async function request(path, token, init = {}) {
  return staging
    ? probeRequest(activeProbeToken, path, init)
    : directRequest(path, token, init);
}

const opsRequest = probeRequest;

async function waitForTokens(canaryToken, probeToken) {
  activeProbeToken = probeToken;
  const deadline = Date.now() + TIMEOUT_MS;
  let last = {};
  let lastSerialized = "";
  while (Date.now() < deadline) {
    const [canary, operations] = await Promise.all([
      request("/_canary/keys", canaryToken),
      opsRequest(probeToken, "/_ops/job-failures?limit=1"),
    ]);
    last = {
      canaryStatus: canary.response.status,
      operationsStatus: operations.response.status,
      operationsContentType:
        operations.response.headers.get("content-type") ?? undefined,
      operationsError:
        typeof operations.body.error === "string"
          ? operations.body.error
          : undefined,
    };
    const serialized = JSON.stringify(last);
    if (serialized !== lastSerialized) {
      console.log(`auth-readiness: ${serialized}`);
      lastSerialized = serialized;
    }
    if (canary.response.ok && operations.response.ok) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`rotated tokens did not settle: ${JSON.stringify(last)}`);
}

async function createFixture(canaryToken, reason) {
  const result = await request("/_canary/dlq-fixture", canaryToken, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
  if (
    result.response.status !== 202 ||
    typeof result.body.failureId !== "string"
  )
    throw new Error(
      `fixture creation failed (${result.response.status}): ${JSON.stringify(result.body)}`,
    );
  return result.body;
}

async function waitForFailure(probeToken, failureId) {
  return waitFor(`failure ${failureId}`, async () => {
    const result = await opsRequest(
      probeToken,
      `/_ops/job-failures/${encodeURIComponent(failureId)}`,
    );
    return result.response.status === 200 ? result.body : null;
  });
}

async function action(probeToken, failureId, name, body) {
  return opsRequest(
    probeToken,
    `/_ops/job-failures/${encodeURIComponent(failureId)}/${name}`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
}

const rotate = process.argv.includes("--rotate-tokens");
let canaryToken = process.env.CANARY_TOKEN;
let opsToken = process.env.OPS_TOKEN;
let probeToken = process.env.PROBE_TOKEN;
if (rotate) {
  canaryToken = randomBytes(32).toString("base64url");
  opsToken = randomBytes(32).toString("base64url");
  probeToken = randomBytes(32).toString("base64url");
  await putSecrets(
    { CANARY_TOKEN: canaryToken, OPS_TOKEN: opsToken },
    TARGET_CONFIG,
  );
  await putSecrets(
    {
      ...(staging ? { CANARY_TOKEN: canaryToken } : {}),
      OPS_TOKEN: opsToken,
      PROBE_TOKEN: probeToken,
    },
    PROBE_CONFIG,
  );
}
if (!canaryToken || !opsToken || !probeToken)
  throw new Error(
    "set CANARY_TOKEN, OPS_TOKEN, and PROBE_TOKEN or pass --rotate-tokens",
  );
await waitForTokens(canaryToken, probeToken);

const unauthorized = await directRequest("/_ops/job-failures?limit=1", null, {
  redirect: "manual",
});
if (![302, 401, 403].includes(unauthorized.response.status))
  throw new Error(
    `operations endpoint did not fail closed (${unauthorized.response.status}): ${JSON.stringify(unauthorized.body)}`,
  );

const uncertain = await createFixture(
  canaryToken,
  "executor-outcome-ambiguous",
);
const uncertainRecord = await waitForFailure(probeToken, uncertain.failureId);
if (
  uncertainRecord.failure?.status !== "quarantined" ||
  uncertainRecord.failure?.source !== "application" ||
  uncertainRecord.audit?.[0]?.action !== "ingested"
)
  throw new Error(
    `uncertain failure was not ingested: ${JSON.stringify(uncertainRecord)}`,
  );

const staleReplay = await action(
  probeToken,
  uncertain.failureId,
  "replay",
  {
    expectedVersion: uncertainRecord.failure.version + 1,
    note: "stale version canary",
    confirmUncertainOutcome: true,
  },
);
if (staleReplay.response.status !== 409)
  throw new Error(`stale replay did not fail with conflict`);

const unconfirmedReplay = await action(
  probeToken,
  uncertain.failureId,
  "replay",
  {
    expectedVersion: uncertainRecord.failure.version,
    note: "confirmation guard canary",
  },
);
if (unconfirmedReplay.response.status !== 409)
  throw new Error(`ambiguous replay did not require confirmation`);

const replay = await action(probeToken, uncertain.failureId, "replay", {
  expectedVersion: uncertainRecord.failure.version,
  note: "reconciled and approved by isolated G9 canary",
  confirmUncertainOutcome: true,
});
if (
  replay.response.status !== 202 ||
  replay.body.status !== "replayed" ||
  typeof replay.body.replayJobId !== "string"
)
  throw new Error(
    `confirmed replay failed (${replay.response.status}): ${JSON.stringify(replay.body)}`,
  );

let replayResult;
try {
  replayResult = await waitFor("replayed ping", async () => {
    const result = await request(
      `/_canary/job-result?id=${encodeURIComponent(replay.body.replayJobId)}`,
      canaryToken,
    );
    return result.response.status === 200 ? result.body : null;
  });
} catch (error) {
  const [job, summary] = await Promise.all([
    request(
      `/_canary/job-result?id=${encodeURIComponent(replay.body.replayJobId)}`,
      canaryToken,
    ),
    opsRequest(probeToken, "/_ops/job-failures/summary"),
  ]);
  throw new Error(
    `${error instanceof Error ? error.message : String(error)}; diagnostics=${JSON.stringify({
      jobStatus: job.response.status,
      job: job.body,
      queueMetrics: summary.body.queues,
    })}`,
  );
}
if (replayResult.status !== "completed")
  throw new Error(
    `replayed fixture did not complete: ${JSON.stringify(replayResult)}`,
  );

const replayedRecord = await waitForFailure(
  probeToken,
  uncertain.failureId,
);
const replayActions = new Set(
  replayedRecord.audit.map(({ action: name }) => name),
);
for (const expected of ["ingested", "replay_requested", "replay_enqueued"]) {
  if (!replayActions.has(expected))
    throw new Error(`missing ${expected} audit event`);
}

const dismissible = await createFixture(
  canaryToken,
  "permanent-executor-response",
);
const dismissibleRecord = await waitForFailure(
  probeToken,
  dismissible.failureId,
);
const dismissed = await action(
  probeToken,
  dismissible.failureId,
  "dismiss",
  {
    expectedVersion: dismissibleRecord.failure.version,
    note: "dismissed by isolated G9 canary",
  },
);
if (dismissed.response.status !== 200 || dismissed.body.status !== "dismissed")
  throw new Error(
    `dismiss failed (${dismissed.response.status}): ${JSON.stringify(dismissed.body)}`,
  );
const dismissedRecord = await waitForFailure(
  probeToken,
  dismissible.failureId,
);
if (
  dismissedRecord.failure.status !== "dismissed" ||
  !dismissedRecord.audit.some(({ action: name }) => name === "dismissed")
)
  throw new Error(`dismissal was not persisted and audited`);

const bulkFixtures = await Promise.all([
  createFixture(canaryToken, "permanent-executor-response"),
  createFixture(canaryToken, "permanent-executor-response"),
]);
const bulkRecords = await Promise.all(
  bulkFixtures.map((fixture) =>
    waitForFailure(probeToken, fixture.failureId),
  ),
);
const bulkRequestId = `g9-bulk-${randomBytes(12).toString("hex")}`;
const bulk = await opsRequest(
  probeToken,
  "/_ops/job-failures/bulk-replay",
  {
    method: "POST",
    body: JSON.stringify({
      requestId: bulkRequestId,
      note: "reviewed and approved by isolated G9 bounded bulk canary",
      confirmBulkReplay: true,
      items: bulkRecords.map((record) => ({
        id: record.failure.id,
        expectedVersion: record.failure.version,
      })),
    }),
  },
);
if (
  bulk.response.status !== 202 ||
  bulk.body.requested !== 2 ||
  bulk.body.completed !== 2 ||
  bulk.body.stoppedEarly !== false ||
  !Array.isArray(bulk.body.results)
)
  throw new Error(
    `bounded bulk replay failed (${bulk.response.status}): ${JSON.stringify(bulk.body)}`,
  );
await Promise.all(
  bulk.body.results.map((result) =>
    waitFor(`bulk replay ${result.id}`, async () => {
      if (typeof result.replayJobId !== "string") return null;
      const observed = await request(
        `/_canary/job-result?id=${encodeURIComponent(result.replayJobId)}`,
        canaryToken,
      );
      return observed.response.status === 200 &&
        observed.body.status === "completed"
        ? observed.body
        : null;
    }),
  ),
);
const bulkFinalRecords = await Promise.all(
  bulkFixtures.map((fixture) =>
    waitForFailure(probeToken, fixture.failureId),
  ),
);
for (const record of bulkFinalRecords) {
  if (
    record.failure.status !== "replayed" ||
    !record.audit.some(({ action: name, metadata_json: metadata }) => {
      if (name !== "replay_enqueued" || typeof metadata !== "string")
        return false;
      try {
        return JSON.parse(metadata).bulkRequestId === bulkRequestId;
      } catch {
        return false;
      }
    })
  )
    throw new Error("bulk replay did not persist its shared audit request id");
}

const list = await opsRequest(
  probeToken,
  "/_ops/job-failures?status=quarantined&limit=1",
);
if (
  list.response.status !== 200 ||
  !Array.isArray(list.body.failures) ||
  list.body.failures.some((failure) => Object.hasOwn(failure, "job"))
)
  throw new Error("bounded list response is invalid or exposes job payloads");

const summary = await opsRequest(
  probeToken,
  "/_ops/job-failures/summary",
);
if (
  summary.response.status !== 200 ||
  typeof summary.body.queues?.jobs?.backlogCount !== "number" ||
  typeof summary.body.queues?.dlq?.backlogCount !== "number" ||
  typeof summary.body.failures?.counts !== "object"
)
  throw new Error(
    `realtime operations summary is invalid: ${JSON.stringify(summary.body)}`,
  );

console.log(
  JSON.stringify(
    {
      worker: staging
        ? "twenty-crm-enterprise-staging"
        : "twenty-crm-redis-free-canary",
      database: staging
        ? "twenty-ops-enterprise-staging"
        : "twenty-ops-canary",
      productionChanged: false,
      passed: true,
      checks: {
        unauthenticatedDenied: true,
        atomicIngestionAndAudit: true,
        optimisticVersionConflict: true,
        uncertainOutcomeConfirmation: true,
        operatorReplayCompleted: true,
        immutableReplayAudit: true,
        operatorDismissalAudited: true,
        controlledBoundedBulkReplay: true,
        listPayloadRedaction: true,
        realtimeQueueMetrics: true,
      },
      replay: {
        failureId: uncertain.failureId,
        replayJobId: replay.body.replayJobId,
        finalStatus: replayedRecord.failure.status,
      },
      dismissal: {
        failureId: dismissible.failureId,
        finalStatus: dismissedRecord.failure.status,
      },
    },
    null,
    2,
  ),
);
