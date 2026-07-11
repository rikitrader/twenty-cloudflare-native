import { getContainer } from "@cloudflare/containers";
import { TwentyContainer, TwentyServer, TwentyWorker } from "./containers";
import { BackupWorkflow } from "./backup";
import { handleWebhook, consumeBatch } from "./queue";
import { bearerAuthorized } from "./lib";
import { deploymentMode, externalMode, type Env, type WebhookMessage } from "./types";

export { TwentyContainer, TwentyServer, TwentyWorker, BackupWorkflow };

const IMMUTABLE_ASSET = /\.(js|css|woff2?|png|jpe?g|svg|ico|webp)$/;
const WARMUP_CRON = "0 12 * * 1-5";

async function writeStatus(
  env: Env,
  ok: boolean,
  source: "request" | "cron",
): Promise<void> {
  await env.STATUS_KV.put(
    "status",
    JSON.stringify({
      status: ok ? "ok" : "degraded",
      mode: deploymentMode(env),
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
    const auth = request.headers.get("authorization");

    // Edge status from KV — monitors never wake the container.
    if (url.pathname === "/_status") {
      const [status, lastBackup] = await Promise.all([
        env.STATUS_KV.get("status"),
        env.STATUS_KV.get("last-backup"),
      ]);
      const body = status ? (JSON.parse(status) as Record<string, unknown>) : { status: "unknown" };
      body.lastBackup = lastBackup;
      return new Response(JSON.stringify(body), {
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
    ctx.waitUntil(writeStatus(env, response.status < 500, "request"));
    return response;
  },

  // Two crons: weekday warm-up (12 UTC) and hourly backup.
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === WARMUP_CRON) {
      if (externalMode(env)) wakeWorker(env, ctx);
      const target = externalMode(env)
        ? getContainer(env.TWENTY_SERVER, "main")
        : getContainer(env.TWENTY, "main");
      const res = await target.fetch(
        new Request(`${env.SERVER_URL.replace(/\/$/, "")}/healthz`),
      );
      await writeStatus(env, res.ok, "cron");
      return;
    }
    // Hourly backup — the workflow itself decides idle/external skips.
    await env.BACKUP_WF.create({ params: {} });
  },

  async queue(batch: MessageBatch<WebhookMessage>, env: Env): Promise<void> {
    await consumeBatch(batch, env);
  },
} satisfies ExportedHandler<Env, WebhookMessage>;
