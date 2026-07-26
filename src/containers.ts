import { Container } from "@cloudflare/containers";
import type { Env } from "./types";
import { pickLatest } from "./lib";
import { handleStateGateway } from "./cloudflare-state/gateway";
import { STATE_GATEWAY_HOST } from "./cloudflare-state/contracts";
import { handleQueueGateway } from "./jobs";
import { handlePubSubGateway } from "./pubsub-gateway";

export const AGENT_PORT = 2021;
export const JOB_EXECUTOR_PORT = 2022;
export const JOB_GATEWAY_HOST = "twenty-queue.internal";
export const EVENT_GATEWAY_HOST = "twenty-events.internal";
const stateOutbound = {
  [STATE_GATEWAY_HOST]: (request: Request, env: Env) =>
    handleStateGateway(request, env),
  [JOB_GATEWAY_HOST]: (request: Request, env: Env) =>
    handleQueueGateway(request, env),
  [EVENT_GATEWAY_HOST]: (request: Request, env: Env) =>
    handlePubSubGateway(request, env),
};
const PORT_READY_OPTIONS = {
  // Twenty can exceed two minutes during a beta Container rollout. A longer
  // readiness budget prevents a cold start from becoming a user-visible 1101.
  portReadyTimeoutMS: 300_000,
  instanceGetTimeoutMS: 300_000,
  waitInterval: 500,
} as const;

function portReadyOptions(env: Env, abort: AbortSignal) {
  return {
    ...PORT_READY_OPTIONS,
    // The isolated all-in-one canary initializes and upgrades a fresh Postgres
    // database on first boot. Queue consumers may run for 15 minutes, so keep
    // that one boot request alive long enough to reach the executor port.
    ...(env.CANARY_MODE === "true"
      ? { portReadyTimeoutMS: 10 * 60_000 }
      : {}),
    abort,
  };
}

function secretsEnv(env: Env): Record<string, string> {
  return {
    ...(env.ENCRYPTION_KEY ? { ENCRYPTION_KEY: env.ENCRYPTION_KEY } : {}),
    ...(env.FALLBACK_ENCRYPTION_KEY
      ? { FALLBACK_ENCRYPTION_KEY: env.FALLBACK_ENCRYPTION_KEY }
      : {}),
    ...(env.APP_SECRET ? { APP_SECRET: env.APP_SECRET } : {}),
  };
}

function storageEnv(env: Env): Record<string, string> {
  // Upstream names (STORAGE_S3_*) with AWS_* kept as aliases.
  const key = env.STORAGE_S3_ACCESS_KEY_ID ?? env.AWS_ACCESS_KEY_ID;
  const secret = env.STORAGE_S3_SECRET_ACCESS_KEY ?? env.AWS_SECRET_ACCESS_KEY;
  if (!key || !secret || !env.STORAGE_S3_ENDPOINT) return {};
  return {
    STORAGE_TYPE: "s3",
    STORAGE_S3_NAME: env.STORAGE_S3_NAME ?? "twenty-storage",
    STORAGE_S3_ENDPOINT: env.STORAGE_S3_ENDPOINT,
    STORAGE_S3_REGION: env.STORAGE_S3_REGION ?? "auto",
    STORAGE_S3_ACCESS_KEY_ID: key,
    STORAGE_S3_SECRET_ACCESS_KEY: secret,
    AWS_ACCESS_KEY_ID: key,
    AWS_SECRET_ACCESS_KEY: secret,
  };
}

function sharedEnv(env: Env): Record<string, string> {
  return {
    SERVER_URL: env.SERVER_URL,
    // This is a private, single-workspace deployment and all installed logic
    // functions are source-controlled in Dockerfile.production. LOCAL keeps
    // those trusted workflows available in Twenty's production image.
    LOGIC_FUNCTION_TYPE: "LOCAL",
    SIGN_IN_PREFILLED: "false",
    REDIS_BACKEND: env.REDIS_BACKEND ?? "redis",
    CLOUDFLARE_PUBSUB_TRANSPORT:
      env.CLOUDFLARE_PUBSUB_TRANSPORT ?? "poll",
    CLOUDFLARE_STATE_URL: `http://${STATE_GATEWAY_HOST}`,
    CLOUDFLARE_QUEUE_URL: `http://${JOB_GATEWAY_HOST}`,
    CLOUDFLARE_EVENTS_URL: `http://${EVENT_GATEWAY_HOST}`,
    CLOUDFLARE_STATE_SHARD: "workspace:default",
    CLOUDFLARE_JOB_EXECUTOR_PORT: String(JOB_EXECUTOR_PORT),
    CLOUDFLARE_QUEUE_DRAIN: env.CLOUDFLARE_QUEUE_DRAIN ?? "true",
    ...(env.INTERNAL_SERVICE_TOKEN
      ? { INTERNAL_SERVICE_TOKEN: env.INTERNAL_SERVICE_TOKEN }
      : {}),
    ...(env.CANARY_MODE === "true"
      ? { CLOUDFLARE_CANARY_MODE: "true" }
      : {}),
    ...secretsEnv(env),
    ...(env.PG_DATABASE_URL ? { PG_DATABASE_URL: env.PG_DATABASE_URL } : {}),
    ...(env.PG_POOL_MAX_CONNECTIONS
      ? { PG_POOL_MAX_CONNECTIONS: env.PG_POOL_MAX_CONNECTIONS }
      : {}),
    ...(env.REDIS_URL ? { REDIS_URL: env.REDIS_URL } : {}),
    ...storageEnv(env),
  };
}

/**
 * Demo mode: wrapper image (Dockerfile) over twenty-app-dev — adds the backup
 * agent on :2021 and restore-on-boot. Data recovery flow:
 *   boot → onStart → wait for agent → push latest R2 dump → psql restore
 * Restore is FAIL-OPEN: any failure logs and boots a fresh demo instead.
 */
export class TwentyContainer extends Container<Env> {
  defaultPort = 2020;
  sleepAfter = "2h";
  entrypoint = ["/cf/boot.sh"];
  private restoreKicked = false;

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    // Whenever Neon is configured, this all-in-one image doubles as the
    // authenticated pg_dump companion. In full external mode, user traffic and
    // BullMQ jobs go to TwentyServer/TwentyWorker; this instance retains its
    // isolated in-container Redis and exists only for R2 database backups.
    const externalPg = Boolean(env.PG_DATABASE_URL);
    this.envVars = {
      SERVER_URL: env.SERVER_URL,
      REDIS_BACKEND: env.REDIS_BACKEND ?? "redis",
      CLOUDFLARE_PUBSUB_TRANSPORT:
        env.CLOUDFLARE_PUBSUB_TRANSPORT ?? "poll",
      CLOUDFLARE_STATE_URL: `http://${STATE_GATEWAY_HOST}`,
      CLOUDFLARE_QUEUE_URL: `http://${JOB_GATEWAY_HOST}`,
      CLOUDFLARE_EVENTS_URL: `http://${EVENT_GATEWAY_HOST}`,
      CLOUDFLARE_STATE_SHARD: "workspace:default",
      CLOUDFLARE_JOB_EXECUTOR_PORT: String(JOB_EXECUTOR_PORT),
      CLOUDFLARE_QUEUE_DRAIN: env.CLOUDFLARE_QUEUE_DRAIN ?? "true",
      ...(env.INTERNAL_SERVICE_TOKEN
        ? { INTERNAL_SERVICE_TOKEN: env.INTERNAL_SERVICE_TOKEN }
        : {}),
      ...(env.CANARY_MODE === "true"
        ? { CLOUDFLARE_CANARY_MODE: "true" }
        : {}),
      ...secretsEnv(env),
      ...(env.BACKUP_TOKEN ? { BACKUP_TOKEN: env.BACKUP_TOKEN } : {}),
      ...(externalPg
        ? {
            PG_DATABASE_URL: env.PG_DATABASE_URL!,
            // Database releases are owned by twenty-crm-release. A normal
            // Container start can never initialize or upgrade Neon.
            DISABLE_DB_MIGRATIONS: "true",
            DISABLE_CRON_JOBS_REGISTRATION: "true",
            SIGN_IN_PREFILLED: "false",
            ...storageEnv(env),
          }
        : {}),
    };
    if (env.REDIS_URL) this.sleepAfter = "10m";
  }

  private async waitForAgent(): Promise<boolean> {
    for (let i = 0; i < 30; i++) {
      try {
        if ((await this.agentFetch("/ping")).ok) return true;
      } catch {
        /* agent not up yet */
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
  }

  agentFetch(path: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    if (this.env.BACKUP_TOKEN)
      headers.set("authorization", `Bearer ${this.env.BACKUP_TOKEN}`);
    return this.containerFetch(
      new Request(`http://agent${path}`, { ...init, headers }),
      AGENT_PORT,
    );
  }

  override async onStart(): Promise<void> {
    if (!this.restoreKicked) {
      this.restoreKicked = true;
      await this.tryRestore();
    }
  }

  override onStop(): void {
    this.restoreKicked = false; // next boot restores again
  }

  /** Fail-open: every early return boots a fresh demo, never blocks serving. */
  async tryRestore(): Promise<void> {
    try {
      if (this.env.CANARY_MODE === "true") {
        await this.waitForAgent();
        await this.agentFetch("/mark-settled", { method: "POST" });
        return console.log("restore: isolated canary, boot fresh");
      }
      if (this.env.PG_DATABASE_URL) {
        // External Postgres (Neon) IS the durable store — never restore over it.
        // Settle immediately so hourly dumps (now real Neon backups) can run.
        await this.waitForAgent();
        await this.agentFetch("/mark-settled", { method: "POST" });
        return console.log("restore: external PG, skip restore, dumps enabled");
      }
      if (!(await this.waitForAgent()))
        return console.log("restore: agent never came up, boot fresh");

      const state = (await (await this.agentFetch("/state")).json()) as {
        settled: boolean;
      };
      if (state.settled) return;

      const list = await this.env.STORAGE.list({ prefix: "backups/" });
      const latest = pickLatest(list.objects.map((o) => o.key));
      if (!latest) {
        // No backups: mark settled so dumps of this fresh instance are allowed.
        await this.agentFetch("/mark-settled", { method: "POST" });
        return console.log("restore: no backups in R2, fresh boot");
      }
      const obj = await this.env.STORAGE.get(latest);
      if (!obj) return console.log("restore: R2 object vanished, boot fresh");
      const res = await this.agentFetch("/restore", {
        method: "POST",
        body: await obj.arrayBuffer(),
      });
      console.log(`restore: ${latest} -> ${res.status} ${await res.text()}`);
    } catch (e) {
      console.log("restore failed open:", e);
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/_jobs/execute") {
      await this.startAndWaitForPorts(JOB_EXECUTOR_PORT, {
        ...portReadyOptions(this.env, request.signal),
      });
      return this.containerFetch(
        new Request("http://job-executor/execute", {
          method: request.method,
          headers: request.headers,
          body: request.body,
        }),
        JOB_EXECUTOR_PORT,
      );
    }
    if (url.pathname.startsWith("/_agent/")) {
      await this.startAndWaitForPorts(
        AGENT_PORT,
        portReadyOptions(this.env, request.signal),
      );
      return this.agentFetch(url.pathname.slice("/_agent".length), {
        method: request.method,
        body: request.body,
      });
    }
    await this.startAndWaitForPorts(
      [this.defaultPort, AGENT_PORT],
      portReadyOptions(this.env, request.signal),
    );
    return super.fetch(request);
  }
}

/** External-DB mode: pinned production server; releases run out-of-band. */
export class TwentyServer extends Container<Env> {
  defaultPort = 3000;
  // Active customers are kept warm by the traffic-aware cron. When there are
  // no customers, release provisioned memory/disk promptly to control cost.
  sleepAfter = "20m";

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.envVars = {
      ...sharedEnv(env),
      NODE_PORT: "3000",
      // The pinned production database is already initialized. Schema upgrade
      // and cron registration are explicit release operations, not work that
      // every beta-container restart should repeat.
      DISABLE_DB_MIGRATIONS: "true",
      DISABLE_CRON_JOBS_REGISTRATION: "true",
    };
  }

  async warm(): Promise<void> {
    await this.start();
  }

  async quiesce(): Promise<void> {
    await this.destroy();
  }

  override async fetch(request: Request): Promise<Response> {
    await this.startAndWaitForPorts(
      this.defaultPort,
      { ...PORT_READY_OPTIONS, abort: request.signal },
    );
    if (new URL(request.url).pathname === "/_cloudflare/instance")
      return Response.json({
        role: "server",
        instanceId: this.ctx.id.toString(),
      });
    return super.fetch(request);
  }
}

/** External-DB mode: BullMQ worker — same production image, no HTTP port. */
export class TwentyWorker extends Container<Env> {
  sleepAfter = "20m";
  entrypoint = ["yarn", "worker:prod"];

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.envVars = {
      ...sharedEnv(env),
      DISABLE_DB_MIGRATIONS: "true",
      DISABLE_CRON_JOBS_REGISTRATION: "true",
    };
  }

  async quiesce(): Promise<void> {
    await this.destroy();
  }

  override async fetch(_request: Request): Promise<Response> {
    const url = new URL(_request.url);
    if (url.pathname === "/_jobs/execute") {
      await this.startAndWaitForPorts(JOB_EXECUTOR_PORT, {
        ...PORT_READY_OPTIONS,
        abort: _request.signal,
      });
      const response = await this.containerFetch(
        new Request("http://job-executor/execute", {
          method: _request.method,
          headers: _request.headers,
          body: _request.body,
        }),
        JOB_EXECUTOR_PORT,
      );
      const headers = new Headers(response.headers);
      headers.set("x-cloudflare-container-instance", this.ctx.id.toString());
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    await this.start();
    return new Response("twenty-worker running");
  }
}

/**
 * Read-only PostgreSQL export companion. It runs only pg_dump + the
 * authenticated backup agent; it cannot restore into the live database and
 * does not start Twenty, BullMQ, or Redis.
 */
export class TwentyBackup extends Container<Env> {
  defaultPort = AGENT_PORT;
  sleepAfter = "10m";
  entrypoint = ["node", "/cf/agent.js"];

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.envVars = {
      BACKUP_ONLY: "true",
      ...(env.BACKUP_TOKEN ? { BACKUP_TOKEN: env.BACKUP_TOKEN } : {}),
      ...(env.PG_DATABASE_URL
        ? { PG_DATABASE_URL: env.PG_DATABASE_URL }
        : {}),
    };
  }

  override async fetch(request: Request): Promise<Response> {
    if (!this.env.PG_DATABASE_URL)
      return new Response("PG_DATABASE_URL is not configured", { status: 503 });
    const url = new URL(request.url);
    if (url.pathname !== "/_agent/dump" && url.pathname !== "/_agent/state")
      return new Response("not found", { status: 404 });
    await this.startAndWaitForPorts(
      this.defaultPort,
      { ...PORT_READY_OPTIONS, abort: request.signal },
    );
    const headers = new Headers(request.headers);
    if (this.env.BACKUP_TOKEN)
      headers.set("authorization", `Bearer ${this.env.BACKUP_TOKEN}`);
    return this.containerFetch(
      new Request(`http://backup-agent${url.pathname.slice(7)}`, {
        method: request.method,
        headers,
        signal: request.signal,
      }),
      this.defaultPort,
    );
  }
}

// The Containers SDK registers these handlers through an inherited static
// setter. A static class field shadows that setter and silently leaves the
// ContainerProxy registry empty, causing internal hostnames to fall through to
// DNS and return 530. Assign after class definition so the SDK setter runs.
TwentyContainer.outboundByHost = stateOutbound;
TwentyServer.outboundByHost = stateOutbound;
TwentyWorker.outboundByHost = stateOutbound;
