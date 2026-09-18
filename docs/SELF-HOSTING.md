# Self-hosting in your Cloudflare account

This project is a Cloudflare-native application. A normal production runtime
does not require PostgreSQL, Redis, Hyperdrive, Containers, an always-running
Node.js server, or persistent local disk.

## 1. Fork and configure

Fork the repository, clone your fork, install Node.js 22+, and run `npm ci`.
Use `wrangler.example.jsonc` as the portable binding inventory. Copy it to the
configuration used by your environment and replace every value containing
`replace`, every all-zero identifier, and every `example.com` address.
Do not copy resource IDs or Access audiences from the reference deployment.

For a new account, keep the example's single Durable Object migration. The
production `wrangler.jsonc` intentionally retains historical migration tags
from the reference account and is not a portable Durable Object history.

## 2. Provision resources

Create unique resources for each environment:

| Binding | Resource | Purpose |
|---|---|---|
| `CRM_DB` | D1 | CRM records, metadata, memberships, sessions, permissions |
| `OPS_DB` | D1 | jobs, webhooks, releases, continuity and operational evidence |
| `STORAGE` | R2 | attachments, imports, exports and backups |
| `STATUS_KV` | KV | disposable status cache |
| `EVENTS_QUEUE` | Queue | asynchronous event ingestion |
| `JOBS_QUEUE` | Queue | background jobs and provider synchronization |
| `JOBS_DLQ` | Queue | terminal job failures and replay |
| `STATE_DO` | Durable Object | strongly coordinated state |
| `SCHEDULER_DO` | Durable Object | schedules and serialized execution |
| `PUBSUB_DO` | Durable Object | realtime fan-out |
| `BACKUP_WF` | Workflow | resumable backups |
| `CRM_EXPORT_WF` | Workflow | streaming exports |
| `CRM_IMPORT_WF` | Workflow | resumable imports |
| `AI` | Workers AI | optional CRM AI chat |
| `CRM_EMAIL` | Email Service | optional application email |
| `OPS_ALERT_EMAIL` | Email Service | optional operator alerts |

Wrangler can create and list account resources. Record the returned IDs only
in your environment configuration; they are identifiers, not credentials.

```bash
npx wrangler login
npx wrangler d1 create YOUR_CRM_DB
npx wrangler d1 create YOUR_OPS_DB
npx wrangler r2 bucket create YOUR_STORAGE_BUCKET
npx wrangler kv namespace create YOUR_STATUS_NAMESPACE
npx wrangler queues create YOUR_EVENTS_QUEUE
npx wrangler queues create YOUR_EVENTS_DLQ
npx wrangler queues create YOUR_JOBS_QUEUE
npx wrangler queues create YOUR_JOBS_DLQ
```

Workflow and Durable Object bindings are provisioned from the validated
Wrangler configuration during deployment. Configure Email Service, Access,
the custom hostname, WAF, and Logpush in the destination account as applicable.

If you do not use an optional binding, remove it from the config and keep the
corresponding product feature disabled. Do not replace missing providers with
mock success responses.

## 3. Configure authentication

For an internet-facing deployment, configure Cloudflare Access and replace:

- `ACCESS_TEAM_DOMAIN`
- `ACCESS_AUD`
- `SERVER_URL`
- the custom-domain route

Set `AUTO_PROVISION_ACCESS_MEMBERS=false` unless automatic Access-subject
membership is explicitly intended. Application permissions remain enforced in
the Worker even when Access is enabled; WAF and Access do not replace tenant
authorization.

## 4. Provision secrets

Generate new values for every fork. Never reuse the reference deployment's
secrets.

```bash
npx wrangler secret put INTERNAL_SERVICE_TOKEN
npx wrangler secret put WEBHOOK_TOKEN
npx wrangler secret put OUTBOUND_WEBHOOK_SECRET
npx wrangler secret put INTEGRATION_ENCRYPTION_KEY
```

`INTEGRATION_ENCRYPTION_KEY` must satisfy the exact format documented in
`docs/PROVIDER-CONFIGURATION.md`. Provider-specific Google and Microsoft
credentials are optional. Keep all values out of Git, logs, issue reports, and
browser bundles.

## 5. Initialize databases

Apply all migrations to both bindings before deploying code:

```bash
npx wrangler d1 migrations apply CRM_DB --remote
npx wrangler d1 migrations apply OPS_DB --remote
```

D1 is the initial system of record for a new installation. The PostgreSQL
extractor is optional tooling for an explicitly authorized legacy import; it
is not required for a fresh deployment.

## 6. Verify and deploy

```bash
npm run patch:twenty
npm run typecheck
npm test
npm run db:migrations:check
npm run audit:mutations
npm run security:production:check
npx wrangler deploy
```

`npm run deploy` additionally requires every production-readiness gate to be
complete. This is deliberate. During initial installation, use direct Wrangler
deployment only after reviewing the open gates and without changing their
evidence to manufacture a pass.

## 7. Post-deployment checks

Verify:

- `/healthz` returns the expected Worker version and healthy D1 state.
- `/_status` truthfully reports configured and disabled providers.
- sign-in, onboarding, tenant isolation, CRUD, files and sign-out work with
  designated non-customer test accounts;
- Queue jobs are durably accepted and terminal failures reach the DLQ;
- R2 downloads require tenant ownership;
- scheduled continuity samples accumulate without fabricated history;
- WAF rules are observed before enforcement and Logpush reaches the intended
  retained destination.

Use the runbooks under `docs/runbooks/` for recovery, rollback, DLQ replay,
edge security, and release control.

## GitHub Actions

The verification workflow runs without production credentials. The deployment
workflow is manual and expects repository/environment secrets named:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Use a least-privilege deployment token scoped to resources in the destination
account. Protect the `production` GitHub environment with required reviewers.
