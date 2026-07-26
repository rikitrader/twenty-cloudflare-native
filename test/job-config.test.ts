import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_JOB_RETRY_LIMIT } from "../src/job-policy";

function queueConsumer(config: string, queueName: string): string {
  const consumersStart = config.indexOf('"consumers"');
  const queueStart = config.indexOf(
    `"queue": "${queueName}"`,
    consumersStart,
  );
  if (queueStart === -1) throw new Error(`queue not found: ${queueName}`);
  return config.slice(queueStart, queueStart + 320);
}

describe("Cloudflare job retry configuration", () => {
  const production = readFileSync(resolve("wrangler.jsonc"), "utf8");
  const canary = readFileSync(resolve("wrangler.canary.jsonc"), "utf8");
  const staging = readFileSync(resolve("wrangler.staging.jsonc"), "utf8");

  it("allows the full envelope retry range in production", () => {
    const consumer = queueConsumer(production, "twenty-jobs");
    expect(consumer).toContain(`"max_retries": ${MAX_JOB_RETRY_LIMIT}`);
    expect(consumer).toContain('"dead_letter_queue": "twenty-jobs-dlq"');
  });

  it("uses the same retry ceiling for the isolated canary", () => {
    for (const queue of [
      "twenty-jobs-canary-v2",
      "twenty-redis-canary-probe",
    ]) {
      const consumer = queueConsumer(canary, queue);
      expect(consumer).toContain(`"max_retries": ${MAX_JOB_RETRY_LIMIT}`);
      expect(consumer).toContain(
        '"dead_letter_queue": "twenty-jobs-canary-v2-dlq"',
      );
    }
  });

  it("consumes each job DLQ into the operations ledger", () => {
    expect(queueConsumer(production, "twenty-jobs-dlq")).toContain(
      '"max_concurrency": 2',
    );
    expect(queueConsumer(canary, "twenty-jobs-canary-v2-dlq")).toContain(
      '"max_concurrency": 1',
    );
    expect(production).toContain('"JOB_DLQ_NAME": "twenty-jobs-dlq"');
    expect(canary).toContain(
      '"JOB_DLQ_NAME": "twenty-jobs-canary-v2-dlq"',
    );
  });

  it("caps dormant staging at one server, one worker, and one backup", () => {
    const serverContainer = staging.slice(
      staging.indexOf('"class_name": "TwentyServer"'),
      staging.indexOf('"class_name": "TwentyWorker"'),
    );
    const workerContainer = staging.slice(
      staging.indexOf('"class_name": "TwentyWorker"'),
      staging.indexOf('"class_name": "TwentyBackup"'),
    );
    const backupContainer = staging.slice(
      staging.indexOf('"class_name": "TwentyBackup"'),
      staging.indexOf('"durable_objects"'),
    );
    expect(serverContainer).toContain('"max_instances": 1');
    expect(workerContainer).toContain('"max_instances": 1');
    expect(backupContainer).toContain('"max_instances": 1');
    expect(staging).toContain('"SERVER_REPLICAS": "1"');
    expect(staging).toContain('"WORKER_REPLICAS": "1"');
    expect(staging).toContain('"PG_POOL_MAX_CONNECTIONS": "5"');
    const capacityConsumer = queueConsumer(
      staging,
      "twenty-enterprise-staging-probe",
    );
    expect(capacityConsumer).toContain('"max_batch_size": 10');
    expect(capacityConsumer).toContain('"max_concurrency": 4');
  });
});
