import { describe, expect, it, vi } from "vitest";
import {
  consumeJobFailureBatch,
  handleJobFailureOperations,
  normalizeJobFailure,
} from "../src/job-failures";
import type { CloudflareTwentyJob, Env } from "../src/types";
import { deterministicFailureId } from "../src/job-envelope";

function job(overrides: Partial<CloudflareTwentyJob> = {}): CloudflareTwentyJob {
  return {
    schemaVersion: 1,
    id: "original-job",
    queueName: "defaultQueue",
    jobName: "ExampleJob",
    data: { workspaceId: "workspace" },
    createdAt: "2026-07-24T00:00:00.000Z",
    retryLimit: 3,
    priority: 5,
    ...overrides,
  };
}

interface FakeDatabaseOptions {
  first?: unknown[];
  all?: Array<{ results: unknown[] }>;
  batch?: Array<Array<{ meta: { changes: number } }>>;
}

function fakeDatabase(options: FakeDatabaseOptions = {}) {
  const first = [...(options.first ?? [])];
  const all = [...(options.all ?? [])];
  const batches = [...(options.batch ?? [])];
  const prepared: Array<{ sql: string; bindings: unknown[] }> = [];
  const batch = vi.fn().mockImplementation(async () => {
    return batches.shift() ?? [{ meta: { changes: 1 } }, { meta: { changes: 1 } }];
  });
  const prepare = vi.fn().mockImplementation((sql: string) => {
    const statement = {
      bind: (...bindings: unknown[]) => {
        prepared.push({ sql, bindings });
        return statement;
      },
      first: vi.fn().mockImplementation(async () => first.shift() ?? null),
      all: vi
        .fn()
        .mockImplementation(async () => all.shift() ?? { results: [] }),
      run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
    };
    if (!sql.includes("?")) {
      prepared.push({ sql, bindings: [] });
    }
    return statement;
  });
  return {
    db: { prepare, batch } as unknown as D1Database,
    batch,
    prepared,
  };
}

function failureRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "failure-1",
    source: "application",
    status: "quarantined",
    reason: "permanent-executor-response",
    job_id: "original-job",
    queue_name: "defaultQueue",
    job_name: "ExampleJob",
    job_json: JSON.stringify(job()),
    failed_at: "2026-07-24T00:01:00.000Z",
    first_seen_at: "2026-07-24T00:01:01.000Z",
    last_seen_at: "2026-07-24T00:01:01.000Z",
    delivery_count: 1,
    version: 1,
    replay_count: 0,
    replay_job_id: null,
    replay_requested_at: null,
    resolved_at: null,
    ...overrides,
  };
}

function operationsRequest(
  path: string,
  options: {
    method?: string;
    token?: string;
    body?: unknown;
    actor?: string;
  } = {},
) {
  const headers = new Headers({
    authorization: `Bearer ${options.token ?? "ops-secret"}`,
  });
  if (options.actor) headers.set("x-ops-actor", options.actor);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  return new Request(`https://example.com${path}`, {
    method: options.method ?? "GET",
    headers,
    body:
      options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

describe("job failure ledger", () => {
  it("uses stable bounded identifiers for repeated terminal delivery", async () => {
    const first = await deterministicFailureId(
      "original-job\0retry-limit-exceeded",
    );
    const second = await deterministicFailureId(
      "original-job\0retry-limit-exceeded",
    );
    expect(first).toBe(second);
    expect(first).toMatch(/^failure:[a-f0-9]{64}$/);
    expect(first.length).toBeLessThanOrEqual(128);
  });

  it("normalizes application and platform DLQ messages", () => {
    const timestamp = new Date("2026-07-24T00:01:00.000Z");
    expect(
      normalizeJobFailure(
        {
          schemaVersion: 1,
          failureId: "failure-app",
          job: job(),
          reason: "retry-limit-exceeded",
          failedAt: "2026-07-24T00:00:00.000Z",
          source: "application",
        },
        "message-1",
        timestamp,
      ),
    ).toMatchObject({
      id: "failure-app",
      source: "application",
      jobId: "original-job",
      reason: "retry-limit-exceeded",
    });
    expect(normalizeJobFailure(job(), "message-2", timestamp)).toMatchObject({
      id: "platform:message-2",
      source: "platform",
      jobId: "original-job",
      reason: "platform-retry-exhausted",
    });
  });

  it("atomically ingests and audits before acknowledging", async () => {
    const database = fakeDatabase();
    const queueMessage = {
      id: "message-1",
      timestamp: new Date(),
      body: job(),
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };
    await consumeJobFailureBatch(
      {
        queue: "twenty-jobs-dlq",
        messages: [queueMessage],
      } as unknown as MessageBatch<unknown>,
      { OPS_DB: database.db } as unknown as Env,
    );

    expect(database.batch).toHaveBeenCalledOnce();
    expect(queueMessage.ack).toHaveBeenCalledOnce();
    expect(queueMessage.retry).not.toHaveBeenCalled();
    expect(database.prepared[0].sql).toContain("ON CONFLICT(id)");
    expect(database.prepared[1].sql).toContain("INSERT OR IGNORE");
  });

  it("retries rather than acknowledging when D1 ingestion fails", async () => {
    const database = fakeDatabase();
    database.batch.mockRejectedValueOnce(new Error("D1 unavailable"));
    const queueMessage = {
      id: "message-1",
      timestamp: new Date(),
      body: job(),
      attempts: 2,
      ack: vi.fn(),
      retry: vi.fn(),
    };
    await consumeJobFailureBatch(
      {
        queue: "twenty-jobs-dlq",
        messages: [queueMessage],
      } as unknown as MessageBatch<unknown>,
      { OPS_DB: database.db } as unknown as Env,
    );

    expect(queueMessage.ack).not.toHaveBeenCalled();
    expect(queueMessage.retry).toHaveBeenCalledWith({ delaySeconds: 4 });
  });
});

describe("job failure operations API", () => {
  it("fails closed when the operations token is missing or wrong", async () => {
    const response = await handleJobFailureOperations(
      operationsRequest("/_ops/job-failures", { token: "wrong" }),
      { OPS_TOKEN: "ops-secret" } as Env,
    );
    expect(response?.status).toBe(401);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(response?.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response?.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("fails closed before bearer auth when Access is required", async () => {
    const response = await handleJobFailureOperations(
      operationsRequest("/_ops/job-failures"),
      {
        ACCESS_REQUIRED: "true",
        ACCESS_AUD: "audience",
        ACCESS_TEAM_DOMAIN: "https://example.cloudflareaccess.com",
        OPS_TOKEN: "ops-secret",
      } as Env,
    );
    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toEqual({
      error: "Cloudflare Access identity required",
    });
  });

  it("rate limits an authenticated operations identity", async () => {
    const response = await handleJobFailureOperations(
      operationsRequest("/_ops/job-failures"),
      {
        OPS_TOKEN: "ops-secret",
        OPS_RATE_LIMITER: {
          limit: vi.fn().mockResolvedValue({ success: false }),
        },
      } as unknown as Env,
    );
    expect(response?.status).toBe(429);
    expect(response?.headers.get("retry-after")).toBe("60");
  });

  it("lists bounded metadata without exposing job payloads", async () => {
    const database = fakeDatabase({
      all: [{ results: [failureRow()] }],
    });
    const response = await handleJobFailureOperations(
      operationsRequest("/_ops/job-failures?status=quarantined&limit=25"),
      { OPS_TOKEN: "ops-secret", OPS_DB: database.db } as Env,
    );
    const body = (await response?.json()) as {
      failures: Array<Record<string, unknown>>;
    };
    expect(response?.status).toBe(200);
    expect(body.failures[0]).toMatchObject({
      id: "failure-1",
      status: "quarantined",
      version: 1,
    });
    expect(body.failures[0]).not.toHaveProperty("job");
  });

  it("reports live Queue backlog and actionable ledger counts", async () => {
    const database = fakeDatabase({
      all: [
        {
          results: [
            { status: "quarantined", count: 4 },
            { status: "replayed", count: 2 },
          ],
        },
      ],
      first: [{ oldest: "2026-07-24T00:01:01.000Z" }],
    });
    const response = await handleJobFailureOperations(
      operationsRequest("/_ops/job-failures/summary"),
      {
        OPS_TOKEN: "ops-secret",
        OPS_DB: database.db,
        JOBS_QUEUE: {
          metrics: vi.fn().mockResolvedValue({
            backlogCount: 3,
            backlogBytes: 500,
            oldestMessageTimestamp: new Date("2026-07-24T00:00:00.000Z"),
          }),
        },
        JOBS_DLQ: {
          metrics: vi.fn().mockResolvedValue({
            backlogCount: 0,
            backlogBytes: 0,
          }),
        },
      } as unknown as Env,
    );
    const body = (await response?.json()) as {
      failures: { counts: Record<string, number> };
      queues: { jobs: { backlogCount: number }; dlq: { backlogCount: number } };
    };
    expect(response?.status).toBe(200);
    expect(body.failures.counts.quarantined).toBe(4);
    expect(body.queues.jobs.backlogCount).toBe(3);
    expect(body.queues.dlq.backlogCount).toBe(0);
  });

  it("requires explicit confirmation before replaying an ambiguous outcome", async () => {
    const database = fakeDatabase({
      first: [failureRow({ reason: "executor-outcome-ambiguous" })],
    });
    const response = await handleJobFailureOperations(
      operationsRequest("/_ops/job-failures/failure-1/replay", {
        method: "POST",
        actor: "oncall@example.com",
        body: { expectedVersion: 1, note: "reconciled in PostgreSQL" },
      }),
      { OPS_TOKEN: "ops-secret", OPS_DB: database.db } as Env,
    );
    expect(response?.status).toBe(409);
    expect(database.batch).not.toHaveBeenCalled();
  });

  it("claims, enqueues, and audits an operator-approved replay", async () => {
    const database = fakeDatabase({
      first: [failureRow()],
      batch: [
        [{ meta: { changes: 1 } }, { meta: { changes: 1 } }],
        [{ meta: { changes: 1 } }, { meta: { changes: 1 } }],
      ],
    });
    const queueSend = vi.fn().mockResolvedValue(undefined);
    const releaseLock = vi.fn().mockResolvedValue(true);
    const response = await handleJobFailureOperations(
      operationsRequest("/_ops/job-failures/failure-1/replay", {
        method: "POST",
        actor: "oncall@example.com",
        body: { expectedVersion: 1, note: "safe to replay after review" },
      }),
      {
        OPS_TOKEN: "ops-secret",
        OPS_DB: database.db,
        JOBS_QUEUE: { send: queueSend },
        STATE_DO: {
          idFromName: vi.fn().mockReturnValue("state-id"),
          get: vi.fn().mockReturnValue({ releaseLock }),
        },
      } as unknown as Env,
    );
    const body = (await response?.json()) as Record<string, unknown>;

    expect(response?.status).toBe(202);
    expect(body.status).toBe("replayed");
    expect(database.batch).toHaveBeenCalledTimes(2);
    expect(queueSend).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.any(String),
        replayOfFailureId: "failure-1",
        dedupeClaimed: false,
      }),
    );
  });

  it("returns an enqueue failure to quarantine with an audit event", async () => {
    const database = fakeDatabase({
      first: [failureRow()],
      batch: [
        [{ meta: { changes: 1 } }, { meta: { changes: 1 } }],
        [{ meta: { changes: 1 } }, { meta: { changes: 1 } }],
      ],
    });
    const response = await handleJobFailureOperations(
      operationsRequest("/_ops/job-failures/failure-1/replay", {
        method: "POST",
        actor: "oncall@example.com",
        body: { expectedVersion: 1, note: "safe to replay after review" },
      }),
      {
        OPS_TOKEN: "ops-secret",
        OPS_DB: database.db,
        JOBS_QUEUE: {
          send: vi.fn().mockRejectedValue(new Error("queue unavailable")),
        },
        STATE_DO: {
          idFromName: vi.fn().mockReturnValue("state-id"),
          get: vi.fn().mockReturnValue({
            releaseLock: vi.fn().mockResolvedValue(true),
          }),
        },
      } as unknown as Env,
    );

    expect(response?.status).toBe(503);
    expect(database.batch).toHaveBeenCalledTimes(2);
    expect(database.prepared.some(({ sql }) => sql.includes("replay_failed")))
      .toBe(true);
  });

  it("preflights every bulk item before enqueueing any replay", async () => {
    const database = fakeDatabase({
      first: [
        failureRow(),
        failureRow({
          id: "failure-2",
          reason: "executor-outcome-ambiguous",
        }),
      ],
    });
    const queueSend = vi.fn();
    const response = await handleJobFailureOperations(
      operationsRequest("/_ops/job-failures/bulk-replay", {
        method: "POST",
        actor: "oncall@example.com",
        body: {
          requestId: "bulk-preflight-001",
          note: "reviewed both cases before the bounded replay",
          confirmBulkReplay: true,
          items: [
            { id: "failure-1", expectedVersion: 1 },
            { id: "failure-2", expectedVersion: 1 },
          ],
        },
      }),
      {
        OPS_TOKEN: "ops-secret",
        OPS_DB: database.db,
        JOBS_QUEUE: { send: queueSend },
      } as unknown as Env,
    );
    const body = (await response?.json()) as {
      failures: Array<{ id: string; error: string }>;
    };

    expect(response?.status).toBe(409);
    expect(body.failures).toContainEqual({
      id: "failure-2",
      error: "uncertain-outcome confirmation required",
    });
    expect(queueSend).not.toHaveBeenCalled();
    expect(database.batch).not.toHaveBeenCalled();
  });

  it("replays at most ten preflighted cases with a shared audit request id", async () => {
    const second = failureRow({
      id: "failure-2",
      job_id: "original-job-2",
      job_json: JSON.stringify(job({ id: "original-job-2" })),
    });
    const database = fakeDatabase({
      first: [failureRow(), second, failureRow(), second],
    });
    const queueSend = vi.fn().mockResolvedValue(undefined);
    const response = await handleJobFailureOperations(
      operationsRequest("/_ops/job-failures/bulk-replay", {
        method: "POST",
        actor: "oncall@example.com",
        body: {
          requestId: "bulk-execute-001",
          note: "reviewed and approved bounded replay",
          confirmBulkReplay: true,
          items: [
            { id: "failure-1", expectedVersion: 1 },
            { id: "failure-2", expectedVersion: 1 },
          ],
        },
      }),
      {
        OPS_TOKEN: "ops-secret",
        OPS_DB: database.db,
        JOBS_QUEUE: { send: queueSend },
        STATE_DO: {
          idFromName: vi.fn().mockReturnValue("state-id"),
          get: vi.fn().mockReturnValue({
            releaseLock: vi.fn().mockResolvedValue(true),
          }),
        },
      } as unknown as Env,
    );
    const body = (await response?.json()) as {
      requested: number;
      attempted: number;
      completed: number;
      stoppedEarly: boolean;
    };

    expect(response?.status).toBe(202);
    expect(body).toMatchObject({
      requested: 2,
      attempted: 2,
      completed: 2,
      stoppedEarly: false,
    });
    expect(queueSend).toHaveBeenCalledTimes(2);
    expect(
      database.prepared.some(({ bindings }) =>
        bindings.some(
          (binding) =>
            typeof binding === "string" &&
            binding.includes('"bulkRequestId":"bulk-execute-001"'),
        ),
      ),
    ).toBe(true);
  });

  it("rejects duplicate or oversized bulk selections", async () => {
    const duplicate = await handleJobFailureOperations(
      operationsRequest("/_ops/job-failures/bulk-replay", {
        method: "POST",
        actor: "oncall@example.com",
        body: {
          requestId: "bulk-invalid-001",
          note: "invalid duplicate test",
          confirmBulkReplay: true,
          items: [
            { id: "failure-1", expectedVersion: 1 },
            { id: "failure-1", expectedVersion: 1 },
          ],
        },
      }),
      { OPS_TOKEN: "ops-secret" } as Env,
    );
    expect(duplicate?.status).toBe(400);

    const oversized = await handleJobFailureOperations(
      operationsRequest("/_ops/job-failures/bulk-replay", {
        method: "POST",
        actor: "oncall@example.com",
        body: {
          requestId: "bulk-invalid-002",
          note: "invalid size test",
          confirmBulkReplay: true,
          items: Array.from({ length: 11 }, (_, index) => ({
            id: `failure-${index}`,
            expectedVersion: 1,
          })),
        },
      }),
      { OPS_TOKEN: "ops-secret" } as Env,
    );
    expect(oversized?.status).toBe(400);
  });
});
