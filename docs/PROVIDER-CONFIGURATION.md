# Provider configuration

The Worker reports provider readiness at `/_status`. Provider features fail
closed until every required registration and secret exists.

## Live Cloudflare-native providers

- AI: Workers AI binding `AI`; server model `AI_MODEL`.
- Transactional email: Email Service binding `CRM_EMAIL`; verified sender
  `CRM_EMAIL_FROM=crm@mipolitico.com`.
- SSO boundary: Cloudflare Access using `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`.

## Outbound and inbound webhooks

Required secrets:

- `WEBHOOK_TOKEN`: shared secret registered by the external Twenty sender.
- `OUTBOUND_WEBHOOK_SECRET`: HMAC secret shared with outbound receivers.

Required non-secret variable:

- `WEBHOOK_ALLOWED_HOSTS`: comma-separated exact HTTPS receiver hostnames.

The controlled production receiver is
`https://twenty-crm.observatorio-publico.workers.dev/webhooks/receiver`; the
allowlist contains only `twenty-crm.observatorio-publico.workers.dev` and
`crm.mipolitico.com`.
`POST /_ops/webhooks/self-test` registers that receiver for one workspace and
queues a signed round trip; it requires an authenticated workspace owner/admin
session or a workspace-scoped admin API key.
The receiver validates `OUTBOUND_WEBHOOK_SECRET`, stores a deduplicated receipt,
and never republishes the event (preventing a webhook loop).

Production status: both secrets are provisioned and the exact host is active.
The public inbound sender test returned 202 and was persisted in OPS D1. The
outbound Queue test delivered event `db7245a0-6066-46f1-8082-ee436b4e027a`
with response 202 and a matching deduplicated receiver receipt. Cloudflare does
not reliably permit a Worker Queue consumer to fetch its own `workers.dev`
hostname, so the registered same-Worker receiver uses a signed in-process
loopback through the identical validation/persistence handler. Other allowlisted
HTTPS receivers continue through bounded external `fetch` delivery.

Outbound delivery remains disabled when the secret or host allowlist is absent.
Never reuse either generated secret outside its documented direction.

## Calendar and mailbox OAuth

The Worker implements authorization-code + PKCE, one-time/replay-resistant
state, provider profile validation, AES-GCM token storage, serialized refresh,
bounded Queue retries, Gmail label / Microsoft mail-folder synchronization,
and Google / Microsoft calendar synchronization. Provider tokens are never
stored in `integration_accounts.config_json`, returned to the browser, or
written to logs.

The shared production encryption secret `INTEGRATION_ENCRYPTION_KEY` is
provisioned. Provider registration is still externally blocked because the
following Cloudflare secrets do not exist:

- Google: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`.
- Microsoft: `MICROSOFT_OAUTH_CLIENT_ID`,
  `MICROSOFT_OAUTH_CLIENT_SECRET`.
- Optional Microsoft tenant restriction:
  `MICROSOFT_OAUTH_TENANT_ID` (defaults to `common`).

Register these exact callbacks at the providers:

- `https://twenty-crm.observatorio-publico.workers.dev/api/integrations/oauth/google/callback`
- `https://twenty-crm.observatorio-publico.workers.dev/api/integrations/oauth/microsoft/callback`
- `https://crm.mipolitico.com/api/integrations/oauth/google/callback`
- `https://crm.mipolitico.com/api/integrations/oauth/microsoft/callback`

The OAuth state stores and validates the initiating origin, so the callback and
post-connect redirect stay on the hostname that owns the user's host-only
session cookie.

After credentials are provisioned, an owner/admin starts connection at
`POST /api/integrations/oauth/{provider}/start`; the callback validates the
same logged-in actor and workspace. `POST /api/integrations/{accountId}/sync`
durably queues synchronization. `POST /api/integrations/{accountId}/disconnect` revokes
Google remotely before local deletion; Microsoft documents local disconnect
because that provider does not expose an equivalent token-revocation endpoint.

## Billing

Billing intentionally remains disabled. Activation requires an authoritative
processor registration, product/price identifiers, a restricted API secret, and
a signed webhook secret. Checkout, portal, entitlements, refunds, and
reconciliation must use processor state rather than client input.

The absent names are `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`;
`BILLING_PROVIDER_ENABLED` must remain unset/false until real checkout, portal,
signed event reconciliation, refunds, and entitlement tests pass. No billing
mutation may report success while this gate is closed.

No secret value belongs in this repository, frontend assets, logs, or D1 export
artifacts. Provision production secrets with `wrangler secret put` or Cloudflare
Secrets Store.
