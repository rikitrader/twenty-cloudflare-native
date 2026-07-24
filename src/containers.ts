import { Container } from "@cloudflare/containers";
import type { Env } from "./types";
import { pickLatest } from "./lib";

export const AGENT_PORT = 2021;
const PORT_READY_OPTIONS = {
  portReadyTimeoutMS: 120_000,
  instanceGetTimeoutMS: 120_000,
  waitInterval: 500,
} as const;

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
    ...secretsEnv(env),
    ...(env.PG_DATABASE_URL ? { PG_DATABASE_URL: env.PG_DATABASE_URL } : {}),
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
      ...secretsEnv(env),
      ...(env.BACKUP_TOKEN ? { BACKUP_TOKEN: env.BACKUP_TOKEN } : {}),
      ...(externalPg
        ? {
            PG_DATABASE_URL: env.PG_DATABASE_URL!,
            // Neon is migrated once, out-of-band (RUN_NEON_INIT=true for a one-shot).
            // Every normal boot skips init-db — re-seeding demo data over a remote
            // DB per-row is pathologically slow and blocks twenty-server from :2020.
            DISABLE_DB_MIGRATIONS: env.RUN_NEON_INIT === "true" ? "false" : "true",
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
    await this.startAndWaitForPorts(
      [this.defaultPort, AGENT_PORT],
      { ...PORT_READY_OPTIONS, abort: request.signal },
    );
    const url = new URL(request.url);
    if (url.pathname.startsWith("/_agent/")) {
      return this.agentFetch(url.pathname.slice("/_agent".length), {
        method: request.method,
        body: request.body,
      });
    }
    return super.fetch(request);
  }
}

/** External-DB mode: stock server image (runs migrations + cron registration). */
export class TwentyServer extends Container<Env> {
  defaultPort = 3000;
  sleepAfter = "2h";

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.envVars = { ...sharedEnv(env), NODE_PORT: "3000" };
  }

  override async fetch(request: Request): Promise<Response> {
    await this.startAndWaitForPorts(
      this.defaultPort,
      { ...PORT_READY_OPTIONS, abort: request.signal },
    );
    return super.fetch(request);
  }
}

/** External-DB mode: BullMQ worker — same image, worker entrypoint, no HTTP port. */
export class TwentyWorker extends Container<Env> {
  sleepAfter = "2h";
  entrypoint = ["yarn", "worker:prod"];

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.envVars = {
      ...sharedEnv(env),
      DISABLE_DB_MIGRATIONS: "true",
      DISABLE_CRON_JOBS_REGISTRATION: "true",
    };
  }

  override async fetch(_request: Request): Promise<Response> {
    await this.start();
    return new Response("twenty-worker running");
  }
}
