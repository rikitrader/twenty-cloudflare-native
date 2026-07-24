import { getContainer } from "@cloudflare/containers";
import { TwentyContainer, TwentyServer, TwentyWorker } from "./containers";
import { BackupWorkflow } from "./backup";
import { handleWebhook, consumeBatch } from "./queue";
import {
  bearerAuthorized,
  evaluateOperationalStatus,
  shouldWriteStatus,
} from "./lib";
import { deploymentMode, externalMode, type Env, type WebhookMessage } from "./types";

export { TwentyContainer, TwentyServer, TwentyWorker, BackupWorkflow };

const IMMUTABLE_ASSET = /\.(js|css|woff2?|png|jpe?g|svg|ico|webp)$/;
const BACKUP_CRON = "0 * * * *";
const STATUS_WRITE_INTERVAL_MS = 60_000;
let lastStatusWriteMs = 0;
let lastStatusOk: boolean | undefined;

async function writeStatus(
  env: Env,
  ok: boolean,
  source: "request" | "cron",
  force = false,
): Promise<void> {
  const now = Date.now();
  if (
    !force &&
    !shouldWriteStatus(
      now,
      lastStatusWriteMs,
      ok,
      lastStatusOk,
      STATUS_WRITE_INTERVAL_MS,
    )
  )
    return;

  // Reserve this interval before the asynchronous put so concurrent requests
  // coalesce instead of all racing the same KV key.
  lastStatusWriteMs = now;
  lastStatusOk = ok;
  try {
    await env.STATUS_KV.put(
      "status",
      JSON.stringify({
        status: ok ? "ok" : "degraded",
        mode: deploymentMode(env),
        checked: new Date(now).toISOString(),
        source,
      }),
    );
  } catch (error) {
    console.warn("status KV write failed", error);
  }
}

function workerHealth(env: Env): Promise<Response> {
  return getContainer(env.TWENTY_WORKER, "main").fetch(
    new Request("http://twenty-worker/_wake"),
  );
}

function wakeWorker(env: Env, ctx: ExecutionContext): void {
  ctx.waitUntil(workerHealth(env));
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const auth = request.headers.get("authorization");

    // Edge status from KV — monitors never wake the container.
    if (url.pathname === "/_status") {
      const [status, lastBackupAttempt, lastBackup, lastBackupError] =
        await Promise.all([
          env.STATUS_KV.get("status"),
          env.STATUS_KV.get("last-backup-attempt"),
          env.STATUS_KV.get("last-backup"),
          env.STATUS_KV.get("last-backup-error"),
        ]);
      const body = status ? (JSON.parse(status) as Record<string, unknown>) : { status: "unknown" };
      body.lastBackupAttempt = lastBackupAttempt;
      body.lastBackup = lastBackup;
      body.lastBackupError = lastBackupError;
      body.productionReady = externalMode(env);
      body.durableRedis = externalMode(env);
      const operational = evaluateOperationalStatus(Date.now(), {
        reportedStatus: body.status,
        checkedIso: body.checked,
        lastBackupIso: lastBackup,
        lastBackupError,
        backupRequired: true,
      });
      body.status = operational.status;
      body.reasons = operational.reasons;
      return new Response(JSON.stringify(body), {
        status: operational.status === "ok" ? 200 : 503,
        headers: { "content-type": "application/json" },
      });
    }

    // Manual backup trigger (token-guarded).
    if (url.pathname === "/_backup/run" && request.method === "POST") {
      if (!bearerAuthorized(auth, env.BACKUP_TOKEN))
        return new Response("unauthorized", { status: 401 });
      const instance = await env.BACKUP_WF.create({ params: { force: true } });
      return new Response(JSON.stringify({ workflow: instance.id }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    }

    // Container-side backup agent — token-guarded from the public edge.
    if (url.pathname.startsWith("/_agent/")) {
      if (!bearerAuthorized(auth, env.BACKUP_TOKEN))
        return new Response("unauthorized", { status: 401 });
      return getContainer(env.TWENTY, "main").fetch(request);
    }

    // Twenty webhooks → Queue → D1.
    if (url.pathname === "/webhooks/twenty") return handleWebhook(request, env);

    // Edge cache for immutable frontend assets.
    const cacheable = request.method === "GET" && IMMUTABLE_ASSET.test(url.pathname);
    if (cacheable) {
      const hit = await caches.default.match(request);
      if (hit) return hit;
    }

    let response: Response;
    if (externalMode(env)) {
      wakeWorker(env, ctx);
      response = await getContainer(env.TWENTY_SERVER, "main").fetch(request);
    } else {
      response = await getContainer(env.TWENTY, "main").fetch(request);
    }

    if (cacheable && response.ok) {
      ctx.waitUntil(caches.default.put(request, response.clone()));
    }
    // Static assets can generate hundreds of requests during one page load.
    // Dynamic traffic is sufficient for health and backup-idle tracking.
    if (!cacheable)
      ctx.waitUntil(writeStatus(env, response.status < 500, "request"));
    return response;
  },

  // Five-minute active health probe plus hourly backup.
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === BACKUP_CRON) {
      await env.BACKUP_WF.create({ params: {} });
      return;
    }

    const workerOk = externalMode(env)
      ? (await workerHealth(env)).ok
      : true;
    const target = externalMode(env)
      ? getContainer(env.TWENTY_SERVER, "main")
      : getContainer(env.TWENTY, "main");
    const res = await target.fetch(
      new Request(`${env.SERVER_URL.replace(/\/$/, "")}/healthz`),
    );
    await writeStatus(env, res.ok && workerOk, "cron", true);
  },

  async queue(batch: MessageBatch<WebhookMessage>, env: Env): Promise<void> {
    await consumeBatch(batch, env);
  },
} satisfies ExportedHandler<Env, WebhookMessage>;
