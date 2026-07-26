import { MAX_JOB_RETRY_LIMIT } from "./job-policy";
import type { CloudflareTwentyJob } from "./types";

export async function deterministicFailureId(seed: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(seed),
  );
  return `failure:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

export function validJob(value: unknown): value is CloudflareTwentyJob {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const job = value as Partial<CloudflareTwentyJob>;
  return (
    job.schemaVersion === 1 &&
    typeof job.id === "string" &&
    job.id.length > 0 &&
    job.id.length <= 128 &&
    typeof job.queueName === "string" &&
    job.queueName.length > 0 &&
    job.queueName.length <= 128 &&
    typeof job.jobName === "string" &&
    job.jobName.length > 0 &&
    job.jobName.length <= 256 &&
    typeof job.createdAt === "string" &&
    typeof job.retryLimit === "number" &&
    Number.isSafeInteger(job.retryLimit) &&
    job.retryLimit >= 0 &&
    job.retryLimit <= MAX_JOB_RETRY_LIMIT &&
    typeof job.priority === "number" &&
    Number.isSafeInteger(job.priority) &&
    (job.notBefore === undefined ||
      (typeof job.notBefore === "number" &&
        Number.isSafeInteger(job.notBefore) &&
        job.notBefore > 0)) &&
    (job.dedupeKey === undefined ||
      (typeof job.dedupeKey === "string" &&
        job.dedupeKey.length > 0 &&
        job.dedupeKey.length <= 512)) &&
    (job.dedupeClaimed === undefined ||
      typeof job.dedupeClaimed === "boolean") &&
    (job.retainDedupe === undefined || typeof job.retainDedupe === "boolean") &&
    (job.replayOfFailureId === undefined ||
      (typeof job.replayOfFailureId === "string" &&
        job.replayOfFailureId.length > 0 &&
        job.replayOfFailureId.length <= 128))
  );
}
