import { getContainer, getRandom } from "@cloudflare/containers";
import { WorkerEntrypoint } from "cloudflare:workers";
import {
  TwentyBackup,
  TwentyContainer,
  TwentyServer,
  TwentyWorker,
} from "./containers";
import { BackupWorkflow } from "./backup";
import { handleWebhook, consumeBatch } from "./queue";
import {
  bearerAuthorized,
  boundedReplicaCount,
  evaluateOperationalStatus,
  hasRecentCustomerActivity,
  isEdgeShellRequest,
  shouldWriteStatus,
} from "./lib";
import {
  cloudflareBackendMisconfigured,
  deploymentMode,
  externalMode,
  nativeD1Mode,
  redisBackend,
  type Env,
  type WebhookMessage,
} from "./types";
import { TwentyState } from "./cloudflare-state/state-do";
import type { StateValueResult } from "./cloudflare-state/contracts";
import { consumeJobBatch } from "./jobs";
import type { CloudflareTwentyJob } from "./types";
import { TwentyScheduler } from "./schedule-do";
import { nextOccurrence } from "./schedule";
import { TwentyPubSub, type PubSubEvent } from "./pubsub-do";
import { handleD1Crm } from "./d1-crm";
import { d1Dashboard } from "./d1-dashboard";
import { profileDashboard } from "./profile-dashboard";
import { CrmExportWorkflow } from "./crm-workflow";
import {
  consumeJobFailureBatch,
  handleJobFailureOperations,
} from "./job-failures";
import { deterministicFailureId } from "./job-envelope";
import {
  accessTokenRevoked,
  authBearerToken,
  revokeAccessToken,
} from "./auth-revocation";
import {
  runOperationsAlertCheck,
  sendOperationsAlertTest,
} from "./operations-alerts";
import {
  clearReleaseMaintenance,
  getReleaseMaintenance,
  maintenanceResponse,
  putReleaseMaintenance,
} from "./release-gate";
import type {
  ProductionReleaseControl,
  ReleaseMaintenance,
} from "./release-contracts";
import {
  g3SessionCacheStatus,
  runG3SessionCacheSample,
} from "./g3-session-cache";

export { ContainerProxy } from "@cloudflare/containers";
export {
  TwentyContainer,
  TwentyServer,
  TwentyWorker,
  TwentyBackup,
  TwentyState,
  TwentyScheduler,
  TwentyPubSub,
  BackupWorkflow,
  CrmExportWorkflow,
};

const IMMUTABLE_ASSET = /\.(js|css|woff2?|png|jpe?g|svg|ico|webp)$/;
const BACKUP_CRON = "0 * * * *";
const STATUS_WRITE_INTERVAL_MS = 60_000;
const CUSTOMER_ACTIVE_WINDOW_MS = 20 * 60_000;
const EDGE_SHELL_TTL_SECONDS = 7 * 24 * 60 * 60;
const STATE_CANARY_CONCURRENCY = 64;
const STATE_CANARY_TTL_MS = 3_000;
let lastStatusWriteMs = 0;
let lastStatusOk: boolean | undefined;

function stateCanaryNamespace(runId: unknown): string | null {
  if (
    typeof runId !== "string" ||
    runId.length < 8 ||
    runId.length > 64 ||
    !/^[a-zA-Z0-9-]+$/.test(runId)
  )
    return null;
  return `canary:g2:${runId}`;
}

function loadCanaryRunId(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length < 8 ||
    value.length > 64 ||
    !/^[a-zA-Z0-9-]+$/.test(value)
  )
    return null;
  return value;
}

async function serverContainer(env: Env) {
  const replicas = boundedReplicaCount(env.SERVER_REPLICAS);
  return replicas > 1
    ? getRandom(env.TWENTY_SERVER, replicas)
    : getContainer(env.TWENTY_SERVER, "main");
}

async function workerContainer(env: Env) {
  const replicas = boundedReplicaCount(env.WORKER_REPLICAS);
  return replicas > 1
    ? getRandom(env.TWENTY_WORKER, replicas)
    : getContainer(env.TWENTY_WORKER, "main");
}

function edgeShellKey(env: Env): string | null {
  const versionId = env.CF_VERSION_METADATA?.id;
  return versionId ? `edge-shell:${versionId}` : null;
}

async function warmExternalContainers(env: Env): Promise<void> {
  const server = await serverContainer(env);
  await Promise.all([server.warm(), workerHealth(env).then(() => undefined)]);
}

async function handleCanary(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/_canary/")) return null;
  if (
    env.CANARY_MODE !== "true" ||
    !(
      bearerAuthorized(
        request.headers.get("authorization"),
        env.CANARY_TOKEN,
      ) ||
      bearerAuthorized(
        request.headers.get("x-canary-authorization"),
        env.CANARY_TOKEN,
      )
    )
  )
    return Response.json({ error: "unauthorized" }, { status: 401 });
  const state = env.STATE_DO.get(
    env.STATE_DO.idFromName("workspace:default"),
  );
  const realtime = env.PUBSUB_DO.get(
    env.PUBSUB_DO.idFromName("workspace:default"),
  );
  if (
    url.pathname === "/_canary/g3/soak" &&
    request.method === "POST"
  ) {
    let body: { runId?: unknown; passed?: unknown; stateGatewayMs?: unknown };
    try {
      body = (await request.json()) as {
        runId?: unknown;
        passed?: unknown;
        stateGatewayMs?: unknown;
      };
    } catch {
      return Response.json({ error: "invalid JSON" }, { status: 400 });
    }
    const runId = loadCanaryRunId(body.runId);
    const passed = body.passed === true;
    const stateGatewayMs =
      typeof body.stateGatewayMs === "number" &&
      Number.isFinite(body.stateGatewayMs) &&
      body.stateGatewayMs >= 0
        ? body.stateGatewayMs
        : null;
    if (!runId || stateGatewayMs === null)
      return Response.json({ error: "invalid soak sample" }, { status: 400 });
    const key = "g3:soak:summary";
    const existing = await env.STATUS_KV.get<{
      firstAt: string;
      lastAt: string;
      samples: number;
      failures: number;
      maxStateGatewayMs: number;
      runIds: string[];
    }>(key, "json");
    const now = new Date().toISOString();
    const summary = {
      firstAt: existing?.firstAt ?? now,
      lastAt: now,
      samples: (existing?.samples ?? 0) + 1,
      failures: (existing?.failures ?? 0) + (passed ? 0 : 1),
      maxStateGatewayMs: Math.max(existing?.maxStateGatewayMs ?? 0, stateGatewayMs),
      runIds: [...new Set([...(existing?.runIds ?? []).slice(-31), runId])],
    };
    await env.STATUS_KV.put(key, JSON.stringify(summary), { expirationTtl: 60 * 60 * 24 * 30 });
    return Response.json({ recorded: true, sample: { runId, passed, stateGatewayMs }, summary });
  }
  if (
    url.pathname === "/_canary/g3/soak" &&
    request.method === "GET"
  ) {
    const summary = await env.STATUS_KV.get<{
      firstAt: string;
      lastAt: string;
      samples: number;
      failures: number;
      maxStateGatewayMs: number;
      runIds: string[];
    }>("g3:soak:summary", "json");
    if (!summary)
      return Response.json({ samples: 0, failures: 0, ready: false });
    const durationMs = Date.parse(summary.lastAt) - Date.parse(summary.firstAt);
    return Response.json({
      ...summary,
      durationMs,
      requiredDurationMs: 7 * 24 * 60 * 60_000,
      ready:
        summary.samples >= 672 &&
        summary.failures === 0 &&
        summary.maxStateGatewayMs <= 5_000 &&
        durationMs >= 7 * 24 * 60 * 60_000,
    });
  }
  if (
    url.pathname === "/_canary/alert-test" &&
    request.method === "POST"
  ) {
    const alerts = await sendOperationsAlertTest(env);
    return Response.json({
      sent: true,
      channel: "email",
      alertCodes: alerts.map(({ code }) => code).sort(),
    });
  }
  if (
    url.pathname === "/_canary/recovery/export" &&
    request.method === "POST"
  ) {
    const id = `g11-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const instance = await env.BACKUP_WF.create({
      id,
      params: { force: true },
    });
    return Response.json(
      { id: instance.id, details: await instance.status() },
      { status: 202 },
    );
  }
  if (
    url.pathname === "/_canary/recovery/export" &&
    request.method === "GET"
  ) {
    const id = url.searchParams.get("id");
    if (!id || !/^g11-[a-zA-Z0-9-]{8,96}$/.test(id))
      return Response.json({ error: "invalid workflow id" }, { status: 400 });
    try {
      const instance = await env.BACKUP_WF.get(id);
      return Response.json({ id: instance.id, details: await instance.status() });
    } catch (error) {
      return Response.json(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        { status: 404 },
      );
    }
  }
  const scheduler = env.SCHEDULER_DO.get(
    env.SCHEDULER_DO.idFromName("workspace:default"),
  );
  if (
    url.pathname === "/_canary/schedule/prepare" &&
    request.method === "POST"
  ) {
    let body: { runId?: unknown };
    try {
      body = (await request.json()) as { runId?: unknown };
    } catch {
      return Response.json({ error: "invalid JSON" }, { status: 400 });
    }
    const namespace = stateCanaryNamespace(body.runId);
    if (!namespace || typeof body.runId !== "string")
      return Response.json({ error: "invalid runId" }, { status: 400 });
    const seeded = await scheduler.seedPastDueForCanary(body.runId);
    const duplicateJobId = await scheduler.duplicateOccurrenceForCanary(
      seeded.scheduleId,
    );
    await Promise.all([
      scheduler.fireAlarmForCanary(),
      scheduler.fireAlarmForCanary(),
    ]);
    const diagnostics = await scheduler.diagnosticsForCanary(
      seeded.scheduleId,
    );
    const springForward = nextOccurrence(
      { pattern: "30 2 * * *", timezone: "America/New_York" },
      Date.parse("2026-03-07T08:00:00Z"),
    );
    const fallBackFirst = nextOccurrence(
      { pattern: "30 1 * * *", timezone: "America/New_York" },
      Date.parse("2026-11-01T04:00:00Z"),
    );
    const fallBackNext = nextOccurrence(
      { pattern: "30 1 * * *", timezone: "America/New_York" },
      Date.parse("2026-11-01T05:30:00Z"),
    );
    const calendarPassed =
      springForward === Date.parse("2026-03-08T07:30:00.000Z") &&
      fallBackFirst === Date.parse("2026-11-01T05:30:00.000Z") &&
      fallBackNext === Date.parse("2026-11-02T06:30:00.000Z");
    const schedulingPassed =
      seeded.occurrence < Date.now() &&
      duplicateJobId === seeded.jobId &&
      !diagnostics.schedulePresent;
    const passed = schedulingPassed && calendarPassed;
    return Response.json(
      {
        passed,
        runId: body.runId,
        scheduleId: seeded.scheduleId,
        occurrence: seeded.occurrence,
        jobId: seeded.jobId,
        duplicateMessagesInjected: 2,
        duplicateAlarmInvocations: 2,
        missedAlarm: {
          passed: seeded.occurrence < Date.now(),
          lagMsAtResponse: Date.now() - seeded.occurrence,
        },
        calendar: {
          passed: calendarPassed,
          springForward,
          fallBackFirst,
          fallBackNext,
        },
        diagnostics,
      },
      { status: passed ? 200 : 500 },
    );
  }
  if (
    url.pathname === "/_canary/schedule/verify" &&
    request.method === "GET"
  ) {
    const jobId = url.searchParams.get("jobId");
    const scheduleId = url.searchParams.get("scheduleId");
    if (
      !jobId?.startsWith("schedule:") ||
      !scheduleId?.startsWith("canary-g5-")
    )
      return Response.json({ error: "invalid scheduler probe" }, { status: 400 });
    const result = (await state.getValue({
      namespace: "canary",
      key: `job:${jobId}`,
    })) as StateValueResult;
    const [execution, diagnostics] = await Promise.all([
      state.jobExecutionForCanary(jobId),
      scheduler.diagnosticsForCanary(scheduleId),
    ]);
    if (!result.found || !execution.found)
      return Response.json(
        {
          passed: false,
          status: "pending",
          resultFound: result.found,
          executionFound: execution.found,
        },
        { status: 202 },
      );
    const passed =
      execution.status === "completed" &&
      execution.attempts === 1 &&
      !diagnostics.schedulePresent;
    return Response.json(
      {
        passed,
        status: execution.status,
        attempts: execution.attempts,
        result: result.value,
        diagnostics,
      },
      { status: passed ? 200 : 500 },
    );
  }
  if (
    url.pathname === "/_canary/state/prepare" &&
    request.method === "POST"
  ) {
    let body: { runId?: unknown };
    try {
      body = (await request.json()) as { runId?: unknown };
    } catch {
      return Response.json({ error: "invalid JSON" }, { status: 400 });
    }
    const namespace = stateCanaryNamespace(body.runId);
    if (!namespace)
      return Response.json({ error: "invalid runId" }, { status: 400 });

    await state.clearNamespace(namespace);
    const increments = (await Promise.all(
      Array.from({ length: STATE_CANARY_CONCURRENCY }, () =>
        state.increment({
          namespace,
          key: "counter",
          delta: 1,
        }),
      ),
    )) as StateValueResult[];
    const observed = increments
      .map(({ value }) => value)
      .filter((value): value is number => typeof value === "number")
      .sort((left, right) => left - right);
    const expected = Array.from(
      { length: STATE_CANARY_CONCURRENCY },
      (_, index) => index + 1,
    );
    const counter = (await state.getValue({
      namespace,
      key: "counter",
    })) as StateValueResult;
    await state.setValue({
      namespace,
      key: "persistent",
      value: { runId: body.runId },
    });
    await state.setValue({
      namespace,
      key: "ttl-value",
      value: "expires",
      ttlMs: STATE_CANARY_TTL_MS,
    });
    await state.setAdd({
      namespace,
      key: "ttl-set",
      members: ["one", "two"],
    });
    await state.expireKey({
      namespace,
      key: "ttl-set",
      ttlMs: STATE_CANARY_TTL_MS,
    });
    await state.hashSet({
      namespace,
      key: "ttl-hash",
      field: "field",
      value: "value",
      ttlMs: STATE_CANARY_TTL_MS,
    });
    await state.listAppend({
      namespace,
      key: "ttl-list",
      value: "value",
    });
    await state.expireKey({
      namespace,
      key: "ttl-list",
      ttlMs: STATE_CANARY_TTL_MS,
    });
    const firstLock = await state.acquireLock({
      namespace,
      key: "lock",
      owner: "owner-a",
      ttlMs: STATE_CANARY_TTL_MS,
    });
    const competingLock = await state.acquireLock({
      namespace,
      key: "lock",
      owner: "owner-b",
      ttlMs: STATE_CANARY_TTL_MS,
    });
    const nonOwnerRelease = await state.releaseLock({
      namespace,
      key: "lock",
      owner: "owner-b",
    });
    const ownerRelease = await state.releaseLock({
      namespace,
      key: "lock",
      owner: "owner-a",
    });
    const secondLock = await state.acquireLock({
      namespace,
      key: "lock",
      owner: "owner-b",
      ttlMs: STATE_CANARY_TTL_MS,
    });
    const diagnostics = await state.diagnosticsForCanary(namespace);
    const concurrencyPassed =
      JSON.stringify(observed) === JSON.stringify(expected) &&
      counter.value === STATE_CANARY_CONCURRENCY &&
      counter.version === STATE_CANARY_CONCURRENCY;
    const fencingPassed =
      firstLock.acquired &&
      firstLock.fencingToken === 1 &&
      !competingLock.acquired &&
      !nonOwnerRelease &&
      ownerRelease &&
      secondLock.acquired &&
      secondLock.fencingToken === 2;
    const alarmScheduled =
      diagnostics.alarmAt !== null &&
      diagnostics.alarmAt >= Date.now() - STATE_CANARY_TTL_MS;
    const passed = concurrencyPassed && fencingPassed && alarmScheduled;

    return Response.json(
      {
        passed,
        namespace,
        concurrency: {
          passed: concurrencyPassed,
          operations: STATE_CANARY_CONCURRENCY,
          finalValue: counter.value,
          finalVersion: counter.version,
          uniqueResults: new Set(observed).size,
        },
        fencing: {
          passed: fencingPassed,
          firstToken: firstLock.fencingToken,
          competingAcquired: competingLock.acquired,
          nonOwnerRelease,
          ownerRelease,
          secondToken: secondLock.fencingToken,
        },
        ttl: {
          milliseconds: STATE_CANARY_TTL_MS,
          alarmScheduled,
        },
        diagnostics,
      },
      { status: passed ? 200 : 500 },
    );
  }
  if (
    url.pathname === "/_canary/state/inspect" &&
    request.method === "GET"
  ) {
    const namespace = stateCanaryNamespace(url.searchParams.get("runId"));
    if (!namespace)
      return Response.json({ error: "invalid runId" }, { status: 400 });
    return Response.json(await state.diagnosticsForCanary(namespace));
  }
  if (
    url.pathname === "/_canary/state/verify" &&
    request.method === "GET"
  ) {
    const runId = url.searchParams.get("runId");
    const namespace = stateCanaryNamespace(runId);
    if (!namespace)
      return Response.json({ error: "invalid runId" }, { status: 400 });
    const beforeReads = await state.diagnosticsForCanary(namespace);
    const persistent = (await state.getValue({
      namespace,
      key: "persistent",
    })) as StateValueResult;
    const counter = (await state.getValue({
      namespace,
      key: "counter",
    })) as StateValueResult;
    const ttlValue = (await state.getValue({
      namespace,
      key: "ttl-value",
    })) as StateValueResult;
    const [ttlSet, ttlHash, ttlList] = await Promise.all([
      state.setMembers({ namespace, key: "ttl-set" }),
      state.hashValues({ namespace, key: "ttl-hash" }),
      state.listRange({ namespace, key: "ttl-list" }),
    ]);
    const thirdLock = await state.acquireLock({
      namespace,
      key: "lock",
      owner: "owner-c",
      ttlMs: STATE_CANARY_TTL_MS,
    });
    await state.releaseLock({
      namespace,
      key: "lock",
      owner: "owner-c",
    });
    const alarmCleanupPassed =
      beforeReads.values === 2 &&
      beforeReads.sets === 0 &&
      beforeReads.hashes === 0 &&
      beforeReads.lists === 0 &&
      beforeReads.keyExpiries === 0 &&
      beforeReads.locks === 0 &&
      beforeReads.expiredValues === 0 &&
      beforeReads.expiredCollections === 0 &&
      beforeReads.expiredLocks === 0 &&
      (beforeReads.alarmAt === null || beforeReads.alarmAt > Date.now());
    const logicalExpiryPassed =
      !ttlValue.found &&
      ttlSet.length === 0 &&
      ttlHash.length === 0 &&
      ttlList.length === 0;
    const persistencePassed =
      persistent.found &&
      JSON.stringify(persistent.value) === JSON.stringify({ runId }) &&
      counter.found &&
      counter.value === STATE_CANARY_CONCURRENCY &&
      counter.version === STATE_CANARY_CONCURRENCY;
    const fencingPassed =
      thirdLock.acquired &&
      typeof thirdLock.fencingToken === "number" &&
      thirdLock.fencingToken > 2;
    const passed =
      alarmCleanupPassed &&
      logicalExpiryPassed &&
      persistencePassed &&
      fencingPassed;
    return Response.json(
      {
        passed,
        namespace,
        incarnationId: beforeReads.incarnationId,
        alarmCleanup: { passed: alarmCleanupPassed, beforeReads },
        logicalExpiry: {
          passed: logicalExpiryPassed,
          valueFound: ttlValue.found,
          setMembers: ttlSet,
          hashValues: ttlHash,
          listValues: ttlList,
        },
        persistence: {
          passed: persistencePassed,
          value: persistent.value,
          counter: counter.value,
          counterVersion: counter.version,
        },
        fencing: {
          passed: fencingPassed,
          tokenAfterExpiry: thirdLock.fencingToken,
        },
      },
      { status: passed ? 200 : 500 },
    );
  }
  if (
    url.pathname === "/_canary/realtime" &&
    request.method === "GET" &&
    request.headers.get("upgrade")?.toLowerCase() === "websocket"
  ) {
    const channel = url.searchParams.get("channel");
    const after = Number(url.searchParams.get("after") ?? "0");
    if (
      !channel?.startsWith("realtime-canary:") ||
      !Number.isSafeInteger(after) ||
      after < 0
    )
      return Response.json({ error: "invalid realtime probe" }, { status: 400 });
    return realtime.fetch(
      new Request(
        `http://twenty-events.internal/v1/events/socket?channel=${encodeURIComponent(channel)}&after=${after}`,
        {
          headers: {
            authorization: `Bearer ${env.INTERNAL_SERVICE_TOKEN}`,
            upgrade: "websocket",
          },
        },
      ),
    );
  }
  if (
    url.pathname === "/_canary/realtime/publish" &&
    request.method === "POST"
  ) {
    const body = (await request.json()) as {
      channel?: unknown;
      payload?: unknown;
    };
    if (
      typeof body.channel !== "string" ||
      !body.channel.startsWith("realtime-canary:")
    )
      return Response.json({ error: "invalid realtime probe" }, { status: 400 });
    return Response.json({
      id: await realtime.publish(body.channel, body.payload),
    });
  }
  if (
    url.pathname === "/_canary/realtime/prune" &&
    request.method === "POST"
  ) {
    const body = (await request.json()) as {
      channel?: unknown;
      throughId?: unknown;
    };
    if (
      typeof body.channel !== "string" ||
      !body.channel.startsWith("realtime-canary:") ||
      typeof body.throughId !== "number" ||
      !Number.isSafeInteger(body.throughId) ||
      body.throughId < 0
    )
      return Response.json({ error: "invalid realtime probe" }, { status: 400 });
    await realtime.pruneForCanary(body.channel, body.throughId);
    return Response.json({ pruned: true });
  }
  if (
    url.pathname === "/_canary/realtime/replay" &&
    request.method === "GET"
  ) {
    const channel = url.searchParams.get("channel");
    const after = Number(url.searchParams.get("after") ?? "0");
    if (
      !channel?.startsWith("realtime-canary:") ||
      !Number.isSafeInteger(after) ||
      after < 0
    )
      return Response.json({ error: "invalid realtime probe" }, { status: 400 });
    return Response.json(await realtime.replay(channel, after));
  }
  if (
    url.pathname === "/_canary/load/state" &&
    request.method === "POST"
  ) {
    let body: { runId?: unknown; sequence?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: "invalid JSON" }, { status: 400 });
    }
    const runId = loadCanaryRunId(body.runId);
    if (
      !runId ||
      typeof body.sequence !== "number" ||
      !Number.isSafeInteger(body.sequence) ||
      body.sequence < 0
    )
      return Response.json({ error: "invalid load probe" }, { status: 400 });
    const result = (await state.increment({
      namespace: `canary:g8:${runId}`,
      key: "hotspot",
      delta: 1,
      ttlMs: 60 * 60_000,
    })) as StateValueResult;
    return Response.json({
      sequence: body.sequence,
      value: result.value,
      version: result.version,
    });
  }
  if (
    url.pathname === "/_canary/load/server" &&
    request.method === "GET"
  ) {
    const server = await serverContainer(env);
    return server.fetch(
      new Request("http://twenty-server/_cloudflare/instance", {
        signal: request.signal,
      }),
    );
  }
  if (
    url.pathname === "/_canary/load/jobs/status" &&
    request.method === "POST"
  ) {
    let body: { ids?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: "invalid JSON" }, { status: 400 });
    }
    if (
      !Array.isArray(body.ids) ||
      body.ids.length === 0 ||
      body.ids.length > 100 ||
      body.ids.some(
        (id) =>
          typeof id !== "string" ||
          id.length < 8 ||
          id.length > 128,
      )
    )
      return Response.json({ error: "invalid job ids" }, { status: 400 });
    const results = await Promise.all(
      body.ids.map(async (id) => {
        const value = (await state.getValue({
          namespace: "canary",
          key: `job:${id}`,
        })) as StateValueResult;
        return {
          id,
          completed: value.found,
          ...(value.found ? { value: value.value } : {}),
        };
      }),
    );
    return Response.json({ results });
  }
  if (url.pathname === "/_canary/run" && request.method === "POST") {
    if (!env.CANARY_QUEUE)
      return Response.json(
        { error: "canary queue not configured" },
        { status: 503 },
      );
    const key = `probe:${crypto.randomUUID()}`;
    await state.setValue({
      namespace: "canary",
      key,
      value: { ok: true },
      ttlMs: 5 * 60_000,
    });
    const value = (await state.getValue({
      namespace: "canary",
      key,
    })) as StateValueResult;
    const counter = (await state.increment({
      namespace: "canary",
      key: `${key}:counter`,
      delta: 1,
      ttlMs: 5 * 60_000,
    })) as StateValueResult;
    const lock = await state.acquireLock({
      namespace: "canary",
      key: `${key}:lock`,
      owner: "canary-probe",
      ttlMs: 30_000,
    });
    await state.releaseLock({
      namespace: "canary",
      key: `${key}:lock`,
      owner: "canary-probe",
    });
    const events = env.PUBSUB_DO.get(
      env.PUBSUB_DO.idFromName("workspace:default"),
    );
    const channel = `canary:${key}`;
    const cursor = await events.cursor(channel);
    await events.publish(channel, { ok: true });
    const event = (await events.poll(
      channel,
      cursor,
      1_000,
    )) as PubSubEvent | null;
    const jobId = crypto.randomUUID();
    await env.CANARY_QUEUE.send({
      schemaVersion: 1,
      id: jobId,
      queueName: "__cloudflare_canary__",
      jobName: "ping",
      data: { key },
      createdAt: new Date().toISOString(),
      retryLimit: 2,
      priority: 5,
    });
    return Response.json({
      state: value.value,
      counter: counter.value,
      lock: lock.acquired,
      pubsub: event?.payload,
      jobId,
    });
  }
  if (url.pathname === "/_canary/result" && request.method === "GET") {
    const id = url.searchParams.get("id");
    if (!id)
      return Response.json({ error: "id required" }, { status: 400 });
    const result = (await state.getValue({
      namespace: "canary",
      key: `job:${id}`,
    })) as StateValueResult;
    return Response.json(result, { status: result.found ? 200 : 202 });
  }
  if (url.pathname === "/_canary/job" && request.method === "POST") {
    if (!env.CANARY_QUEUE)
      return Response.json(
        { error: "canary queue not configured" },
        { status: 503 },
      );
    let input: { scenario?: unknown; delaySeconds?: unknown };
    try {
      input = (await request.json()) as {
        scenario?: unknown;
        delaySeconds?: unknown;
      };
    } catch {
      return Response.json({ error: "invalid JSON" }, { status: 400 });
    }
    const scenarios = new Set([
      "ping",
      "scheduler-ping",
      "fail-permanent",
      "fail-transient",
      "fail-after-side-effect",
      "disconnect",
      "crash",
      "full-container-crash",
    ]);
    if (typeof input.scenario !== "string" || !scenarios.has(input.scenario))
      return Response.json({ error: "invalid scenario" }, { status: 400 });
    const delaySeconds =
      input.delaySeconds === undefined ? 0 : input.delaySeconds;
    if (
      typeof delaySeconds !== "number" ||
      !Number.isInteger(delaySeconds) ||
      delaySeconds < 0 ||
      delaySeconds > 900
    )
      return Response.json(
        { error: "invalid delaySeconds" },
        { status: 400 },
      );
    const jobId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    await env.CANARY_QUEUE.send(
      {
        schemaVersion: 1,
        id: jobId,
        queueName: "__cloudflare_canary__",
        jobName: input.scenario,
        data: null,
        createdAt,
        retryLimit:
          input.scenario === "fail-transient" ||
          input.scenario === "fail-after-side-effect"
            ? 1
            : 0,
        priority: 5,
        ...(delaySeconds > 0
          ? { notBefore: Date.now() + delaySeconds * 1_000 }
          : {}),
      },
      delaySeconds > 0 ? { delaySeconds } : undefined,
    );
    return Response.json(
      { jobId, scenario: input.scenario, delaySeconds, createdAt },
      { status: 202 },
    );
  }
  if (url.pathname === "/_canary/dlq-fixture" && request.method === "POST") {
    let input: { reason?: unknown };
    try {
      input = (await request.json()) as { reason?: unknown };
    } catch {
      return Response.json({ error: "invalid JSON" }, { status: 400 });
    }
    const reasons = new Set([
      "permanent-executor-response",
      "executor-outcome-ambiguous",
    ]);
    if (typeof input.reason !== "string" || !reasons.has(input.reason))
      return Response.json({ error: "invalid reason" }, { status: 400 });
    const jobId = crypto.randomUUID();
    const failureId = await deterministicFailureId(
      `${jobId}\0${input.reason}`,
    );
    await env.JOBS_DLQ.send({
      schemaVersion: 1,
      failureId,
      source: "application",
      reason: input.reason as
        | "permanent-executor-response"
        | "executor-outcome-ambiguous",
      failedAt: new Date().toISOString(),
      job: {
        schemaVersion: 1,
        id: jobId,
        queueName: "__cloudflare_canary__",
        jobName: "ping",
        data: { fixture: "g9-dlq-operations" },
        createdAt: new Date().toISOString(),
        retryLimit: 0,
        priority: 5,
      } satisfies CloudflareTwentyJob,
    });
    return Response.json({ failureId, jobId }, { status: 202 });
  }
  if (url.pathname === "/_canary/job-result" && request.method === "GET") {
    const id = url.searchParams.get("id");
    if (!id)
      return Response.json({ error: "id required" }, { status: 400 });
    const [completed, failed] = (await Promise.all([
      state.getValue({ namespace: "canary", key: `job:${id}` }),
      state.getValue({ namespace: "canary", key: `job-failure:${id}` }),
    ])) as [StateValueResult, StateValueResult];
    if (completed.found)
      return Response.json({ status: "completed", value: completed.value });
    if (failed.found)
      return Response.json({ status: "quarantined", value: failed.value });
    return Response.json({ status: "pending" }, { status: 202 });
  }
  if (
    url.pathname === "/_canary/job-started" &&
    request.method === "GET"
  ) {
    const id = url.searchParams.get("id");
    if (!id)
      return Response.json({ error: "id required" }, { status: 400 });
    const started = (await state.getValue({
      namespace: "canary",
      key: `job-started:${id}`,
    })) as StateValueResult;
    return Response.json(
      started.found
        ? { status: "started", value: started.value }
        : { status: "pending" },
      { status: started.found ? 200 : 202 },
    );
  }
  if (
    url.pathname === "/_canary/job-side-effects" &&
    request.method === "GET"
  ) {
    const id = url.searchParams.get("id");
    if (!id)
      return Response.json({ error: "id required" }, { status: 400 });
    const sideEffects = (await state.getValue({
      namespace: "canary",
      key: `job-side-effects:${id}`,
    })) as StateValueResult;
    return Response.json(
      sideEffects.found
        ? { count: sideEffects.value }
        : { count: 0 },
    );
  }
  if (url.pathname === "/_canary/keys" && request.method === "GET") {
    return Response.json(
      await state.scanKeys({
        namespace: "canary",
        pattern: "job:*",
        limit: 100,
      }),
    );
  }
  if (
    url.pathname === "/_canary/restart-worker" &&
    request.method === "POST"
  ) {
    const replicas = boundedReplicaCount(env.WORKER_REPLICAS);
    await Promise.all(
      [
        ...(replicas > 1 ? ["main"] : []),
        ...Array.from(
          { length: replicas },
          (_, index) => (replicas > 1 ? `instance-${index}` : "main"),
        ),
      ].map((name) => getContainer(env.TWENTY_WORKER, name).destroy()),
    );
    return Response.json(
      {
        restarted: true,
        target: "worker",
        replicas,
        legacyMainRetired: replicas > 1,
      },
      { status: 202 },
    );
  }
  if (
    url.pathname === "/_canary/queue-metrics" &&
    request.method === "GET"
  ) {
    const [jobs, dlq, canary] = await Promise.all([
      env.JOBS_QUEUE.metrics(),
      env.JOBS_DLQ.metrics(),
      env.CANARY_QUEUE?.metrics(),
    ]);
    const publicMetrics = (metrics: typeof jobs) => ({
      backlogCount: metrics.backlogCount,
      backlogBytes: metrics.backlogBytes,
      oldestMessageTimestamp:
        metrics.oldestMessageTimestamp?.toISOString() ?? null,
    });
    return Response.json({
      checkedAt: new Date().toISOString(),
      jobs: publicMetrics(jobs),
      dlq: publicMetrics(dlq),
      ...(canary ? { canary: publicMetrics(canary) } : {}),
    });
  }
  if (url.pathname === "/_canary/executor" && request.method === "POST") {
    const jobId = crypto.randomUUID();
    try {
      const worker = await workerContainer(env);
      const response = await worker.fetch(
        new Request("http://twenty-worker/_jobs/execute", {
          method: "POST",
          headers: {
            authorization: `Bearer ${env.INTERNAL_SERVICE_TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            schemaVersion: 1,
            id: jobId,
            queueName: "__cloudflare_canary__",
            jobName: "ping",
            data: null,
            createdAt: new Date().toISOString(),
            retryLimit: 0,
            priority: 5,
          } satisfies CloudflareTwentyJob),
          signal: AbortSignal.timeout(30_000),
        }),
      );
      return Response.json({
        jobId,
        executorStatus: response.status,
        executorBody: await response.text(),
        executorInstance:
          response.headers.get("x-cloudflare-container-instance"),
      });
    } catch (error) {
      return Response.json(
        {
          jobId,
          error: error instanceof Error ? error.message : String(error),
        },
        { status: 503 },
      );
    }
  }
  return Response.json({ error: "not found" }, { status: 404 });
}

export class StagingCanaryService extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const headers = new Headers(request.headers);
    headers.set(
      "x-canary-authorization",
      `Bearer ${this.env.CANARY_TOKEN ?? ""}`,
    );
    const response = await handleCanary(
      new Request(request, { headers }),
      this.env,
    );
    return response ?? Response.json({ error: "not found" }, { status: 404 });
  }
}

/**
 * Private service-binding entrypoint used by twenty-crm-release. It is not
 * routed over the public Worker fetch handler.
 */
export class ReleaseControlService
  extends WorkerEntrypoint<Env>
  implements ProductionReleaseControl
{
  async setMaintenance(record: ReleaseMaintenance): Promise<void> {
    const active = await getReleaseMaintenance(this.env.STATUS_KV, true);
    if (active && active.releaseId !== record.releaseId)
      throw new Error(`another release owns maintenance: ${active.releaseId}`);
    await putReleaseMaintenance(this.env.STATUS_KV, record);
  }

  async getMaintenance(): Promise<ReleaseMaintenance | null> {
    return getReleaseMaintenance(this.env.STATUS_KV, true);
  }

  async clearMaintenance(releaseId: string): Promise<boolean> {
    return clearReleaseMaintenance(this.env.STATUS_KV, releaseId);
  }

  async quiesce(
    releaseId: string,
  ): Promise<{ releaseId: string; stopped: true }> {
    const active = await getReleaseMaintenance(this.env.STATUS_KV, true);
    if (active?.releaseId !== releaseId)
      throw new Error("release does not own the maintenance gate");
    const [server, worker] = await Promise.all([
      serverContainer(this.env),
      workerContainer(this.env),
    ]);
    await Promise.all([server.quiesce(), worker.quiesce()]);
    return { releaseId, stopped: true };
  }

  async startBackup(releaseId: string): Promise<{ workflowId: string }> {
    const active = await getReleaseMaintenance(this.env.STATUS_KV, true);
    if (active?.releaseId !== releaseId)
      throw new Error("release does not own the maintenance gate");
    const workflowId = `release-backup-${releaseId}`.slice(0, 100);
    const existing = await (await this.env.BACKUP_WF.get(workflowId)).status();
    if (existing.status === "unknown")
      await this.env.BACKUP_WF.create({
        id: workflowId,
        params: { force: true },
      });
    return { workflowId };
  }

  async backupStatus(workflowId: string): Promise<{
    status: string;
    artifact?: { key: string; sha256: string };
    error?: { name?: string; message?: string };
  }> {
    const status = await (await this.env.BACKUP_WF.get(workflowId)).status();
    const output = status.output as
      | { key?: unknown; sha256?: unknown }
      | undefined;
    return {
      status: status.status,
      ...(typeof output?.key === "string" &&
      typeof output.sha256 === "string"
        ? { artifact: { key: output.key, sha256: output.sha256 } }
        : {}),
      ...(status.error === undefined ? {} : { error: status.error }),
    };
  }

  async deploymentIdentity(): Promise<{
    versionId: string | null;
    versionTag: string | null;
  }> {
    return {
      versionId: this.env.CF_VERSION_METADATA?.id ?? null,
      versionTag: this.env.CF_VERSION_METADATA?.tag ?? null,
    };
  }

  async verifyRelease(releaseId: string): Promise<{
    versionId: string | null;
    serverReady: boolean;
    workerReady: boolean;
  }> {
    const active = await getReleaseMaintenance(this.env.STATUS_KV, true);
    if (active && active.releaseId !== releaseId)
      throw new Error("another release owns the maintenance gate");
    const [server, worker] = await Promise.all([
      serverContainer(this.env),
      workerContainer(this.env),
    ]);
    const [serverResponse, workerResponse] = await Promise.all([
      server.fetch(
        new Request(
          `${this.env.SERVER_URL.replace(/\/$/, "")}/healthz`,
          { signal: AbortSignal.timeout(300_000) },
        ),
      ),
      worker.fetch(
        new Request("http://twenty-worker/_wake", {
          signal: AbortSignal.timeout(300_000),
        }),
      ),
    ]);
    return {
      versionId: this.env.CF_VERSION_METADATA?.id ?? null,
      serverReady: serverResponse.ok,
      workerReady: workerResponse.ok,
    };
  }

  async migrationRuntime(
    releaseId: string,
    target: "preflight" | "production",
  ): Promise<{
    pgDatabaseUrl?: string;
    internalServiceToken: string;
    encryptionKey: string;
    fallbackEncryptionKey?: string;
    appSecret?: string;
  }> {
    const release = await this.env.OPS_DB.prepare(
      "SELECT state FROM release_runs WHERE release_id = ?",
    )
      .bind(releaseId)
      .first<{ state: string }>();
    if (!release) throw new Error("unknown release runtime request");
    if (target === "preflight" && release.state !== "preflight")
      throw new Error("release is not in preflight");
    if (target === "production") {
      const active = await getReleaseMaintenance(this.env.STATUS_KV, true);
      if (
        active?.releaseId !== releaseId ||
        !["maintenance", "backup_verified", "migrating"].includes(
          release.state,
        )
      )
        throw new Error("production migration capability is not active");
    }
    if (!this.env.INTERNAL_SERVICE_TOKEN || !this.env.ENCRYPTION_KEY)
      throw new Error("production migration runtime is incomplete");
    if (target === "production" && !this.env.PG_DATABASE_URL)
      throw new Error("production PostgreSQL is not configured");
    return {
      ...(target === "production"
        ? { pgDatabaseUrl: this.env.PG_DATABASE_URL }
        : {}),
      internalServiceToken: this.env.INTERNAL_SERVICE_TOKEN,
      encryptionKey: this.env.ENCRYPTION_KEY,
      ...(this.env.FALLBACK_ENCRYPTION_KEY
        ? { fallbackEncryptionKey: this.env.FALLBACK_ENCRYPTION_KEY }
        : {}),
      ...(this.env.APP_SECRET ? { appSecret: this.env.APP_SECRET } : {}),
    };
  }
}

async function writeStatus(
  env: Env,
  ok: boolean,
  source: "request" | "cron" | "cron-idle",
  force = false,
): Promise<void> {
  const now = Date.now();
  if (
    !force &&
    !shouldWriteStatus(
      now,
      lastStatusWriteMs,
      ok,
      lastStatusOk,
      STATUS_WRITE_INTERVAL_MS,
    )
  )
    return;

  // Reserve this interval before the asynchronous put so concurrent requests
  // coalesce instead of all racing the same KV key.
  lastStatusWriteMs = now;
  lastStatusOk = ok;
  try {
    const checked = new Date(now).toISOString();
    await Promise.all([
      env.STATUS_KV.put(
        "status",
        JSON.stringify({
          status: ok ? "ok" : "degraded",
          mode: deploymentMode(env),
          checked,
          source,
          containerState: source === "cron-idle" ? "idle" : "active",
        }),
      ),
      source === "request"
        ? env.STATUS_KV.put("last-customer-activity", checked)
        : Promise.resolve(),
    ]);
  } catch (error) {
    console.warn("status KV write failed", error);
  }
}

async function replayCrmOutbox(env: Env): Promise<void> {
  if (!env.CRM_DB) return;
  const cutoff = new Date(Date.now() - 60_000).toISOString();
  const rows = await env.CRM_DB.prepare("SELECT event_id as eventId, action, payload_json as payloadJson FROM crm_event_outbox WHERE status IN ('pending', 'failed') AND attempts < 10 AND updated_at < ? ORDER BY updated_at LIMIT 100").bind(cutoff).all<{eventId: string; action: string; payloadJson: string}>();
  for (const row of rows.results) {
    try {
      await env.EVENTS_QUEUE.send({ type: `crm.${row.action}`, payload: row.payloadJson, receivedAt: new Date().toISOString() });
      await env.CRM_DB.prepare("UPDATE crm_event_outbox SET status = 'queued', attempts = attempts + 1, updated_at = ? WHERE event_id = ? AND status IN ('pending', 'failed')").bind(new Date().toISOString(), row.eventId).run();
    } catch (error) {
      await env.CRM_DB.prepare("UPDATE crm_event_outbox SET status = 'failed', attempts = attempts + 1, last_error = ?, updated_at = ? WHERE event_id = ?").bind(String(error).slice(0, 500), new Date().toISOString(), row.eventId).run();
    }
  }
}

async function workerHealth(env: Env): Promise<Response> {
  const worker = await workerContainer(env);
  return worker.fetch(
    new Request("http://twenty-worker/_wake"),
  );
}

function wakeWorker(env: Env, ctx: ExecutionContext): void {
  ctx.waitUntil(workerHealth(env));
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const auth = request.headers.get("authorization");
    if (env.D1_NATIVE_MODE === "true") {
      if (url.pathname === "/" || url.pathname === "/d1-dashboard") return d1Dashboard();
      if (url.pathname === "/profile" || url.pathname === "/settings") return profileDashboard();
      const crm = await handleD1Crm(request, env);
      if (crm) return crm;
      if (url.pathname !== "/_status")
        return Response.json({ error: "D1 native mode: route not implemented" }, { status: 404 });
    }
    // Never let a production deployment silently fall back to the demo image
    // (which may contain Redis) when Cloudflare coordination is selected but
    // the external PostgreSQL/service-token prerequisites are missing.
    if (
      cloudflareBackendMisconfigured(env) &&
      url.pathname !== "/_status"
    )
      return Response.json(
        { error: "cloudflare backend is not fully configured" },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    if (url.pathname === "/_auth/revoke" && request.method === "POST") {
      return revokeAccessToken(request, env);
    }
    const canary = await handleCanary(request, env);
    if (canary) return canary;
    const operations = await handleJobFailureOperations(request, env);
    if (operations) return operations;

    if (url.pathname === "/_status/g3" && request.method === "GET")
      return g3SessionCacheStatus(env);

    // Edge status from KV — monitors never wake the container.
    if (url.pathname === "/_status") {
      const [status, lastBackupAttempt, lastBackup, lastBackupError, maintenance] =
        await Promise.all([
          env.STATUS_KV.get("status"),
          env.STATUS_KV.get("last-backup-attempt"),
          env.STATUS_KV.get("last-backup"),
          env.STATUS_KV.get("last-backup-error"),
          getReleaseMaintenance(env.STATUS_KV, true),
        ]);
      const body = status ? (JSON.parse(status) as Record<string, unknown>) : { status: "unknown" };
      body.lastBackupAttempt = lastBackupAttempt;
      body.lastBackup = lastBackup;
      body.lastBackupError = lastBackupError;
      body.productionReady = externalMode(env) || nativeD1Mode(env);
      body.durableRedis = externalMode(env) || nativeD1Mode(env);
      body.redisBackend = redisBackend(env);
      body.cloudflareStateReady = Boolean(env.INTERNAL_SERVICE_TOKEN);
      body.cloudflareVersionId = env.CF_VERSION_METADATA?.id ?? null;
      body.releaseMaintenance = maintenance;
      const operational = evaluateOperationalStatus(Date.now(), {
        reportedStatus: body.status,
        checkedIso: body.checked,
        lastBackupIso: lastBackup,
        lastBackupError,
        backupRequired: true,
      });
      body.status = operational.status;
      body.reasons = operational.reasons;
      return new Response(JSON.stringify(body), {
        status: operational.status === "ok" ? 200 : 503,
        headers: { "content-type": "application/json" },
      });
    }

    // Manual backup trigger (token-guarded).
    if (url.pathname === "/_backup/run" && request.method === "POST") {
      if (!bearerAuthorized(auth, env.BACKUP_TOKEN))
        return new Response("unauthorized", { status: 401 });
      const instance = await env.BACKUP_WF.create({ params: { force: true } });
      return new Response(JSON.stringify({ workflow: instance.id }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    }

    // Container-side backup agent — token-guarded from the public edge.
    if (url.pathname.startsWith("/_agent/")) {
      if (!bearerAuthorized(auth, env.BACKUP_TOKEN))
        return new Response("unauthorized", { status: 401 });
      return getContainer(env.BACKUP_CONTAINER, "main").fetch(request);
    }

    if (authBearerToken(request) && env.INTERNAL_SERVICE_TOKEN) {
      try {
        if (await accessTokenRevoked(request, env))
          return new Response("unauthorized", { status: 401 });
      } catch (error) {
        console.error("auth revocation check failed", error);
        return new Response("authentication service unavailable", { status: 503 });
      }
    }

    const shellRequest = isEdgeShellRequest(
      request.method,
      url.pathname,
      request.headers.get("accept"),
    );
    const shellKey = externalMode(env) && shellRequest
      ? edgeShellKey(env)
      : null;
    if (shellKey) {
      const shell = await env.STATUS_KV.get(shellKey);
      if (shell) {
        const now = new Date().toISOString();
        const maintenance = await getReleaseMaintenance(env.STATUS_KV);
        if (!maintenance)
          ctx.waitUntil(
            Promise.all([
              env.STATUS_KV.put("last-customer-activity", now),
              warmExternalContainers(env),
            ]).catch((error) =>
              console.error("edge shell warm-up failed", error),
            ),
          );
        return new Response(shell, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "public, max-age=60, stale-while-revalidate=86400",
            "x-twenty-edge-shell": "hit",
          },
        });
      }
    }

    // Edge cache for immutable frontend assets.
    const cacheable = request.method === "GET" && IMMUTABLE_ASSET.test(url.pathname);
    if (cacheable) {
      const hit = await caches.default.match(request);
      if (hit) return hit;
    }

    const maintenance = await getReleaseMaintenance(env.STATUS_KV);
    if (maintenance) return maintenanceResponse(maintenance);

    // Twenty webhooks → Queue → D1.
    if (url.pathname === "/webhooks/twenty") return handleWebhook(request, env);

    wakeWorker(env, ctx);
    const server = await serverContainer(env);
    let response = await server.fetch(request);

    if (
      shellKey &&
      response.ok &&
      response.headers.get("content-type")?.includes("text/html") &&
      !response.headers.has("set-cookie")
    ) {
      ctx.waitUntil(
        response
          .clone()
          .text()
          .then((shell) =>
            env.STATUS_KV.put(shellKey, shell, {
              expirationTtl: EDGE_SHELL_TTL_SECONDS,
            }),
          )
          .catch((error) => console.error("edge shell cache failed", error)),
      );
    }
    if (
      response.ok &&
      url.pathname.startsWith("/assets/") &&
      IMMUTABLE_ASSET.test(url.pathname)
    ) {
      const headers = new Headers(response.headers);
      headers.set("cache-control", "public, max-age=31536000, immutable");
      response = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    if (cacheable && response.ok) {
      ctx.waitUntil(caches.default.put(request, response.clone()));
    }
    // Static assets can generate hundreds of requests during one page load.
    // Dynamic traffic is sufficient for health and backup-idle tracking.
    if (!cacheable)
      ctx.waitUntil(writeStatus(env, response.status < 500, "request"));
    return response;
  },

  // Traffic-aware health probe plus hourly backup. Idle beta containers are
  // not woken merely for monitoring, so provisioned memory/disk stop billing.
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(replayCrmOutbox(env).catch((error) => console.error("CRM outbox replay failed", error)));
    if (await getReleaseMaintenance(env.STATUS_KV)) {
      ctx.waitUntil(
        runOperationsAlertCheck(env).catch((error) =>
          console.error("operations alert check failed", error),
        ),
      );
      return;
    }
    if (event.cron === BACKUP_CRON) {
      await env.BACKUP_WF.create({ params: {} });
      return;
    }
    await runG3SessionCacheSample(env);

    const lastCustomerActivity =
      await env.STATUS_KV.get("last-customer-activity");
    if (
      !hasRecentCustomerActivity(
        Date.now(),
        lastCustomerActivity,
        CUSTOMER_ACTIVE_WINDOW_MS,
      )
    ) {
      const previous = await env.STATUS_KV.get<{ status?: string }>(
        "status",
        "json",
      );
      await writeStatus(env, previous?.status === "ok", "cron-idle", true);
      ctx.waitUntil(
        runOperationsAlertCheck(env).catch((error) =>
          console.error("operations alert check failed", error),
        ),
      );
      return;
    }

    const workerOk = (await workerHealth(env)).ok;
    const target = await serverContainer(env);
    const res = await target.fetch(
      new Request(`${env.SERVER_URL.replace(/\/$/, "")}/healthz`),
    );
    await writeStatus(env, res.ok && workerOk, "cron", true);
    ctx.waitUntil(
      runOperationsAlertCheck(env).catch((error) =>
        console.error("operations alert check failed", error),
      ),
    );
  },

  async queue(
    batch: MessageBatch<unknown>,
    env: Env,
  ): Promise<void> {
    if (await getReleaseMaintenance(env.STATUS_KV)) {
      batch.retryAll();
      return;
    }
    if (batch.queue === (env.JOB_DLQ_NAME ?? "twenty-jobs-dlq")) {
      await consumeJobFailureBatch(batch, env);
      return;
    }
    if (
      batch.queue === (env.JOB_QUEUE_NAME ?? "twenty-jobs") ||
      (env.CANARY_QUEUE_NAME !== undefined &&
        batch.queue === env.CANARY_QUEUE_NAME)
    ) {
      await consumeJobBatch(
        batch as MessageBatch<CloudflareTwentyJob>,
        env,
      );
      return;
    }
    await consumeBatch(batch as MessageBatch<WebhookMessage>, env);
  },
} satisfies ExportedHandler<Env, unknown>;
