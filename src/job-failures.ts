import { bearerAuthorized, sanitizedErrorMessage } from "./lib";
import { validJob } from "./job-envelope";
import {
  accessIdentityForRequest,
  type AccessIdentity,
} from "./access";
import type {
  CloudflareJobFailure,
  CloudflareTwentyJob,
  Env,
} from "./types";

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;
const MAX_ACTION_BODY_BYTES = 4_096;
const MAX_BULK_REPLAY_BODY_BYTES = 24 * 1024;
const MAX_BULK_REPLAY_ITEMS = 10;
const FAILURE_STATUSES = new Set([
  "quarantined",
  "replay_pending",
  "replayed",
  "dismissed",
]);

type FailureStatus =
  | "quarantined"
  | "replay_pending"
  | "replayed"
  | "dismissed";

interface FailureRow {
  id: string;
  source: "application" | "platform";
  status: FailureStatus;
  reason: string;
  job_id: string | null;
  queue_name: string | null;
  job_name: string | null;
  job_json: string;
  failed_at: string;
  first_seen_at: string;
  last_seen_at: string;
  delivery_count: number;
  version: number;
  replay_count: number;
  replay_job_id: string | null;
  replay_requested_at: string | null;
  resolved_at: string | null;
}

interface NormalizedFailure {
  id: string;
  source: "application" | "platform";
  reason: string;
  job: unknown;
  jobId: string | null;
  queueName: string | null;
  jobName: string | null;
  failedAt: string;
}

interface ActionInput {
  expectedVersion: number;
  note: string;
  confirmUncertainOutcome?: boolean;
}

interface ReplayContext {
  bulkRequestId?: string;
}

interface BulkReplayItem {
  id: string;
  expectedVersion: number;
  confirmUncertainOutcome: boolean;
}

interface BulkReplayInput {
  requestId: string;
  note: string;
  items: BulkReplayItem[];
}

function json(
  body: unknown,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "no-store");
  headers.set("content-type", "application/json");
  headers.set("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function isFailureEnvelope(value: unknown): value is CloudflareJobFailure {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const failure = value as Partial<CloudflareJobFailure>;
  return (
    failure.schemaVersion === 1 &&
    typeof failure.failureId === "string" &&
    failure.failureId.length > 0 &&
    failure.failureId.length <= 128 &&
    typeof failure.reason === "string" &&
    typeof failure.failedAt === "string" &&
    failure.source === "application" &&
    "job" in failure
  );
}

function safeStringify(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? "null" : serialized;
  } catch {
    return JSON.stringify({ serializationError: true });
  }
}

export function normalizeJobFailure(
  value: unknown,
  messageId: string,
  timestamp: Date,
): NormalizedFailure {
  const envelope = isFailureEnvelope(value) ? value : null;
  const job = envelope ? envelope.job : value;
  const typedJob = validJob(job) ? job : null;
  return {
    id: envelope?.failureId ?? `platform:${messageId}`,
    source: envelope ? "application" : "platform",
    reason: envelope?.reason ?? "platform-retry-exhausted",
    job,
    jobId: typedJob?.id ?? null,
    queueName: typedJob?.queueName ?? null,
    jobName: typedJob?.jobName ?? null,
    failedAt: envelope?.failedAt ?? timestamp.toISOString(),
  };
}

export async function consumeJobFailureBatch(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      const failure = normalizeJobFailure(
        message.body,
        message.id,
        message.timestamp,
      );
      const now = new Date().toISOString();
      await env.OPS_DB.batch([
        env.OPS_DB.prepare(
          `INSERT INTO job_failures (
             id, source, status, reason, job_id, queue_name, job_name,
             job_json, failed_at, first_seen_at, last_seen_at
           ) VALUES (?, ?, 'quarantined', ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             last_seen_at = excluded.last_seen_at,
             delivery_count = job_failures.delivery_count + 1`,
        ).bind(
          failure.id,
          failure.source,
          failure.reason,
          failure.jobId,
          failure.queueName,
          failure.jobName,
          safeStringify(failure.job),
          failure.failedAt,
          now,
          now,
        ),
        env.OPS_DB.prepare(
          `INSERT OR IGNORE INTO job_failure_audit (
             failure_id, event_key, action, actor, from_status, to_status,
             note, metadata_json, created_at
           ) VALUES (?, ?, 'ingested', 'system:queue-dlq', NULL,
             'quarantined', NULL, ?, ?)`,
        ).bind(
          failure.id,
          `ingested:${failure.id}`,
          safeStringify({
            source: failure.source,
            queue: batch.queue,
            reason: failure.reason,
          }),
          now,
        ),
      ]);
      message.ack();
    } catch (error) {
      console.error(
        "job failure ledger ingest failed",
        sanitizedErrorMessage(error),
      );
      message.retry({ delaySeconds: Math.min(300, 2 ** message.attempts) });
    }
  }
}

function encodeCursor(row: Pick<FailureRow, "first_seen_at" | "id">): string {
  return btoa(JSON.stringify([row.first_seen_at, row.id]));
}

function decodeCursor(value: string | null): [string, string] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(atob(value)) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string"
    )
      return [parsed[0], parsed[1]];
  } catch {
    // Invalid cursors are rejected below.
  }
  return null;
}

function publicFailure(row: FailureRow, includeJob = false) {
  const result: Record<string, unknown> = {
    id: row.id,
    source: row.source,
    status: row.status,
    reason: row.reason,
    jobId: row.job_id,
    queueName: row.queue_name,
    jobName: row.job_name,
    failedAt: row.failed_at,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    deliveryCount: row.delivery_count,
    version: row.version,
    replayCount: row.replay_count,
    replayJobId: row.replay_job_id,
    replayRequestedAt: row.replay_requested_at,
    resolvedAt: row.resolved_at,
  };
  if (includeJob) {
    try {
      result.job = JSON.parse(row.job_json);
    } catch {
      result.job = null;
    }
  }
  return result;
}

async function listFailures(url: URL, env: Env): Promise<Response> {
  const requestedStatus = url.searchParams.get("status");
  if (requestedStatus && !FAILURE_STATUSES.has(requestedStatus))
    return json({ error: "invalid status" }, { status: 400 });
  const rawLimit = Number(url.searchParams.get("limit") ?? DEFAULT_PAGE_SIZE);
  if (!Number.isSafeInteger(rawLimit) || rawLimit < 1)
    return json({ error: "invalid limit" }, { status: 400 });
  const limit = Math.min(rawLimit, MAX_PAGE_SIZE);
  const rawCursor = url.searchParams.get("cursor");
  const cursor = decodeCursor(rawCursor);
  if (rawCursor && !cursor)
    return json({ error: "invalid cursor" }, { status: 400 });

  const conditions: string[] = [];
  const bindings: unknown[] = [];
  if (requestedStatus) {
    conditions.push("status = ?");
    bindings.push(requestedStatus);
  }
  if (cursor) {
    conditions.push("(first_seen_at < ? OR (first_seen_at = ? AND id < ?))");
    bindings.push(cursor[0], cursor[0], cursor[1]);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await env.OPS_DB.prepare(
    `SELECT * FROM job_failures ${where}
     ORDER BY first_seen_at DESC, id DESC LIMIT ?`,
  )
    .bind(...bindings, limit)
    .all<FailureRow>();
  const rows = result.results ?? [];
  return json({
    failures: rows.map((row) => publicFailure(row)),
    nextCursor:
      rows.length === limit ? encodeCursor(rows[rows.length - 1]) : null,
  });
}

async function getFailure(id: string, env: Env): Promise<Response> {
  const row = await env.OPS_DB.prepare(
    "SELECT * FROM job_failures WHERE id = ?",
  )
    .bind(id)
    .first<FailureRow>();
  if (!row) return json({ error: "not found" }, { status: 404 });
  const audits = await env.OPS_DB.prepare(
    `SELECT action, actor, from_status, to_status, note, metadata_json,
       created_at
     FROM job_failure_audit WHERE failure_id = ?
     ORDER BY created_at DESC, id DESC LIMIT 100`,
  )
    .bind(id)
    .all<Record<string, unknown>>();
  return json({
    failure: publicFailure(row, true),
    audit: audits.results ?? [],
  });
}

function publicQueueMetrics(metrics: QueueMetrics) {
  return {
    backlogCount: metrics.backlogCount,
    backlogBytes: metrics.backlogBytes,
    oldestMessageTimestamp:
      metrics.oldestMessageTimestamp?.toISOString() ?? null,
  };
}

async function failureSummary(env: Env): Promise<Response> {
  const [counts, oldest, jobs, dlq, canary] = await Promise.all([
    env.OPS_DB.prepare(
      `SELECT status, COUNT(*) AS count
       FROM job_failures GROUP BY status ORDER BY status`,
    ).all<{ status: FailureStatus; count: number }>(),
    env.OPS_DB.prepare(
      `SELECT MIN(first_seen_at) AS oldest
       FROM job_failures WHERE status IN ('quarantined', 'replay_pending')`,
    ).first<{ oldest: string | null }>(),
    env.JOBS_QUEUE.metrics(),
    env.JOBS_DLQ.metrics(),
    env.CANARY_QUEUE?.metrics(),
  ]);
  return json({
    checkedAt: new Date().toISOString(),
    failures: {
      counts: Object.fromEntries(
        (counts.results ?? []).map(({ status, count }) => [status, count]),
      ),
      oldestActionableAt: oldest?.oldest ?? null,
    },
    queues: {
      jobs: publicQueueMetrics(jobs),
      dlq: publicQueueMetrics(dlq),
      ...(canary ? { canary: publicQueueMetrics(canary) } : {}),
    },
  });
}

async function readAction(
  request: Request,
  identity: AccessIdentity,
): Promise<{ input: ActionInput; actor: string } | Response> {
  const actor = actionActor(request, identity);
  if (!actor)
    return json({ error: "valid operator identity required" }, { status: 400 });
  const text = await request.text();
  if (text.length === 0 || text.length > MAX_ACTION_BODY_BYTES)
    return json({ error: "invalid action body size" }, { status: 400 });
  let value: Partial<ActionInput>;
  try {
    value = JSON.parse(text) as Partial<ActionInput>;
  } catch {
    return json({ error: "invalid JSON" }, { status: 400 });
  }
  if (
    !Number.isSafeInteger(value.expectedVersion) ||
    (value.expectedVersion ?? 0) < 1 ||
    typeof value.note !== "string" ||
    value.note.trim().length < 3 ||
    value.note.length > 500
  )
    return json({ error: "expectedVersion and operator note required" }, {
      status: 400,
    });
  return {
    actor,
    input: {
      expectedVersion: value.expectedVersion as number,
      note: value.note.trim(),
      confirmUncertainOutcome: value.confirmUncertainOutcome === true,
    },
  };
}

function actionActor(
  request: Request,
  identity: AccessIdentity,
): string | null {
  const actor =
    identity.actor === "legacy-ops-token"
      ? request.headers.get("x-ops-actor")
      : identity.actor;
  return actor && /^[A-Za-z0-9@._+:-]{1,128}$/.test(actor)
    ? actor
    : null;
}

async function readBulkReplay(
  request: Request,
  identity: AccessIdentity,
): Promise<{ actor: string; input: BulkReplayInput } | Response> {
  const actor = actionActor(request, identity);
  if (!actor)
    return json({ error: "valid operator identity required" }, { status: 400 });
  const text = await request.text();
  if (text.length === 0 || text.length > MAX_BULK_REPLAY_BODY_BYTES)
    return json({ error: "invalid bulk replay body size" }, { status: 400 });
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid JSON" }, { status: 400 });
  }
  if (
    typeof value.requestId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value.requestId) ||
    typeof value.note !== "string" ||
    value.note.trim().length < 3 ||
    value.note.length > 500 ||
    value.confirmBulkReplay !== true ||
    !Array.isArray(value.items) ||
    value.items.length < 1 ||
    value.items.length > MAX_BULK_REPLAY_ITEMS
  )
    return json(
      {
        error:
          "requestId, operator note, confirmBulkReplay, and 1-10 items required",
      },
      { status: 400 },
    );
  const items: BulkReplayItem[] = [];
  const ids = new Set<string>();
  for (const item of value.items) {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      typeof item.id !== "string" ||
      item.id.length < 1 ||
      item.id.length > 128 ||
      !Number.isSafeInteger(item.expectedVersion) ||
      item.expectedVersion < 1 ||
      ids.has(item.id)
    )
      return json(
        { error: "bulk items require unique id and expectedVersion" },
        { status: 400 },
      );
    ids.add(item.id);
    items.push({
      id: item.id,
      expectedVersion: item.expectedVersion,
      confirmUncertainOutcome: item.confirmUncertainOutcome === true,
    });
  }
  return {
    actor,
    input: {
      requestId: value.requestId,
      note: value.note.trim(),
      items,
    },
  };
}

async function dismissFailure(
  request: Request,
  env: Env,
  id: string,
  identity: AccessIdentity,
): Promise<Response> {
  const action = await readAction(request, identity);
  if (action instanceof Response) return action;
  const now = new Date().toISOString();
  const nextVersion = action.input.expectedVersion + 1;
  const results = await env.OPS_DB.batch([
    env.OPS_DB.prepare(
      `UPDATE job_failures SET status = 'dismissed', version = version + 1,
         resolved_at = ?, last_seen_at = ?
       WHERE id = ? AND status = 'quarantined' AND version = ?`,
    ).bind(now, now, id, action.input.expectedVersion),
    env.OPS_DB.prepare(
      `INSERT OR IGNORE INTO job_failure_audit (
         failure_id, event_key, action, actor, from_status, to_status,
         note, metadata_json, created_at
       ) SELECT id, ?, 'dismissed', ?, 'quarantined', 'dismissed', ?,
         NULL, ? FROM job_failures
       WHERE id = ? AND status = 'dismissed' AND version = ?`,
    ).bind(
      `dismissed:${id}:${nextVersion}`,
      action.actor,
      action.input.note,
      now,
      id,
      nextVersion,
    ),
  ]);
  if ((results[0].meta.changes ?? 0) !== 1)
    return json({ error: "failure state or version conflict" }, { status: 409 });
  return json({ id, status: "dismissed", version: nextVersion });
}

async function releaseReplayDedupe(
  env: Env,
  job: CloudflareTwentyJob,
): Promise<void> {
  if (!job.dedupeKey) return;
  const state = env.STATE_DO.get(
    env.STATE_DO.idFromName("workspace:default"),
  );
  await state.releaseLock({
    namespace: "job-dedupe",
    key: job.dedupeKey,
    owner: job.id,
  });
}

async function compensateReplay(
  env: Env,
  row: FailureRow,
  replayJobId: string,
  actor: string,
  note: string,
  error: unknown,
  context: ReplayContext = {},
): Promise<void> {
  const now = new Date().toISOString();
  await env.OPS_DB.batch([
    env.OPS_DB.prepare(
      `UPDATE job_failures SET status = 'quarantined',
         replay_job_id = NULL, replay_requested_at = NULL,
         version = version + 1, last_seen_at = ?
       WHERE id = ? AND status = 'replay_pending' AND replay_job_id = ?`,
    ).bind(now, row.id, replayJobId),
    env.OPS_DB.prepare(
      `INSERT OR IGNORE INTO job_failure_audit (
         failure_id, event_key, action, actor, from_status, to_status,
         note, metadata_json, created_at
       ) SELECT id, ?, 'replay_failed', ?, 'replay_pending',
         'quarantined', ?, ?, ? FROM job_failures
       WHERE id = ? AND status = 'quarantined'
         AND replay_job_id IS NULL`,
    ).bind(
      `replay-failed:${row.id}:${replayJobId}`,
      actor,
      note,
      safeStringify({
        error: sanitizedErrorMessage(error),
        ...context,
      }),
      now,
      row.id,
    ),
  ]);
}

async function replayFailure(
  request: Request,
  env: Env,
  id: string,
  identity: AccessIdentity,
  context: ReplayContext = {},
): Promise<Response> {
  const action = await readAction(request, identity);
  if (action instanceof Response) return action;
  const row = await env.OPS_DB.prepare(
    "SELECT * FROM job_failures WHERE id = ?",
  )
    .bind(id)
    .first<FailureRow>();
  if (!row) return json({ error: "not found" }, { status: 404 });
  if (row.version !== action.input.expectedVersion)
    return json({ error: "failure version conflict" }, { status: 409 });
  if (row.status !== "quarantined" && row.status !== "replay_pending")
    return json({ error: "failure is not replayable" }, { status: 409 });
  if (
    row.reason === "executor-outcome-ambiguous" &&
    !action.input.confirmUncertainOutcome
  )
    return json(
      { error: "explicit uncertain-outcome confirmation required" },
      { status: 409 },
    );

  let originalJob: unknown;
  try {
    originalJob = JSON.parse(row.job_json);
  } catch {
    return json({ error: "stored job payload is invalid" }, { status: 409 });
  }
  if (!validJob(originalJob))
    return json({ error: "stored envelope is not replayable" }, { status: 409 });

  const now = new Date().toISOString();
  let replayJobId = row.replay_job_id;
  let pendingVersion = row.version;
  if (row.status === "quarantined") {
    replayJobId = crypto.randomUUID();
    pendingVersion = row.version + 1;
    const claim = await env.OPS_DB.batch([
      env.OPS_DB.prepare(
        `UPDATE job_failures SET status = 'replay_pending',
           replay_job_id = ?, replay_requested_at = ?,
           version = version + 1, last_seen_at = ?
         WHERE id = ? AND status = 'quarantined' AND version = ?`,
      ).bind(replayJobId, now, now, id, row.version),
      env.OPS_DB.prepare(
        `INSERT OR IGNORE INTO job_failure_audit (
           failure_id, event_key, action, actor, from_status, to_status,
           note, metadata_json, created_at
         ) SELECT id, ?, 'replay_requested', ?, 'quarantined',
           'replay_pending', ?, ?, ? FROM job_failures
         WHERE id = ? AND status = 'replay_pending' AND version = ?`,
      ).bind(
        `replay-requested:${id}:${replayJobId}`,
        action.actor,
        action.input.note,
        safeStringify({ replayJobId, ...context }),
        now,
        id,
        pendingVersion,
      ),
    ]);
    if ((claim[0].meta.changes ?? 0) !== 1)
      return json({ error: "failure state or version conflict" }, {
        status: 409,
      });
  }
  if (!replayJobId)
    return json({ error: "pending replay is missing its job id" }, {
      status: 409,
    });

  const replayJob: CloudflareTwentyJob = {
    ...originalJob,
    id: replayJobId,
    createdAt: now,
    notBefore: undefined,
    dedupeClaimed: false,
    replayOfFailureId: id,
  };

  try {
    await releaseReplayDedupe(env, originalJob);
    const queue =
      originalJob.queueName === "__cloudflare_canary__" && env.CANARY_QUEUE
        ? env.CANARY_QUEUE
        : env.JOBS_QUEUE;
    await queue.send(replayJob);
  } catch (error) {
    await compensateReplay(
      env,
      row,
      replayJobId,
      action.actor,
      action.input.note,
      error,
      context,
    );
    return json(
      { error: "replay enqueue failed; failure returned to quarantine" },
      { status: 503 },
    );
  }

  const completedAt = new Date().toISOString();
  try {
    const finalized = await env.OPS_DB.batch([
      env.OPS_DB.prepare(
        `UPDATE job_failures SET status = 'replayed',
           replay_count = replay_count + 1, version = version + 1,
           resolved_at = ?, last_seen_at = ?
         WHERE id = ? AND status = 'replay_pending'
           AND replay_job_id = ? AND version = ?`,
      ).bind(completedAt, completedAt, id, replayJobId, pendingVersion),
      env.OPS_DB.prepare(
        `INSERT OR IGNORE INTO job_failure_audit (
           failure_id, event_key, action, actor, from_status, to_status,
           note, metadata_json, created_at
         ) SELECT id, ?, 'replay_enqueued', ?, 'replay_pending',
           'replayed', ?, ?, ? FROM job_failures
         WHERE id = ? AND status = 'replayed' AND replay_job_id = ?`,
      ).bind(
        `replay-enqueued:${id}:${replayJobId}`,
        action.actor,
        action.input.note,
        safeStringify({ replayJobId, ...context }),
        completedAt,
        id,
        replayJobId,
      ),
    ]);
    if ((finalized[0].meta.changes ?? 0) !== 1)
      return json(
        {
          id,
          status: "replay_pending",
          replayJobId,
          warning: "job enqueued; ledger finalization requires retry",
        },
        { status: 202 },
      );
  } catch (error) {
    console.error(
      "replay enqueued but ledger finalization failed",
      sanitizedErrorMessage(error),
    );
    return json(
      {
        id,
        status: "replay_pending",
        replayJobId,
        warning: "job enqueued; ledger finalization requires retry",
      },
      { status: 202 },
    );
  }
  return json({
    id,
    status: "replayed",
    version: pendingVersion + 1,
    replayJobId,
  }, { status: 202 });
}

async function bulkReplayFailures(
  request: Request,
  env: Env,
  identity: AccessIdentity,
): Promise<Response> {
  const action = await readBulkReplay(request, identity);
  if (action instanceof Response) return action;

  const preflightErrors: Array<{ id: string; error: string }> = [];
  for (const item of action.input.items) {
    const row = await env.OPS_DB.prepare(
      "SELECT * FROM job_failures WHERE id = ?",
    )
      .bind(item.id)
      .first<FailureRow>();
    if (!row) {
      preflightErrors.push({ id: item.id, error: "not found" });
      continue;
    }
    if (row.status !== "quarantined") {
      preflightErrors.push({ id: item.id, error: "not quarantined" });
      continue;
    }
    if (row.version !== item.expectedVersion) {
      preflightErrors.push({ id: item.id, error: "version conflict" });
      continue;
    }
    if (
      row.reason === "executor-outcome-ambiguous" &&
      !item.confirmUncertainOutcome
    ) {
      preflightErrors.push({
        id: item.id,
        error: "uncertain-outcome confirmation required",
      });
      continue;
    }
    try {
      if (!validJob(JSON.parse(row.job_json)))
        preflightErrors.push({ id: item.id, error: "invalid job envelope" });
    } catch {
      preflightErrors.push({ id: item.id, error: "invalid job payload" });
    }
  }
  if (preflightErrors.length > 0)
    return json(
      {
        requestId: action.input.requestId,
        error: "bulk replay preflight failed; no jobs were enqueued",
        failures: preflightErrors,
      },
      { status: 409 },
    );

  const results: Array<Record<string, unknown>> = [];
  for (const item of action.input.items) {
    const replayRequest = new Request(request.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ops-actor": action.actor,
      },
      body: JSON.stringify({
        expectedVersion: item.expectedVersion,
        note: action.input.note,
        confirmUncertainOutcome: item.confirmUncertainOutcome,
      }),
    });
    const response = await replayFailure(
      replayRequest,
      env,
      item.id,
      identity,
      { bulkRequestId: action.input.requestId },
    );
    const body = (await response.json()) as Record<string, unknown>;
    results.push({ id: item.id, httpStatus: response.status, ...body });
    if (response.status >= 400) break;
  }

  const completed = results.filter(
    (result) =>
      result.httpStatus === 202 &&
      (result.status === "replayed" || result.status === "replay_pending"),
  ).length;
  const allCompleted =
    results.length === action.input.items.length &&
    completed === action.input.items.length;
  return json(
    {
      requestId: action.input.requestId,
      requested: action.input.items.length,
      attempted: results.length,
      completed,
      stoppedEarly: results.length < action.input.items.length,
      results,
    },
    { status: allCompleted ? 202 : 207 },
  );
}

export async function handleJobFailureOperations(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/_ops/job-failures")) return null;
  const identity = await accessIdentityForRequest(request, env);
  if (!identity)
    return json({ error: "Cloudflare Access identity required" }, {
      status: 403,
    });
  if (
    !bearerAuthorized(
      request.headers.get("authorization"),
      env.OPS_TOKEN,
    )
  )
    return json({ error: "unauthorized" }, { status: 401 });
  if (
    env.OPS_RATE_LIMITER &&
    !(await env.OPS_RATE_LIMITER.limit({ key: identity.subject })).success
  )
    return json(
      { error: "rate limit exceeded" },
      { status: 429, headers: { "retry-after": "60" } },
    );

  if (url.pathname === "/_ops/job-failures") {
    if (request.method !== "GET")
      return json({ error: "method not allowed" }, { status: 405 });
    return listFailures(url, env);
  }
  if (url.pathname === "/_ops/job-failures/summary") {
    if (request.method !== "GET")
      return json({ error: "method not allowed" }, { status: 405 });
    return failureSummary(env);
  }
  if (url.pathname === "/_ops/job-failures/bulk-replay") {
    if (request.method !== "POST")
      return json({ error: "method not allowed" }, { status: 405 });
    return bulkReplayFailures(request, env, identity);
  }

  const match = url.pathname.match(
    /^\/_ops\/job-failures\/([^/]+)(?:\/(replay|dismiss))?$/,
  );
  if (!match) return json({ error: "not found" }, { status: 404 });
  let id: string;
  try {
    id = decodeURIComponent(match[1]);
  } catch {
    return json({ error: "invalid failure id" }, { status: 400 });
  }
  if (!id || id.length > 128)
    return json({ error: "invalid failure id" }, { status: 400 });
  if (!match[2]) {
    if (request.method !== "GET")
      return json({ error: "method not allowed" }, { status: 405 });
    return getFailure(id, env);
  }
  if (request.method !== "POST")
    return json({ error: "method not allowed" }, { status: 405 });
  return match[2] === "replay"
    ? replayFailure(request, env, id, identity)
    : dismissFailure(request, env, id, identity);
}
