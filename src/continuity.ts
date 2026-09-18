import type { Env } from './types';

const REQUIRED_DURATION_MS = 7 * 24 * 60 * 60_000;
const SAMPLE_INTERVAL_MS = 15 * 60_000;
const REQUIRED_SAMPLES = REQUIRED_DURATION_MS / SAMPLE_INTERVAL_MS + 1;
const MAX_GAP_MS = 30 * 60_000;

type ProviderState = { configured: boolean; evidence: string };
type Sample = {
  id: string;
  sampledAt: string;
  workerVersion: string | null;
  crmD1Ok: boolean;
  opsD1Ok: boolean;
  newQuarantinedJobs: number;
  staleOutboxEvents: number;
  providers: Record<string, ProviderState>;
  passed: boolean;
  detail: Record<string, unknown>;
};

const count = (value: unknown) => Number((value as { count?: unknown } | null)?.count ?? 0);

export async function collectOperationalContinuity(env: Env, now = Date.now()): Promise<Sample> {
  const sampledAt = new Date(now).toISOString();
  const since = new Date(now - SAMPLE_INTERVAL_MS * 2).toISOString();
  const staleBefore = new Date(now - SAMPLE_INTERVAL_MS).toISOString();
  let crmD1Ok = false;
  let opsD1Ok = false;
  let newQuarantinedJobs = 0;
  let staleOutboxEvents = 0;
  const errors: string[] = [];
  try {
    crmD1Ok = Boolean(await env.CRM_DB?.prepare('SELECT 1 AS ok').first());
    staleOutboxEvents = count(await env.CRM_DB?.prepare("SELECT COUNT(*) AS count FROM crm_event_outbox WHERE status IN ('pending','failed') AND updated_at < ?").bind(staleBefore).first());
  } catch { errors.push('crm_d1_probe_failed'); }
  try {
    opsD1Ok = Boolean(await env.OPS_DB.prepare('SELECT 1 AS ok').first());
    newQuarantinedJobs = count(await env.OPS_DB.prepare("SELECT COUNT(*) AS count FROM job_failures WHERE status='quarantined' AND first_seen_at >= ?").bind(since).first());
  } catch { errors.push('ops_d1_probe_failed'); }
  const providers: Record<string, ProviderState> = {
    ai: { configured: Boolean(env.AI), evidence: env.AI ? 'workers_ai_binding' : 'missing_binding' },
    email: { configured: Boolean(env.CRM_EMAIL && env.CRM_EMAIL_FROM), evidence: env.CRM_EMAIL && env.CRM_EMAIL_FROM ? 'email_service_binding' : 'missing_binding_or_sender' },
    access: { configured: Boolean(env.ACCESS_REQUIRED === 'true' && env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD), evidence: env.ACCESS_REQUIRED === 'true' && env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD ? 'access_issuer_and_audience' : 'missing_access_configuration' },
    webhooks: { configured: Boolean(env.WEBHOOK_TOKEN && env.OUTBOUND_WEBHOOK_SECRET && env.WEBHOOK_ALLOWED_HOSTS), evidence: env.WEBHOOK_TOKEN && env.OUTBOUND_WEBHOOK_SECRET && env.WEBHOOK_ALLOWED_HOSTS ? 'inbound_outbound_secrets_and_allowlist' : 'missing_webhook_configuration' },
    google: { configured: Boolean(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET && env.INTEGRATION_ENCRYPTION_KEY), evidence: env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET && env.INTEGRATION_ENCRYPTION_KEY ? 'oauth_credentials_and_encryption_key' : 'not_configured' },
    microsoft: { configured: Boolean(env.MICROSOFT_OAUTH_CLIENT_ID && env.MICROSOFT_OAUTH_CLIENT_SECRET && env.INTEGRATION_ENCRYPTION_KEY), evidence: env.MICROSOFT_OAUTH_CLIENT_ID && env.MICROSOFT_OAUTH_CLIENT_SECRET && env.INTEGRATION_ENCRYPTION_KEY ? 'oauth_credentials_and_encryption_key' : 'not_configured' },
    billing: { configured: Boolean(env.BILLING_PROVIDER_ENABLED === 'true' && env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET), evidence: env.BILLING_PROVIDER_ENABLED === 'true' && env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET ? 'stripe_credentials' : 'disabled' },
  };
  const requiredProvidersReady = ['ai', 'email', 'access', 'webhooks'].every(name => providers[name].configured);
  const passed = crmD1Ok && opsD1Ok && newQuarantinedJobs === 0 && staleOutboxEvents === 0 && requiredProvidersReady;
  const sample: Sample = { id: crypto.randomUUID(), sampledAt, workerVersion: env.CF_VERSION_METADATA?.id ?? null, crmD1Ok, opsD1Ok, newQuarantinedJobs, staleOutboxEvents, providers, passed, detail: { errors, requiredProviders: ['ai','email','access','webhooks'] } };
  await env.OPS_DB.prepare('INSERT OR IGNORE INTO operational_continuity_samples (id,sampled_at,worker_version,crm_d1_ok,ops_d1_ok,new_quarantined_jobs,stale_outbox_events,providers_json,passed,detail_json) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .bind(sample.id,sampledAt,sample.workerVersion,Number(crmD1Ok),Number(opsD1Ok),newQuarantinedJobs,staleOutboxEvents,JSON.stringify(providers),Number(passed),JSON.stringify(sample.detail)).run();
  return sample;
}

export async function operationalContinuityStatus(env: Env): Promise<Response> {
  const rows = await env.OPS_DB.prepare('SELECT sampled_at as sampledAt,passed,worker_version as workerVersion,crm_d1_ok as crmD1Ok,ops_d1_ok as opsD1Ok,new_quarantined_jobs as newQuarantinedJobs,stale_outbox_events as staleOutboxEvents,providers_json as providers FROM operational_continuity_samples ORDER BY sampled_at DESC LIMIT ?').bind(REQUIRED_SAMPLES + 32).all<Record<string, unknown>>();
  const ordered = [...rows.results].reverse();
  let window: Record<string, unknown>[] = [];
  for (const row of ordered) {
    if (Number(row.passed) !== 1) { window = []; continue; }
    const prior = window.at(-1);
    if (prior && Date.parse(String(row.sampledAt)) - Date.parse(String(prior.sampledAt)) > MAX_GAP_MS) window = [];
    window.push(row);
  }
  const first = window[0]; const last = window.at(-1);
  const durationMs = first && last ? Math.max(0,Date.parse(String(last.sampledAt))-Date.parse(String(first.sampledAt))) : 0;
  const ready = window.length >= REQUIRED_SAMPLES && durationMs >= REQUIRED_DURATION_MS;
  const latest = rows.results[0];
  return Response.json({ gate:'operational-continuity',status:ready?'passed':'collecting',ready,requiredSamples:REQUIRED_SAMPLES,consecutivePassedSamples:window.length,requiredDurationMs:REQUIRED_DURATION_MS,durationMs,maxAllowedGapMs:MAX_GAP_MS,windowStartedAt:first?.sampledAt??null,lastSampledAt:last?.sampledAt??null,latest:latest?{...latest,providers:JSON.parse(String(latest.providers??'{}'))}:null },{headers:{'cache-control':'no-store'}});
}
