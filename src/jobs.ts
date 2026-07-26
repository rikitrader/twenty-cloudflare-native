import { getContainer, getRandom } from "@cloudflare/containers";
import { bearerAuthorized, boundedReplicaCount } from "./lib";
import type { JobExecutionFailureCode } from "./cloudflare-state/contracts";
import { deterministicFailureId, validJob } from "./job-envelope";
import type { CloudflareTwentyJob, Env } from "./types";

const MAX_QUEUE_DELAY_SECONDS = 43_200;
const JOB_BODY_MAX_BYTES = 128 * 1024;
const JOB_DEDUPE_TTL_MS = 24 * 60 * 60_000;
const JOB_EXECUTION_TIMEOUT_MS = 15 * 60_000;
const CANARY_FAULT_TIMEOUT_MS = 30_000;
const JOB_EXECUTION_LEASE_MS = JOB_EXECUTION_TIMEOUT_MS + 60_000;
const CANARY_FULL_CRASH_LEASE_MS = 60_000;
const JOB_EXECUTION_RETENTION_MS = 7 * 24 * 60 * 60_000;

function delayUntil(notBefore: number | undefined): number | undefined {
  if (!notBefore) return undefined;
  const seconds = Math.ceil((notBefore - Date.now()) / 1000);
  if (seconds <= 0) return undefined;
  return Math.min(seconds, MAX_QUEUE_DELAY_SECONDS);
}

export function retryDelayForAttempt(attempts: number): number {
  return Math.min(300, 2 ** Math.max(0, attempts - 1));
}

export function retryDelayForLease(
  leaseExpiresAt: number | undefined,
  now = Date.now(),
): number {
  if (!leaseExpiresAt) return 5;
  return Math.min(
    MAX_QUEUE_DELAY_SECONDS,
    Math.max(1, Math.ceil((leaseExpiresAt - now) / 1_000)),
  );
}

export function jobExecutionTimeout(job: CloudflareTwentyJob): number {
  return job.queueName === "__cloudflare_canary__" &&
    (job.jobName === "disconnect" ||
      job.jobName === "crash" ||
      job.jobName === "full-container-crash")
    ? CANARY_FAULT_TIMEOUT_MS
    : JOB_EXECUTION_TIMEOUT_MS;
}

export function jobExecutionLease(job: CloudflareTwentyJob): number {
  return job.queueName === "__cloudflare_canary__" &&
    job.jobName === "full-container-crash"
    ? CANARY_FULL_CRASH_LEASE_MS
    : JOB_EXECUTION_LEASE_MS;
}

async function releaseDedupe(
  env: Env,
  job: CloudflareTwentyJob,
  force = false,
): Promise<void> {
  if (!job.dedupeKey || (job.retainDedupe && !force)) return;
  const stub = env.STATE_DO.get(env.STATE_DO.idFromName("workspace:default"));
  await stub.releaseLock({
    namespace: "job-dedupe",
    key: job.dedupeKey,
    owner: job.id,
  });
}

export async function handleJobEnqueue(
  request: Request,
  env: Env,
): Promise<Response> {
  if (
    !bearerAuthorized(
      request.headers.get("authorization"),
      env.INTERNAL_SERVICE_TOKEN,
    )
  )
    return Response.json({ error: "unauthorized" }, { status: 401 });
  if (request.method !== "POST")
    return Response.json({ error: "method not allowed" }, { status: 405 });

  const text = await request.text();
  if (text.length === 0 || text.length > JOB_BODY_MAX_BYTES)
    return Response.json({ error: "invalid job body size" }, { status: 400 });
  let job: unknown;
  try {
    job = JSON.parse(text);
  } catch {
    return Response.json({ error: "invalid job JSON" }, { status: 400 });
  }
  if (!validJob(job))
    return Response.json({ error: "invalid job envelope" }, { status: 400 });

  const delaySeconds = delayUntil(job.notBefore);
  await env.JOBS_QUEUE.send(job, delaySeconds ? { delaySeconds } : undefined);
  return Response.json({ queued: true, id: job.id }, { status: 202 });
}

export async function handleQueueGateway(
  request: Request,
  env: Env,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === "/v1/jobs/enqueue") return handleJobEnqueue(request, env);
  if (
    !bearerAuthorized(
      request.headers.get("authorization"),
      env.INTERNAL_SERVICE_TOKEN,
    )
  )
    return Response.json({ error: "unauthorized" }, { status: 401 });
  if (request.method !== "POST")
    return Response.json({ error: "method not allowed" }, { status: 405 });
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const stub = env.SCHEDULER_DO.get(
    env.SCHEDULER_DO.idFromName("workspace:default"),
  );
  try {
    if (path === "/v1/schedules/upsert")
      return Response.json(await stub.upsert(body as never), { status: 202 });
    if (path === "/v1/schedules/remove") {
      if (typeof body.scheduleId !== "string")
        return Response.json({ error: "invalid schedule id" }, { status: 400 });
      return Response.json({ removed: await stub.remove(body.scheduleId) });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "schedule failed" },
      { status: 400 },
    );
  }
}

async function deadLetter(
  env: Env,
  job: CloudflareTwentyJob,
  reason: JobExecutionFailureCode | "invalid-queue-envelope",
): Promise<void> {
  await env.JOBS_DLQ.send({
    schemaVersion: 1,
    failureId: await deterministicFailureId(`${job.id}\0${reason}`),
    job,
    reason,
    failedAt: new Date().toISOString(),
    source: "application",
  });
  if (job.queueName === "__cloudflare_canary__") {
    const state = env.STATE_DO.get(
      env.STATE_DO.idFromName("workspace:default"),
    );
    await state.setValue({
      namespace: "canary",
      key: `job-failure:${job.id}`,
      value: { reason },
      ttlMs: 60 * 60_000,
    });
  }
  // Retained dedupe claims require an explicit operator decision before replay.
  // Releasing them automatically can repeat an external side effect.
  await releaseDedupe(env, job);
}

async function consumeJobMessage(
  message: Message<CloudflareTwentyJob>,
  env: Env,
): Promise<void> {
  const job = message.body;
    if (!validJob(job)) {
      await env.JOBS_DLQ.send({
        schemaVersion: 1,
        failureId: await deterministicFailureId(
          `${message.id}\0invalid-queue-envelope`,
        ),
        job,
        reason: "invalid-queue-envelope",
        failedAt: new Date().toISOString(),
        source: "application",
      });
      message.ack();
      return;
    }

    if (job.dedupeKey && !job.dedupeClaimed) {
      const stub = env.STATE_DO.get(
        env.STATE_DO.idFromName("workspace:default"),
      );
      const claim = await stub.acquireLock({
        namespace: "job-dedupe",
        key: job.dedupeKey,
        owner: job.id,
        ttlMs: JOB_DEDUPE_TTL_MS,
      });
      if (!claim.acquired) {
        message.ack();
        return;
      }
      job.dedupeClaimed = true;
    }

    const remainingDelay = delayUntil(job.notBefore);
    if (remainingDelay) {
      await env.JOBS_QUEUE.send(job, { delaySeconds: remainingDelay });
      message.ack();
      return;
    }

    const executionStub = env.STATE_DO.get(
      env.STATE_DO.idFromName("workspace:default"),
    );
    const executionOwner = crypto.randomUUID();
    let executionActive = false;
    let executionLeaseExpiresAt: number | undefined;

    try {
      const execution = await executionStub.beginJobExecution({
        jobId: job.id,
        owner: executionOwner,
        leaseMs: jobExecutionLease(job),
        retentionMs: JOB_EXECUTION_RETENTION_MS,
      });
      if (execution.disposition === "completed") {
        await releaseDedupe(env, job);
        message.ack();
        return;
      }
      if (execution.disposition === "quarantined") {
        await deadLetter(
          env,
          job,
          execution.failureCode ?? "executor-outcome-ambiguous",
        );
        message.ack();
        return;
      }
      if (execution.disposition === "busy") {
        message.retry({
          delaySeconds: retryDelayForLease(execution.leaseExpiresAt),
        });
        return;
      }

      executionActive = true;
      executionLeaseExpiresAt = execution.leaseExpiresAt;
      if (
        job.queueName === "__cloudflare_canary__" &&
        job.jobName === "scheduler-ping"
      ) {
        const completed = await executionStub.completeJobExecution({
          jobId: job.id,
          owner: executionOwner,
          retentionMs: JOB_EXECUTION_RETENTION_MS,
        });
        if (!completed)
          throw new Error("scheduler canary execution lease was lost");
        executionActive = false;
        await executionStub.setValue({
          namespace: "canary",
          key: `job:${job.id}`,
          value: { completedAt: new Date().toISOString() },
          ttlMs: 5 * 60_000,
        });
        await releaseDedupe(env, job);
        message.ack();
        return;
      }
      const workerReplicas = boundedReplicaCount(env.WORKER_REPLICAS);
      const worker =
        workerReplicas > 1
          ? await getRandom(env.TWENTY_WORKER, workerReplicas)
          : getContainer(env.TWENTY_WORKER, "main");
      const response = await worker.fetch(
        new Request("http://twenty-worker/_jobs/execute", {
          method: "POST",
          headers: {
            authorization: `Bearer ${env.INTERNAL_SERVICE_TOKEN}`,
            "content-type": "application/json",
            "x-twenty-job-execution-owner": executionOwner,
          },
          body: JSON.stringify(job),
          signal: AbortSignal.timeout(jobExecutionTimeout(job)),
        }),
      );
      if (response.ok) {
        const completed = await executionStub.completeJobExecution({
          jobId: job.id,
          owner: executionOwner,
          retentionMs: JOB_EXECUTION_RETENTION_MS,
        });
        if (!completed)
          throw new Error("job execution lease was lost before completion");
        executionActive = false;
        if (
          job.queueName === "__cloudflare_canary__" &&
          job.jobName === "ping"
        ) {
          const stub = env.STATE_DO.get(
            env.STATE_DO.idFromName("workspace:default"),
          );
          await stub.setValue({
            namespace: "canary",
            key: `job:${job.id}`,
            value: {
              completedAt: new Date().toISOString(),
              executorInstance:
                response.headers.get("x-cloudflare-container-instance"),
            },
            ttlMs: 5 * 60_000,
          });
        }
        await releaseDedupe(env, job);
        message.ack();
      } else if (response.status >= 400 && response.status < 500) {
        const quarantined = await executionStub.quarantineJobExecution({
          jobId: job.id,
          owner: executionOwner,
          retentionMs: JOB_EXECUTION_RETENTION_MS,
          failureCode: "permanent-executor-response",
        });
        if (!quarantined)
          throw new Error("job execution lease was lost before quarantine");
        executionActive = false;
        await deadLetter(env, job, "permanent-executor-response");
        message.ack();
      } else if (
        response.headers.get("x-twenty-execution-outcome") !== "not-started"
      ) {
        const quarantined = await executionStub.quarantineJobExecution({
          jobId: job.id,
          owner: executionOwner,
          retentionMs: JOB_EXECUTION_RETENTION_MS,
          failureCode: "executor-outcome-ambiguous",
        });
        if (!quarantined)
          throw new Error("job execution lease was lost before quarantine");
        executionActive = false;
        await deadLetter(env, job, "executor-outcome-ambiguous");
        message.ack();
      } else if (message.attempts > job.retryLimit) {
        const quarantined = await executionStub.quarantineJobExecution({
          jobId: job.id,
          owner: executionOwner,
          retentionMs: JOB_EXECUTION_RETENTION_MS,
          failureCode: "retry-limit-exceeded",
        });
        if (!quarantined)
          throw new Error("job execution lease was lost before quarantine");
        executionActive = false;
        await deadLetter(env, job, "retry-limit-exceeded");
        message.ack();
      } else {
        await executionStub.abandonJobExecution({
          jobId: job.id,
          owner: executionOwner,
        });
        executionActive = false;
        message.retry({
          delaySeconds: retryDelayForAttempt(message.attempts),
        });
      }
    } catch {
      if (executionActive && message.attempts <= job.retryLimit) {
        const abandonedBeforeStart =
          await executionStub
            .abandonReservedJobExecution({
              jobId: job.id,
              owner: executionOwner,
            })
            .catch(() => false);
        if (abandonedBeforeStart) executionActive = false;
      }
      // A lost response after the handler commits cannot be made exactly-once
      // here. Keep the receipt lease so a rapid retry cannot run concurrently.
      // Handlers with external side effects still require idempotency.
      if (executionActive && message.attempts > job.retryLimit) {
        const quarantined = await executionStub.quarantineJobExecution({
          jobId: job.id,
          owner: executionOwner,
          retentionMs: JOB_EXECUTION_RETENTION_MS,
          failureCode: "executor-outcome-ambiguous",
        });
        if (!quarantined) {
          message.retry({
            delaySeconds: retryDelayForLease(executionLeaseExpiresAt),
          });
          return;
        }
        executionActive = false;
        await deadLetter(env, job, "executor-outcome-ambiguous");
        message.ack();
        return;
      }
      message.retry({
        delaySeconds: executionActive
          ? retryDelayForLease(executionLeaseExpiresAt)
          : retryDelayForAttempt(message.attempts),
      });
    }
}

export async function consumeJobBatch(
  batch: MessageBatch<CloudflareTwentyJob>,
  env: Env,
): Promise<void> {
  await Promise.all(
    batch.messages.map((message) => consumeJobMessage(message, env)),
  );
}
