import { Container, getContainer } from "@cloudflare/containers";

interface Env {
  // Demo mode: official all-in-one image (Postgres + Redis + server + worker).
  TWENTY: DurableObjectNamespace<TwentyContainer>;
  // External-DB mode: stock image, one class per process (mirrors upstream docker-compose).
  TWENTY_SERVER: DurableObjectNamespace<TwentyServer>;
  TWENTY_WORKER: DurableObjectNamespace<TwentyWorker>;
  STATUS_KV: KVNamespace;
  STORAGE: R2Bucket;
  SERVER_URL: string;
  APP_SECRET?: string;
  // Secrets — setting both flips the deployment to external-DB mode on the next request.
  PG_DATABASE_URL?: string; // Neon/Supabase (optionally via Hyperdrive)
  REDIS_URL?: string; // Upstash (rediss://)
  // Secrets — setting these moves attachments to R2 via Twenty's native S3 driver.
  STORAGE_S3_ENDPOINT?: string; // https://<account_id>.r2.cloudflarestorage.com
  STORAGE_S3_NAME?: string;
  STORAGE_S3_REGION?: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
}

const externalMode = (env: Env) =>
  Boolean(env.PG_DATABASE_URL && env.REDIS_URL);

function sharedEnv(env: Env): Record<string, string> {
  return {
    SERVER_URL: env.SERVER_URL,
    ...(env.APP_SECRET ? { APP_SECRET: env.APP_SECRET } : {}),
    ...(env.PG_DATABASE_URL ? { PG_DATABASE_URL: env.PG_DATABASE_URL } : {}),
    ...(env.REDIS_URL ? { REDIS_URL: env.REDIS_URL } : {}),
    ...(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY && env.STORAGE_S3_ENDPOINT
      ? {
          STORAGE_TYPE: "s3",
          STORAGE_S3_NAME: env.STORAGE_S3_NAME ?? "twenty-storage",
          STORAGE_S3_ENDPOINT: env.STORAGE_S3_ENDPOINT,
          STORAGE_S3_REGION: env.STORAGE_S3_REGION ?? "auto",
          AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID,
          AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY,
        }
      : {}),
  };
}

/** Demo mode: twentycrm/twenty-app-dev — everything in one box, ephemeral data. */
export class TwentyContainer extends Container<Env> {
  defaultPort = 2020;
  sleepAfter = "2h";

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.envVars = {
      SERVER_URL: env.SERVER_URL,
      ...(env.APP_SECRET ? { APP_SECRET: env.APP_SECRET } : {}),
    };
  }
}

/** External-DB mode: stock twentycrm/twenty NestJS server (runs migrations + cron registration). */
export class TwentyServer extends Container<Env> {
  defaultPort = 3000;
  sleepAfter = "2h";

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.envVars = { ...sharedEnv(env), NODE_PORT: "3000" };
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
      // Upstream compose: server owns migrations and cron registration.
      DISABLE_DB_MIGRATIONS: "true",
      DISABLE_CRON_JOBS_REGISTRATION: "true",
    };
  }

  override async fetch(_request: Request): Promise<Response> {
    // No port to proxy — /_wake just ensures the process is running.
    await this.start();
    return new Response("twenty-worker running");
  }
}

const IMMUTABLE_ASSET = /\.(js|css|woff2?|png|jpe?g|svg|ico|webp)$/;

async function writeStatus(
  env: Env,
  ok: boolean,
  source: "request" | "cron",
): Promise<void> {
  await env.STATUS_KV.put(
    "status",
    JSON.stringify({
      status: ok ? "ok" : "degraded",
      mode: externalMode(env) ? "external-db" : "all-in-one",
      checked: new Date().toISOString(),
      source,
    }),
  );
}

function wakeWorker(env: Env, ctx: ExecutionContext): void {
  ctx.waitUntil(
    getContainer(env.TWENTY_WORKER, "main").fetch(
      new Request("http://twenty-worker/_wake"),
    ),
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Served from KV at the edge — health monitors never wake the container.
    if (url.pathname === "/_status") {
      const status = await env.STATUS_KV.get("status");
      return new Response(status ?? '{"status":"unknown"}', {
        headers: { "content-type": "application/json" },
      });
    }

    // Edge cache (Cloudflare Cache API) for the frontend's immutable assets.
    const cacheable = request.method === "GET" && IMMUTABLE_ASSET.test(url.pathname);
    if (cacheable) {
      const hit = await caches.default.match(request);
      if (hit) return hit;
    }

    let response: Response;
    if (externalMode(env)) {
      wakeWorker(env, ctx); // background jobs come up alongside the server
      response = await getContainer(env.TWENTY_SERVER, "main").fetch(request);
    } else {
      response = await getContainer(env.TWENTY, "main").fetch(request);
    }

    if (cacheable && response.ok) {
      ctx.waitUntil(caches.default.put(request, response.clone()));
    }
    ctx.waitUntil(writeStatus(env, response.status < 500, "request"));
    return response;
  },

  // Weekday-morning warm-up so the first user never eats the cold boot,
  // plus a fresh /_status snapshot into KV.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (externalMode(env)) wakeWorker(env, ctx);
    const target = externalMode(env)
      ? getContainer(env.TWENTY_SERVER, "main")
      : getContainer(env.TWENTY, "main");
    const res = await target.fetch(new Request(`${env.SERVER_URL.replace(/\/$/, "")}/healthz`));
    await writeStatus(env, res.ok, "cron");
  },
} satisfies ExportedHandler<Env>;
