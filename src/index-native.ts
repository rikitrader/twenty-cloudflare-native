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
    // Twenty's first-load bootstrap calls this REST endpoint before GraphQL.
    // Returning a same-origin config is required for the frontend to mark the
    // backend as reachable and expose the native D1 password flow.
    if (url.pathname === "/client-config" && request.method === "GET") {
      return Response.json({
        appVersion: "cloudflare-native",
        authProviders: { google: false, magicLink: false, password: true, microsoft: false, sso: [] },
        billing: { isBillingEnabled: false, billingUrl: null, stripePublishableKey: null, trialPeriods: [] },
        aiModels: [], aiModelTiers: [], signInPrefilled: false,
        isMultiWorkspaceEnabled: true, isEmailVerificationRequired: false,
        defaultSubdomain: url.hostname.split(".")[0] || "twenty-crm", frontDomain: url.hostname, publicFunctionDomain: null,
        analyticsEnabled: false, support: { supportDriver: "NONE", supportFrontChatId: null },
        isAttachmentPreviewEnabled: true, sentry: { environment: null, release: null, dsn: null, tracesSampleRate: 0 },
        captcha: { provider: null, siteKey: null }, api: { mutationMaximumAffectedRecords: 1000 },
        onboarding: null, canManageFeatureFlags: false, publicFeatureFlags: [],
        isCookieSessionEnabled: true, isMicrosoftMessagingEnabled: false,
        isMicrosoftCalendarEnabled: false, isGoogleMessagingEnabled: false,
        isGoogleCalendarEnabled: false, isConfigVariablesInDbEnabled: true,
        isImapSmtpCaldavEnabled: false, isEmailingDomainInDemoMode: false,
        allowRequestsToTwentyIcons: false, calendarBookingPageId: null,
        isBookCallOnboardingStepEnabled: false, isCompanyEnrichmentEnabled: false,
        isCloudflareIntegrationEnabled: true, isClickHouseConfigured: false,
        isWorkspaceSchemaDDLLocked: false, isOnboardingAiChatEnabled: false,
        enterpriseInstanceType: "SELF_HOSTED", maintenance: null,
      }, { headers: { "cache-control": "no-store" } });
    }
    if (url.pathname === "/d1-dashboard") return d1Dashboard();
    if (url.pathname === "/profile" || url.pathname === "/settings") return profileDashboard();
    if (url.pathname === "/_status") {
      return Response.json({
        status: "ok",
        productionReady: true,
        durableRedis: true,
        redisBackend: env.REDIS_BACKEND ?? "cloudflare",
        cloudflareStateReady: Boolean(env.STATE_DO),
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
