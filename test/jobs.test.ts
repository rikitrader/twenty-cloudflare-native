import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/containers", () => ({
  getContainer: vi.fn(),
  getRandom: vi.fn(),
}));

import { getContainer, getRandom } from "@cloudflare/containers";
import {
  consumeJobBatch,
  handleJobEnqueue,
  jobExecutionLease,
  jobExecutionTimeout,
  retryDelayForAttempt,
  retryDelayForLease,
} from "../src/jobs";
import type { CloudflareTwentyJob, Env } from "../src/types";

function job(overrides: Partial<CloudflareTwentyJob> = {}): CloudflareTwentyJob {
  return {
    schemaVersion: 1,
    id: "job-owner",
    queueName: "defaultQueue",
    jobName: "ExampleJob",
    data: { workspaceId: "workspace" },
    createdAt: new Date().toISOString(),
    retryLimit: 3,
    priority: 5,
    ...overrides,
  };
}

function fixture(
  options: {
    acquired?: boolean;
    executionDisposition?: "started" | "busy" | "completed" | "quarantined";
    leaseExpiresAt?: number;
    failureCode?:
      | "executor-outcome-ambiguous"
      | "permanent-executor-response"
      | "retry-limit-exceeded";
    reservedAbandoned?: boolean;
  } = {},
) {
  const stateStub = {
    acquireLock: vi
      .fn()
      .mockResolvedValue({ acquired: options.acquired ?? true }),
    releaseLock: vi.fn().mockResolvedValue(true),
    beginJobExecution: vi.fn().mockResolvedValue({
      disposition: options.executionDisposition ?? "started",
      attempts: 1,
      leaseExpiresAt: options.leaseExpiresAt,
      failureCode: options.failureCode,
    }),
    completeJobExecution: vi.fn().mockResolvedValue(true),
    abandonJobExecution: vi.fn().mockResolvedValue(true),
    abandonReservedJobExecution: vi
      .fn()
      .mockResolvedValue(options.reservedAbandoned ?? false),
    quarantineJobExecution: vi.fn().mockResolvedValue(true),
    setValue: vi.fn().mockResolvedValue({ found: true }),
  };
  const testEnv = {
    INTERNAL_SERVICE_TOKEN: "internal-token",
    JOBS_QUEUE: { send: vi.fn().mockResolvedValue(undefined) },
    JOBS_DLQ: { send: vi.fn().mockResolvedValue(undefined) },
    STATE_DO: {
      idFromName: vi.fn().mockReturnValue("state-id"),
      get: vi.fn().mockReturnValue(stateStub),
    },
  } as unknown as Env;
  return { stateStub, testEnv };
}

function enqueueRequest(body: unknown, token = "internal-token"): Request {
  return new Request("http://twenty-queue.internal/v1/jobs/enqueue", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function message(
  body: CloudflareTwentyJob,
  attempts = 1,
): Message<CloudflareTwentyJob> {
  return {
    id: "queue-message",
    timestamp: new Date(),
    body,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

async function consume(
  queueMessage: Message<CloudflareTwentyJob>,
  testEnv: Env,
) {
  await consumeJobBatch(
    {
      queue: "twenty-jobs",
      messages: [queueMessage],
    } as unknown as MessageBatch<CloudflareTwentyJob>,
    testEnv,
  );
}

const getContainerMock = vi.mocked(getContainer);
const getRandomMock = vi.mocked(getRandom);
let executorFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  executorFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  getContainerMock.mockReset();
  getContainerMock.mockReturnValue({ fetch: executorFetch } as never);
  getRandomMock.mockReset();
  getRandomMock.mockResolvedValue({ fetch: executorFetch } as never);
});

describe("Cloudflare job gateway", () => {
  it("persists a validated job before any consumer-side dedupe claim", async () => {
    const { testEnv } = fixture();
    const response = await handleJobEnqueue(
      enqueueRequest(job({ dedupeKey: "queue:record" })),
      testEnv,
    );
    expect(response.status).toBe(202);
    expect(testEnv.JOBS_QUEUE.send).toHaveBeenCalledOnce();
    expect(testEnv.STATE_DO.get).not.toHaveBeenCalled();
  });

  it("acknowledges a duplicate occurrence before invoking its handler", async () => {
    const { testEnv } = fixture({ acquired: false });
    const queueMessage = message(
      job({
        dedupeKey: "queue:record",
        dedupeClaimed: false,
        retainDedupe: true,
      }),
    );

    await consume(queueMessage, testEnv);

    expect(queueMessage.ack).toHaveBeenCalledOnce();
    expect(queueMessage.retry).not.toHaveBeenCalled();
    expect(executorFetch).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated or malformed envelopes", async () => {
    const { testEnv } = fixture();
    expect(
      (await handleJobEnqueue(enqueueRequest(job(), "wrong"), testEnv)).status,
    ).toBe(401);
    expect(
      (
        await handleJobEnqueue(
          enqueueRequest({ schemaVersion: 1 }),
          testEnv,
        )
      ).status,
    ).toBe(400);
  });

  it("chains long delayed messages without executing them early", async () => {
    const { testEnv } = fixture();
    const queueMessage = message(
      job({ notBefore: Date.now() + 24 * 60 * 60_000 }),
    );

    await consume(queueMessage, testEnv);

    expect(testEnv.JOBS_QUEUE.send).toHaveBeenCalledWith(queueMessage.body, {
      delaySeconds: 43_200,
    });
    expect(queueMessage.ack).toHaveBeenCalledOnce();
    expect(executorFetch).not.toHaveBeenCalled();
  });

  it("acknowledges a delivery already completed by the execution ledger", async () => {
    const { testEnv } = fixture({ executionDisposition: "completed" });
    const queueMessage = message(job(), 2);

    await consume(queueMessage, testEnv);

    expect(queueMessage.ack).toHaveBeenCalledOnce();
    expect(queueMessage.retry).not.toHaveBeenCalled();
    expect(executorFetch).not.toHaveBeenCalled();
  });

  it("waits for the active execution lease instead of burning retries", async () => {
    const leaseExpiresAt = Date.now() + 10 * 60_000;
    const { testEnv } = fixture({
      executionDisposition: "busy",
      leaseExpiresAt,
    });
    const queueMessage = message(job());

    await consume(queueMessage, testEnv);

    const delay = vi.mocked(queueMessage.retry).mock.calls[0][0]?.delaySeconds;
    expect(delay).toBeGreaterThanOrEqual(599);
    expect(delay).toBeLessThanOrEqual(600);
    expect(queueMessage.ack).not.toHaveBeenCalled();
    expect(executorFetch).not.toHaveBeenCalled();
  });

  it("records completion before acknowledging successful execution", async () => {
    const { stateStub, testEnv } = fixture();
    const queueMessage = message(job());

    await consume(queueMessage, testEnv);

    expect(executorFetch).toHaveBeenCalledOnce();
    const executorRequest = executorFetch.mock.calls[0][0] as Request;
    expect(
      executorRequest.headers.get("x-twenty-job-execution-owner"),
    ).toEqual(expect.any(String));
    expect(stateStub.completeJobExecution).toHaveBeenCalledOnce();
    expect(
      stateStub.completeJobExecution.mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(queueMessage.ack).mock.invocationCallOrder[0]);
  });

  it("processes independent messages in a Queue batch concurrently", async () => {
    const releases: Array<(response: Response) => void> = [];
    executorFetch.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          releases.push(resolve);
        }),
    );
    const { testEnv } = fixture();
    const first = message(job({ id: "job-first" }));
    const second = message(job({ id: "job-second" }));

    const consuming = consumeJobBatch(
      {
        queue: "twenty-jobs",
        messages: [first, second],
      } as unknown as MessageBatch<CloudflareTwentyJob>,
      testEnv,
    );
    await vi.waitFor(() => expect(executorFetch).toHaveBeenCalledTimes(2));
    for (const release of releases)
      release(new Response(null, { status: 204 }));
    await consuming;

    expect(first.ack).toHaveBeenCalledOnce();
    expect(second.ack).toHaveBeenCalledOnce();
  });

  it("distributes execution across the configured worker replica pool", async () => {
    const { testEnv } = fixture();
    testEnv.WORKER_REPLICAS = "2";
    const queueMessage = message(job());

    await consume(queueMessage, testEnv);

    expect(getRandomMock).toHaveBeenCalledWith(testEnv.TWENTY_WORKER, 2);
    expect(getContainerMock).not.toHaveBeenCalled();
    expect(queueMessage.ack).toHaveBeenCalledOnce();
  });

  it("abandons a known transient failure before an exponential retry", async () => {
    executorFetch.mockResolvedValue(
      new Response("temporary", {
        status: 503,
        headers: { "x-twenty-execution-outcome": "not-started" },
      }),
    );
    const { stateStub, testEnv } = fixture();
    const queueMessage = message(job({ retryLimit: 3 }), 2);

    await consume(queueMessage, testEnv);

    expect(stateStub.abandonJobExecution).toHaveBeenCalledOnce();
    expect(queueMessage.retry).toHaveBeenCalledWith({ delaySeconds: 2 });
    expect(queueMessage.ack).not.toHaveBeenCalled();
    expect(testEnv.JOBS_DLQ.send).not.toHaveBeenCalled();
  });

  it("quarantines a permanent executor response before writing the DLQ", async () => {
    executorFetch.mockResolvedValue(new Response("missing", { status: 409 }));
    const { stateStub, testEnv } = fixture();
    const queueMessage = message(
      job({ dedupeKey: "queue:record", retainDedupe: true }),
    );

    await consume(queueMessage, testEnv);

    expect(stateStub.quarantineJobExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job-owner",
        failureCode: "permanent-executor-response",
      }),
    );
    expect(testEnv.JOBS_DLQ.send).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "permanent-executor-response" }),
    );
    expect(stateStub.releaseLock).not.toHaveBeenCalled();
    expect(queueMessage.ack).toHaveBeenCalledOnce();
  });

  it("quarantines a known failure after the envelope retry limit", async () => {
    executorFetch.mockResolvedValue(
      new Response("temporary", {
        status: 503,
        headers: { "x-twenty-execution-outcome": "not-started" },
      }),
    );
    const { stateStub, testEnv } = fixture();
    const queueMessage = message(job({ retryLimit: 2 }), 3);

    await consume(queueMessage, testEnv);

    expect(stateStub.quarantineJobExecution).toHaveBeenCalledWith(
      expect.objectContaining({ failureCode: "retry-limit-exceeded" }),
    );
    expect(testEnv.JOBS_DLQ.send).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "retry-limit-exceeded" }),
    );
    expect(stateStub.abandonJobExecution).not.toHaveBeenCalled();
    expect(queueMessage.ack).toHaveBeenCalledOnce();
  });

  it("quarantines an unclassified executor failure without replay", async () => {
    executorFetch.mockResolvedValue(
      new Response("handler failed after a possible side effect", {
        status: 500,
      }),
    );
    const { stateStub, testEnv } = fixture();
    const queueMessage = message(job({ retryLimit: 3 }), 1);

    await consume(queueMessage, testEnv);

    expect(stateStub.quarantineJobExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        failureCode: "executor-outcome-ambiguous",
      }),
    );
    expect(stateStub.abandonJobExecution).not.toHaveBeenCalled();
    expect(queueMessage.retry).not.toHaveBeenCalled();
    expect(queueMessage.ack).toHaveBeenCalledOnce();
  });

  it("records isolated canary failures after writing the DLQ", async () => {
    executorFetch.mockResolvedValue(new Response("missing", { status: 409 }));
    const { stateStub, testEnv } = fixture();
    const queueMessage = message(
      job({
        queueName: "__cloudflare_canary__",
        jobName: "fail-permanent",
      }),
    );

    await consume(queueMessage, testEnv);

    expect(stateStub.setValue).toHaveBeenCalledWith({
      namespace: "canary",
      key: "job-failure:job-owner",
      value: { reason: "permanent-executor-response" },
      ttlMs: 60 * 60_000,
    });
    expect(
      vi.mocked(testEnv.JOBS_DLQ.send).mock.invocationCallOrder[0],
    ).toBeLessThan(stateStub.setValue.mock.invocationCallOrder[0]);
  });

  it("holds the receipt lease after an ambiguous transport failure", async () => {
    executorFetch.mockRejectedValue(new Error("connection reset"));
    const leaseExpiresAt = Date.now() + 16 * 60_000;
    const { stateStub, testEnv } = fixture({ leaseExpiresAt });
    const queueMessage = message(job({ retryLimit: 3 }), 1);

    await consume(queueMessage, testEnv);

    const delay = vi.mocked(queueMessage.retry).mock.calls[0][0]?.delaySeconds;
    expect(delay).toBeGreaterThanOrEqual(959);
    expect(delay).toBeLessThanOrEqual(960);
    expect(stateStub.abandonJobExecution).not.toHaveBeenCalled();
    expect(stateStub.abandonReservedJobExecution).toHaveBeenCalledOnce();
    expect(stateStub.quarantineJobExecution).not.toHaveBeenCalled();
    expect(queueMessage.ack).not.toHaveBeenCalled();
  });

  it("retries quickly when transport fails before the handler starts", async () => {
    executorFetch.mockRejectedValue(new Error("container unavailable"));
    const { stateStub, testEnv } = fixture({
      leaseExpiresAt: Date.now() + 16 * 60_000,
      reservedAbandoned: true,
    });
    const queueMessage = message(job({ retryLimit: 3 }), 1);

    await consume(queueMessage, testEnv);

    expect(stateStub.abandonReservedJobExecution).toHaveBeenCalledOnce();
    expect(queueMessage.retry).toHaveBeenCalledWith({ delaySeconds: 1 });
    expect(stateStub.quarantineJobExecution).not.toHaveBeenCalled();
    expect(queueMessage.ack).not.toHaveBeenCalled();
  });

  it("quarantines an ambiguous terminal outcome without replaying it", async () => {
    executorFetch.mockRejectedValue(new Error("timeout after commit"));
    const { stateStub, testEnv } = fixture({
      leaseExpiresAt: Date.now() + 16 * 60_000,
    });
    const queueMessage = message(job({ retryLimit: 1 }), 2);

    await consume(queueMessage, testEnv);

    expect(stateStub.quarantineJobExecution).toHaveBeenCalledWith(
      expect.objectContaining({ failureCode: "executor-outcome-ambiguous" }),
    );
    expect(stateStub.abandonReservedJobExecution).not.toHaveBeenCalled();
    expect(testEnv.JOBS_DLQ.send).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "executor-outcome-ambiguous" }),
    );
    expect(queueMessage.ack).toHaveBeenCalledOnce();
  });

  it("routes a quarantined replay to the DLQ without calling the handler", async () => {
    const { testEnv } = fixture({
      executionDisposition: "quarantined",
      failureCode: "executor-outcome-ambiguous",
    });
    const queueMessage = message(job(), 3);

    await consume(queueMessage, testEnv);

    expect(executorFetch).not.toHaveBeenCalled();
    expect(testEnv.JOBS_DLQ.send).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "executor-outcome-ambiguous" }),
    );
    expect(queueMessage.ack).toHaveBeenCalledOnce();
  });

  it("passes retention into the atomic execution-receipt decision", async () => {
    const { stateStub, testEnv } = fixture();
    const queueMessage = message(job());

    await consume(queueMessage, testEnv);

    expect(stateStub.beginJobExecution).toHaveBeenCalledWith({
      jobId: "job-owner",
      owner: expect.any(String),
      leaseMs: 16 * 60_000,
      retentionMs: 7 * 24 * 60 * 60_000,
    });
  });

  it("bounds retry delays for attempts and leases", () => {
    expect(retryDelayForAttempt(1)).toBe(1);
    expect(retryDelayForAttempt(20)).toBe(300);
    expect(retryDelayForLease(Date.now() - 1)).toBe(1);
    expect(retryDelayForLease(Date.now() + 24 * 60 * 60_000)).toBe(43_200);
  });

  it("shortens only isolated transport and container fault timeouts", () => {
    expect(
      jobExecutionTimeout(
        job({ queueName: "__cloudflare_canary__", jobName: "disconnect" }),
      ),
    ).toBe(30_000);
    expect(
      jobExecutionTimeout(
        job({ queueName: "__cloudflare_canary__", jobName: "crash" }),
      ),
    ).toBe(30_000);
    expect(
      jobExecutionTimeout(
        job({
          queueName: "__cloudflare_canary__",
          jobName: "full-container-crash",
        }),
      ),
    ).toBe(30_000);
    expect(jobExecutionTimeout(job())).toBe(15 * 60_000);
  });

  it("shortens only the isolated full-container crash receipt lease", () => {
    expect(
      jobExecutionLease(
        job({
          queueName: "__cloudflare_canary__",
          jobName: "full-container-crash",
        }),
      ),
    ).toBe(60_000);
    expect(
      jobExecutionLease(
        job({ queueName: "__cloudflare_canary__", jobName: "crash" }),
      ),
    ).toBe(16 * 60_000);
    expect(jobExecutionLease(job())).toBe(16 * 60_000);
  });
});
