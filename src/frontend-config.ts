import { frontendDomain } from './frontend-domain';

export function frontendClientConfig(url: URL) {
  return {
    appVersion: "cloudflare-native",
    authProviders: { google: false, magicLink: false, password: true, microsoft: false, sso: [] },
    billing: { isBillingEnabled: false, billingUrl: null, stripePublishableKey: null, trialPeriods: [] },
    aiModels: [{ modelId: "@cf/meta/llama-3.1-8b-instruct-fast", label: "Cloudflare Llama 3.1 8B Fast", providerName: "cloudflare", providerLabel: "Cloudflare Workers AI", dataResidency: "Cloudflare", isDeprecated: false, maxOutputTokens: 1024 }],
    aiModelTiers: [{ tier: "fast", modelId: "@cf/meta/llama-3.1-8b-instruct-fast" }], signInPrefilled: false,
    ...frontendDomain(url.hostname), isEmailVerificationRequired: false,
    publicFunctionDomain: null,
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
    isWorkspaceSchemaDDLLocked: false, isOnboardingAiChatEnabled: true,
    // This is the authoritative production deployment. Twenty renders its
    // non-production warning for every value except PRODUCTION.
    enterpriseInstanceType: "PRODUCTION", maintenance: null,
  };
}
