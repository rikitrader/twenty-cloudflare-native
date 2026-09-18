# Production-readiness implementation report

Date: 2026-09-17/18 UTC

This report distinguishes code that exists, configuration that is live,
verification that passed, and work that remains externally or temporally
blocked. The application is **not** declared production-ready.

## Implemented and deployed

- Deployed Worker version `3aaed4c1-6f50-45a1-968e-5e040fe3640b` at both
  `crm.mipolitico.com` and the compatibility workers.dev hostname.
- Applied D1 migrations through `0055_provider_callback_origin.sql` to both production D1
  bindings. It adds operational-continuity samples plus encrypted provider
  OAuth, refresh, sync, and message-folder state.
- Added real Google and Microsoft authorization-code + PKCE integrations,
  one-time state, provider profile validation, AES-GCM token storage,
  serialized refresh, Queue retries, calendar sync, and mail-folder sync.
- Provisioned `INTEGRATION_ENCRYPTION_KEY` as a Cloudflare secret. No secret
  value was recorded in source or evidence.
- Removed plaintext provider configuration and synthetic provider success from
  compatibility GraphQL operations. Provider-disabled actions return explicit
  errors.
- Enforced same-origin provider mutations, owner/admin connection management,
  workspace binding, remote Google revocation, local credential deletion, and
  immutable connect/disconnect audit events.
- Denied custom roles access to the legacy CRM REST API, which cannot safely
  project field/row policies. Those roles must use the policy-aware GraphQL
  record API.
- Added object/row checks to relationships, attachment read checks, fail-closed
  custom-role file/chart behavior, and owner/admin restrictions for member,
  import, export, reconciliation, migration-file, invitation, and outbox APIs.
- Added a durable 15-minute operational-continuity collector for D1 health,
  quarantined jobs, stale outbox work, and required provider connectivity.
- Added a daily read-only GitHub Actions capture that uploads 14-day evidence
  artifacts while D1 remains the authoritative 15-minute sample ledger.
- Enabled persisted Worker invocation logs, 10% persisted traces, issue
  detection, and query-string redaction.
- Added a custom-domain route so zone WAF can protect production traffic.
- Added a real Cloudflare API utility for WAF/Logpush inspection and safe
  disabled-first staging. It fails closed on missing scope or entitlement.

## Verified

- TypeScript typecheck: passed.
- Unit/integration suite: 361 passed, 3 skipped across 59 files.
- Permission/provider/continuity focused suite: 43 passed.
- Generated operation inventory: all 333 classified.
- Mutation durability audit: 233 mutations inspected, zero findings.
- Production security configuration check: passed.
- Wrangler dry run: passed with the complete binding inventory.
- Production `/healthz`: 200 with CRM D1 healthy on the custom hostname.
- Production `/_status`: correct deployed version and `productionReady=false`.
- Local isolated migration rehearsal: all 55 migrations, representative-value
  hash preservation, foreign-key/integrity checks, and immutable-copy restore
  passed.
- Remote D1 rehearsal: all 55 migrations, representative relationships,
  foreign-key checks, and Cloudflare Time Travel restore passed. No production
  or customer data was read or changed.

Evidence:

- `docs/evidence/migration-rehearsal.json`
- `docs/evidence/migration-rehearsal-remote.json`
- `docs/evidence/production-continuity-start.json`
- `docs/evidence/g10-production-security-inspection.json`
- `docs/PROVIDER-CONFIGURATION.md`
- `docs/runbooks/CLOUDFLARE-EDGE-SECURITY.md`

## Pending external access or setup

### Provider registrations

Calendar/mail code is deployed but not live-connected. Provision real provider
applications and these missing Cloudflare secrets:

- `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`
- `MICROSOFT_OAUTH_CLIENT_ID`, `MICROSOFT_OAUTH_CLIENT_SECRET`
- optional tenant restriction: `MICROSOFT_OAUTH_TENANT_ID`

Billing remains intentionally disabled. Real Stripe checkout, portal, signed
webhook reconciliation, refund, and entitlement work needs an approved Stripe
account, product/price configuration, `STRIPE_SECRET_KEY`, and
`STRIPE_WEBHOOK_SECRET`. Core CRM use does not depend on billing.

### WAF and Logpush

The custom domain prerequisite is complete. The current Wrangler OAuth grant
returns Cloudflare API 403/code 10000 for WAF/Logpush inspection and has no
WAF-edit or Logpush read/write scope. Provide the least-privilege permissions
listed in the edge-security runbook. WAF rules must be staged disabled,
observed against legitimate traffic, and enabled one at a time. Logpush also
requires a customer-owned encrypted destination, ownership validation,
retention policy, and dataset entitlement. Persisted Worker logs/traces are
live but are not claimed as Logpush.

### Production browser journeys

The repository has desktop/tablet/mobile disposable-workspace Playwright and
accessibility coverage. A fresh production journey was not claimed in this
run: project instructions require the existing signed-in Chrome profile, and
that profile was actively being used during attempted automation, preventing a
stable reproducible run. Designated non-customer owner/admin/member test
accounts also were not supplied. Complete sign-in, onboarding, CRUD,
role-navigation, integration-failure, sign-out, console, keyboard, screen
reader, contrast, and responsive journeys in that profile once a dedicated
test window and accounts are available.

### Legacy-data migration applicability

The owner confirmed on 2026-09-17 that no legacy PostgreSQL Twenty records or
attachments need to be preserved. The PostgreSQL-to-D1/R2 customer-data
cutover is therefore **not applicable**, not blocked. D1 and R2 are the initial
systems of record for this Cloudflare-native deployment. The tested migration
tooling remains available for a future explicitly authorized import, but no
source database, write freeze, or rollback owner is required for this release.

## Awaiting elapsed time

The new operational-continuity window has one real passing production sample,
captured at `2026-09-18T02:00:30.000Z`; no prior samples were synthesized. G3
session/cache continuity has 24 consecutive passing samples, 20,686,000 ms
observed, zero failures, and 584,114,000 ms remaining. The
application cannot satisfy the seven-day gate before seven real days and 673
consecutive samples exist; no historical result was fabricated.
