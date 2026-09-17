# Twenty CRM — Cloudflare-native edition

This repository ports the Twenty CRM web experience to a Cloudflare-native
runtime. The upstream Twenty React frontend is served with Workers Static
Assets while application state and background work use Cloudflare services.
PostgreSQL, Redis, Hyperdrive, Containers, persistent local disks, and an
always-running Node.js server are not production dependencies.

Production: <https://twenty-crm.observatorio-publico.workers.dev>

## Architecture

- **Workers + Static Assets** — frontend, GraphQL compatibility API, REST APIs,
  authentication, webhooks, and scheduled entry points.
- **D1 (`CRM_DB`, `OPS_DB`)** — tenant-scoped CRM state, metadata, sessions,
  job receipts, operational ledgers, and migrations.
- **R2 (`STORAGE`)** — authorized attachments and streaming import/export
  artifacts.
- **Queues** — events, idempotent background jobs, retries, and dead letters.
- **Workflows** — bounded, resumable CRM imports, exports, and backups.
- **Durable Objects** — realtime delivery, scheduling, and coordinated state.
- **KV** — disposable status data only; it is never authoritative for access.
- **Workers AI and Email Service** — optional provider-backed CRM features.

Tenant identity is derived from an authenticated server-side session or API
key. A client-supplied workspace identifier is never trusted on its own.

## Status

This is an active migration, not a claim of complete upstream feature parity.
The implemented surface, remaining product gaps, production evidence, and
release gates are tracked in [`docs/FULL-PARITY-TODO.md`](docs/FULL-PARITY-TODO.md).
The deployed system must not be described as release-ready until every required
gate in that document passes.

## Local development

Prerequisites:

- Node.js 22 or newer
- npm
- A Cloudflare account for remote bindings and deployment

Install and verify:

```bash
npm ci
npm run patch:twenty
npm test
npm run typecheck
npx wrangler dev
```

The frontend patch command is deterministic and checks the compiled Twenty
module graph after applying the compatibility patches.

## Cloudflare provisioning

`wrangler.jsonc` is the binding source of truth. Before deploying into another
account, create replacement D1 databases, R2 buckets, KV namespaces, Queues,
Workflows, Durable Object migrations, Email bindings, and Access configuration,
then replace the non-secret resource identifiers and host-specific variables.

Required Worker secrets are provisioned outside Git:

```bash
npx wrangler secret put INTERNAL_SERVICE_TOKEN
npx wrangler secret put WEBHOOK_TOKEN
npx wrangler secret put OUTBOUND_WEBHOOK_SECRET
```

Provider integrations can require additional secrets documented in
[`docs/PROVIDER-CONFIGURATION.md`](docs/PROVIDER-CONFIGURATION.md). Never commit
`.env`, `.dev.vars`, credentials, database exports, attachments, or secret
values.

Apply migrations and deploy:

```bash
npx wrangler d1 migrations apply twenty-crm --remote
npx wrangler d1 migrations apply twenty-ops --remote
npm run deploy
```

`npm run deploy` deliberately executes the frontend patch, readiness gate, and
production-security inspection before `wrangler deploy`.

## Existing PostgreSQL data

The migration pipeline is read-only at the PostgreSQL source and supports
verified extraction, reconciliation, resumable D1 import, and attachment upload
to R2. A real production cutover still requires an authorized source export,
write-freeze/change-capture decision, reconciliation, rollback rehearsal, and
recorded approval. See [`docs/PRODUCTION-CUTOVER-TODO.md`](docs/PRODUCTION-CUTOVER-TODO.md).

## Operations

- Deployment and binding guide: [`docs/CLOUDFLARE-NATIVE-DEPLOY.md`](docs/CLOUDFLARE-NATIVE-DEPLOY.md)
- Recovery runbook: [`docs/runbooks/RECOVERY.md`](docs/runbooks/RECOVERY.md)
- DLQ operations: [`docs/runbooks/DLQ-OPERATIONS.md`](docs/runbooks/DLQ-OPERATIONS.md)
- Release control: [`docs/runbooks/CLOUDFLARE_RELEASE_CONTROL.md`](docs/runbooks/CLOUDFLARE_RELEASE_CONTROL.md)
- Project memory: [`docs/PROJECT-MEMORY.md`](docs/PROJECT-MEMORY.md)

## License and attribution

This repository contains and modifies Twenty source and compiled frontend
assets. Twenty's upstream licensing terms, including its AGPLv3 terms,
additional permission, package-specific MIT terms, and marked commercial files,
remain applicable. See [`LICENSE`](LICENSE) and [`NOTICE.md`](NOTICE.md).
