import { WorkerEntrypoint } from "cloudflare:workers";
import { d1Dashboard } from "./d1-dashboard";
import { cleanupExpiredFileUploads, handleD1Crm } from "./d1-crm";
import { consumeBatch, handleWebhook } from "./queue";
import { consumeJobBatch } from "./jobs";
import { BackupWorkflow } from "./backup";
import { CrmExportWorkflow, CrmImportWorkflow } from "./crm-workflow";
import { TwentyState } from "./cloudflare-state/state-do";
import { TwentyScheduler } from "./schedule-do";
import { TwentyPubSub } from "./pubsub-do";
import { Container } from "./container-compat";
import type { Env } from "./types";
import { handleGraphql } from "./graphql-compat";
import { shouldServeSpaShell, withFrontendCachePolicy } from "./frontend-assets";
import { frontendClientConfig } from "./frontend-config";
import { drainMutationOutbox } from "./crm-mutation-ledger";
import { dispatchScheduledWorkflows } from './workflow-triggers';
import { healthResponse } from "./health";
import { handleWorkflowWebhook } from './workflow-webhook';
import { handleRegisteredWebhookReceiver, handleWebhookSelfTest } from './webhook-receiver';
import { handleWebhookAdminApi, webhookAdminPage } from './webhook-admin';
import { g3SessionCacheStatus, runG3SessionCacheSample } from './g3-session-cache';
import { collectOperationalContinuity, operationalContinuityStatus } from './continuity';
import { handleProviderIntegrationApi } from './provider-integrations';

// Retain historical Durable Object class exports so existing namespaces can
// be upgraded safely. These classes are retired no-op shims; production
// traffic never binds to them.
export class TwentyServer extends Container<Env> {}
export class TwentyWorker extends Container<Env> {}
export class TwentyBackup extends Container<Env> {}
export class TwentyContainer extends Container<Env> {}
export { TwentyState, TwentyScheduler, TwentyPubSub, BackupWorkflow, CrmExportWorkflow, CrmImportWorkflow };

/** Cloudflare-native production entrypoint. Legacy Twenty runtime code is not
 * imported here and therefore cannot be bundled or reached in production. */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // Twenty's first-load bootstrap calls this REST endpoint before GraphQL.
    // Returning a same-origin config is required for the frontend to mark the
    // backend as reachable and expose the native D1 password flow.
    if (url.pathname === "/client-config" && request.method === "GET") {
      return Response.json(frontendClientConfig(url), { headers: { "cache-control": "no-store" } });
    }
    // Recover tabs that a previous expired-session race left on Twenty's
    // internal not-found route. The client-side auth callback now performs a
    // hard /welcome reset, while this redirect repairs already-open tabs on
    // their next reload.
    if (url.pathname === "/not-found" && request.method === "GET") {
      return Response.redirect(new URL("/", url).toString(), 302);
    }
    if (url.pathname === "/healthz" && request.method === "GET") {
      return healthResponse(env);
    }
    if (url.pathname === "/_status/g3" && request.method === "GET") {
      return g3SessionCacheStatus(env);
    }
    if (url.pathname === "/_status/continuity" && request.method === "GET") {
      return operationalContinuityStatus(env);
    }
    if (url.pathname === "/webhooks/twenty") return handleWebhook(request, env);
    if (url.pathname === "/webhooks/receiver") return handleRegisteredWebhookReceiver(request, env);
    if (url.pathname === "/_ops/webhooks/self-test") return handleWebhookSelfTest(request, env);
    if (url.pathname === "/_ops/webhooks" && request.method === "GET") return webhookAdminPage(request, env);
    const webhookAdmin = await handleWebhookAdminApi(request, env);
    if (webhookAdmin) return webhookAdmin;
    const providerApi = await handleProviderIntegrationApi(request, env);
    if (providerApi) return providerApi;
    const workflowWebhook=url.pathname.match(/^\/api\/workflows\/([A-Za-z0-9_-]{1,128})\/webhook$/);
    if(workflowWebhook)return handleWorkflowWebhook(request,env,workflowWebhook[1]);
    if (url.pathname === "/d1-dashboard") return d1Dashboard();
    if (url.pathname === "/_status") {
      return Response.json({
        status: "ok",
        productionReady: false,
        productionReadiness: {
          status: "gated",
          reason: "Required observation, production browser, WAF, and Logpush evidence is incomplete",
        },
        durableRedis: true,
        redisBackend: env.REDIS_BACKEND ?? "cloudflare",
        cloudflareStateReady: Boolean(env.STATE_DO),
        runtime: "cloudflare-d1",
        cloudflareVersionId: env.CF_VERSION_METADATA?.id ?? null,
        providers: {
          ai: Boolean(env.AI),
          email: Boolean(env.CRM_EMAIL && env.CRM_EMAIL_FROM),
          sso: Boolean(env.ACCESS_REQUIRED === 'true' && env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD),
          outboundWebhooks: Boolean(env.OUTBOUND_WEBHOOK_SECRET && env.WEBHOOK_ALLOWED_HOSTS),
          calendar: Boolean(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET && env.INTEGRATION_ENCRYPTION_KEY) || Boolean(env.MICROSOFT_OAUTH_CLIENT_ID && env.MICROSOFT_OAUTH_CLIENT_SECRET && env.INTEGRATION_ENCRYPTION_KEY),
          billing: Boolean(env.BILLING_PROVIDER_ENABLED === 'true' && env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET),
        },
      });
    }
    const graphql = await handleGraphql(request, env);
    if (graphql) return graphql;
    const crm = await handleD1Crm(request, env);
    if (crm) return crm;
    if (env.ASSETS) {
      const asset = await env.ASSETS.fetch(request);
      if (!shouldServeSpaShell(request, asset)) {
        return withFrontendCachePolicy(asset, url.pathname);
      }
      // Static Assets canonicalizes `/index.html` to `/`. Fetch the canonical
      // shell directly so React Router keeps the original navigation URL.
      const fallback = await env.ASSETS.fetch(new Request(new URL("/", request.url), request));
      const headers = new Headers(fallback.headers);
      headers.set("cache-control", "no-store, max-age=0");
      headers.set("pragma", "no-cache");
      return new Response(fallback.body, { status: fallback.status, statusText: fallback.statusText, headers });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
  async queue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext): Promise<void> {
    if (batch.queue === "twenty-events") return consumeBatch(batch as MessageBatch<never>, env);
    return consumeJobBatch(batch as MessageBatch<never>, env);
  },
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // Workflows own durable backup/export orchestration; cron only starts the
    // workflow and never performs blocking or filesystem work in the Worker.
    if (event.cron === '0 * * * *' && env.BACKUP_WF) ctx.waitUntil(env.BACKUP_WF.create({}));
    if (event.cron === '*/15 * * * *') {
      ctx.waitUntil(cleanupExpiredFileUploads(env));
      ctx.waitUntil(drainMutationOutbox(env));
      ctx.waitUntil(runG3SessionCacheSample(env, event.scheduledTime));
      ctx.waitUntil(collectOperationalContinuity(env, event.scheduledTime));
    }
    if (event.cron === '* * * * *') ctx.waitUntil(dispatchScheduledWorkflows(env, event.scheduledTime));
  },
};

export class NativeEntrypoint extends WorkerEntrypoint<Env> {}
