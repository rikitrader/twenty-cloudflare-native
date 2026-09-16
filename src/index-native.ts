import { WorkerEntrypoint } from "cloudflare:workers";
import { d1Dashboard } from "./d1-dashboard";
import { profileDashboard } from "./profile-dashboard";
import { handleD1Crm } from "./d1-crm";
import { consumeBatch } from "./queue";
import { consumeJobBatch } from "./jobs";
import { BackupWorkflow } from "./backup";
import { CrmExportWorkflow } from "./crm-workflow";
import { TwentyState } from "./cloudflare-state/state-do";
import { TwentyScheduler } from "./schedule-do";
import { TwentyPubSub } from "./pubsub-do";
import { Container } from "./container-compat";
import type { Env } from "./types";
import { handleGraphql } from "./graphql-compat";

// Retain historical Durable Object class exports so existing namespaces can
// be upgraded safely. These classes are retired no-op shims; production
// traffic never binds to them.
export class TwentyServer extends Container<Env> {}
export class TwentyWorker extends Container<Env> {}
export class TwentyBackup extends Container<Env> {}
export class TwentyContainer extends Container<Env> {}
export { TwentyState, TwentyScheduler, TwentyPubSub, BackupWorkflow, CrmExportWorkflow };

/** Cloudflare-native production entrypoint. Legacy Twenty runtime code is not
 * imported here and therefore cannot be bundled or reached in production. */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/d1-dashboard") return d1Dashboard();
    if (url.pathname === "/profile" || url.pathname === "/settings") return profileDashboard();
    if (url.pathname === "/_status") {
      return Response.json({
        status: "ok",
        productionReady: true,
        runtime: "cloudflare-d1",
        cloudflareVersionId: env.CF_VERSION_METADATA?.id ?? null,
      });
    }
    const graphql = await handleGraphql(request, env);
    if (graphql) return graphql;
    const crm = await handleD1Crm(request, env);
    if (crm) return crm;
    if (env.ASSETS) {
      const asset = await env.ASSETS.fetch(request);
      if (asset.status !== 404 || request.method !== "GET") return asset;
      return env.ASSETS.fetch(new Request(new URL("/index.html", request.url), request));
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
  async queue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext): Promise<void> {
    if (batch.queue === "twenty-events") return consumeBatch(batch as MessageBatch<never>, env);
    return consumeJobBatch(batch as MessageBatch<never>, env);
  },
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // Workflows own durable backup/export orchestration; cron only starts the
    // workflow and never performs blocking or filesystem work in the Worker.
    if (env.BACKUP_WF) ctx.waitUntil(env.BACKUP_WF.create({}));
  },
};

export class NativeEntrypoint extends WorkerEntrypoint<Env> {}
