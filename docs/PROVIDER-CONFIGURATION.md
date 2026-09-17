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
exact allowlisted hostname is `twenty-crm.observatorio-publico.workers.dev`.
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

Google and Microsoft require externally registered OAuth applications with exact
production redirect URIs. Required credentials include client IDs and client
secrets. Do not store provider refresh tokens in `integration_accounts.config_json`;
encrypted token storage and refresh serialization must be deployed before these
providers are enabled.

## Billing

Billing intentionally remains disabled. Activation requires an authoritative
processor registration, product/price identifiers, a restricted API secret, and
a signed webhook secret. Checkout, portal, entitlements, refunds, and
reconciliation must use processor state rather than client input.

No secret value belongs in this repository, frontend assets, logs, or D1 export
artifacts. Provision production secrets with `wrangler secret put` or Cloudflare
Secrets Store.
