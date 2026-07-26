"use strict";

const http = require("node:http");
const crypto = require("node:crypto");

const QUEUE_URL =
  process.env.CLOUDFLARE_QUEUE_URL ?? "http://twenty-queue.internal";
const STATE_URL =
  process.env.CLOUDFLARE_STATE_URL ?? "http://twenty-state.internal";
const STATE_SHARD =
  process.env.CLOUDFLARE_STATE_SHARD ?? "workspace:default";
const EXECUTOR_PORT = Number(process.env.CLOUDFLARE_JOB_EXECUTOR_PORT ?? 2022);
const MAX_BODY_BYTES = 128 * 1024;
const FULL_CONTAINER_CRASH_HOLD_MS = 2 * 60_000;

class CloudflareQueueDriver {
  constructor() {
    this.handlers = new Map();
    this.server = undefined;
    this.token = process.env.INTERNAL_SERVICE_TOKEN;
    if (!this.token) throw new Error("INTERNAL_SERVICE_TOKEN is required");
  }

  register(_queueName) {}

  async request(path, body) {
    const response = await fetch(new URL(path, QUEUE_URL), {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(
        `Cloudflare queue ${path} failed (${response.status}): ${
          result.error ?? "unknown error"
        }`,
      );
    return result;
  }

  async signalCanaryJobStarted(job) {
    const response = await fetch(new URL("/v1/state/set", STATE_URL), {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        "x-twenty-state-shard": STATE_SHARD,
      },
      body: JSON.stringify({
        namespace: "canary",
        key: `job-started:${job.id}`,
        value: {
          startedAt: new Date().toISOString(),
          processId: process.pid,
        },
        ttlMs: 10 * 60_000,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(
        `Cloudflare canary start signal failed (${response.status}): ${
          result.error ?? "unknown error"
        }`,
      );
    }
  }

  async markJobExecutionStarted(job, owner) {
    const response = await fetch(
      new URL("/v1/job-execution/started", STATE_URL),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
          "x-twenty-state-shard": STATE_SHARD,
        },
        body: JSON.stringify({ jobId: job.id, owner }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    const result = await response.json().catch(() => ({}));
    return response.ok && result.started === true;
  }

  async recordCanarySideEffect(job) {
    const response = await fetch(new URL("/v1/state/increment", STATE_URL), {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        "x-twenty-state-shard": STATE_SHARD,
      },
      body: JSON.stringify({
        namespace: "canary",
        key: `job-side-effects:${job.id}`,
        delta: 1,
        ttlMs: 60 * 60_000,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      throw new Error(`Cloudflare canary side-effect signal failed`);
  }

  async add(queueName, jobName, data, options = {}) {
    await this.request("/v1/jobs/enqueue", {
      schemaVersion: 1,
      id: crypto.randomUUID(),
      queueName,
      jobName,
      data,
      createdAt: new Date().toISOString(),
      retryLimit: options.retryLimit ?? 0,
      priority: options.priority ?? 5,
      ...(options.delay
        ? { notBefore: Date.now() + Math.max(0, options.delay) }
        : {}),
      ...(options.id
        ? {
            dedupeKey: `${queueName}:${options.id}`,
            dedupeClaimed: false,
            retainDedupe: true,
          }
        : {}),
    });
  }

  scheduleId(input) {
    return `${input.queueName}:${input.jobName}:${input.jobId ?? "default"}`;
  }

  async addCron(input) {
    const repeat = input.options?.repeat ?? {};
    await this.request("/v1/schedules/upsert", {
      scheduleId: this.scheduleId(input),
      queueName: input.queueName,
      jobName: input.jobName,
      data: input.data ?? null,
      retryLimit: input.options?.retryLimit ?? 0,
      priority: input.options?.priority ?? 5,
      ...(repeat.pattern ? { pattern: repeat.pattern } : {}),
      ...(repeat.every ? { everyMs: repeat.every } : {}),
      ...(repeat.tz ? { timezone: repeat.tz } : {}),
      ...(repeat.startDate ? { startDate: repeat.startDate } : {}),
      ...(repeat.endDate ? { endDate: repeat.endDate } : {}),
    });
  }

  async removeCron(input) {
    await this.request("/v1/schedules/remove", {
      scheduleId: this.scheduleId(input),
    });
  }

  work(queueName, handler) {
    this.handlers.set(queueName, handler);
    this.ensureServer();
  }

  ensureServer() {
    if (this.server) return;
    this.server = http.createServer(async (request, response) => {
      if (request.headers.authorization !== `Bearer ${this.token}`) {
        response.writeHead(401).end("unauthorized");
        return;
      }
      if (request.method === "GET" && request.url === "/health") {
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(
            JSON.stringify({
              ready: true,
              registeredQueues: [...this.handlers.keys()].sort(),
            }),
          );
        return;
      }
      if (request.method !== "POST" || request.url !== "/execute") {
        response.writeHead(404).end("not found");
        return;
      }
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) throw new Error("job body too large");
          chunks.push(chunk);
        }
        const job = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const executionOwner =
          request.headers["x-twenty-job-execution-owner"];
        if (typeof executionOwner === "string") {
          if (!(await this.markJobExecutionStarted(job, executionOwner))) {
            response
              .writeHead(409, {
                "x-twenty-execution-outcome": "not-started",
              })
              .end("execution reservation lost");
            return;
          }
        } else if (
          job.queueName !== "__cloudflare_canary__" ||
          job.jobName !== "ping"
        ) {
          response.writeHead(400).end("execution owner required");
          return;
        }
        if (
          job.queueName === "__cloudflare_canary__" &&
          job.jobName === "ping"
        ) {
          response.writeHead(204).end();
          return;
        }
        if (job.queueName === "__cloudflare_canary__") {
          if (process.env.CLOUDFLARE_CANARY_MODE !== "true") {
            response.writeHead(403).end("canary jobs disabled");
            return;
          }
          if (job.jobName === "fail-permanent") {
            response.writeHead(409).end("injected permanent failure");
            return;
          }
          if (job.jobName === "fail-transient") {
            response
              .writeHead(503, {
                "x-twenty-execution-outcome": "not-started",
              })
              .end("injected transient failure");
            return;
          }
          if (job.jobName === "fail-after-side-effect") {
            await this.recordCanarySideEffect(job);
            throw new Error("injected failure after side effect");
          }
          if (job.jobName === "disconnect") {
            request.socket.destroy();
            return;
          }
          if (job.jobName === "crash") {
            request.socket.destroy();
            setTimeout(() => process.exit(86), 10);
            return;
          }
          if (job.jobName === "full-container-crash") {
            await this.signalCanaryJobStarted(job);
            await new Promise((resolve) =>
              setTimeout(resolve, FULL_CONTAINER_CRASH_HOLD_MS),
            );
            response.writeHead(204).end();
            return;
          }
        }
        const handler = this.handlers.get(job.queueName);
        if (!handler) {
          response.writeHead(409).end(`handler not registered: ${job.queueName}`);
          return;
        }
        await handler({
          id: job.id,
          name: job.jobName,
          data: job.data,
          abortSignal: undefined,
        });
        response.writeHead(204).end();
      } catch (error) {
        response
          .writeHead(500, {
            "content-type": "text/plain",
            "x-twenty-execution-outcome": "ambiguous",
          })
          .end(error instanceof Error ? error.message : String(error));
      }
    });
    this.server.listen(EXECUTOR_PORT, "0.0.0.0");
  }

  async onModuleDestroy() {
    if (!this.server) return;
    await new Promise((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

module.exports = { CloudflareQueueDriver };
