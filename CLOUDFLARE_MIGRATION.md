# Cloudflare-native Twenty migration

> Current verification correction (2026-09-17): the user confirms login, but
> core UI workflows are still broken. The historical implementation checklist
> below is not proof of end-to-end parity. Follow the independently checked
> [CRM repair matrix](docs/CRM-FUNCTIONAL-REPAIR-2026-09-17.md) for current status.

Baseline commit: `a200957e1a0539140949c95378b13513d62f8414`

Upstream Twenty source checkout: `/Users/ricardoprieto/projects/twenty-upstream`
at commit `2cb6c6da94e8be914aede6f2aa716f8594915d1a`. The primary server schema
and migrations are under `packages/twenty-server/src/database/typeorm/core`.
The local `feat/full-native-stack` and `feat/phase2-cf-native` branches were
also inspected; they did not contain the completed D1 CRM rewrite now shipped
from this repository.

## Selected storage architecture

The migration uses a shared D1 database (`CRM_DB`) with mandatory
`workspace_id` scoping on every CRM row. `workspace_members` is the server-side
authorization boundary. R2 remains the attachment store; Queues, Durable
Objects, and Workflows remain responsible for asynchronous work and
coordination. `OPS_DB` is retained for platform operations and is not used for
CRM records. `D1_NATIVE_MODE=true` is the only production mode.

## Implementation checklist

- [x] Repository instructions and baseline commit recorded.
- [x] Existing entry points, bindings, queues, Durable Objects,
      R2, D1 operations ledger, and Access authentication audited.
- [x] D1 schema for workspaces, membership, and contacts added.
- [x] First vertical slice added: Access identity -> membership authorization ->
      D1 contact CRUD/list -> JSON API.
- [x] Create the production `twenty-crm` D1 database (`f3c134d2-7728-4844-b1bb-8dca59ea73b7`)
      and bind it in `wrangler.jsonc`.
- [x] Register the checked-in `migrations/` directory with the `CRM_DB`
      Wrangler binding for atomic remote migration application.
- [x] Serve the upstream Twenty frontend from Workers Assets and route its
      GraphQL client to the D1 compatibility endpoint.
- [x] Make the public-workspace bootstrap null-safe for empty D1 workspaces;
      `scripts/patch-twenty-bootstrap.mjs` reapplies the generated-bundle fix
      and the live login screen has been verified in Chrome.
- [x] Handle Twenty's metadata SSE bootstrap and `/metadata` API aliases in the
      Worker so metadata requests never fall through to the SPA asset router.
- [x] Verify a disposable authenticated vertical slice against production D1:
      native signup/session, `GetCurrentUser`, tenant-scoped `CreatePerson`,
      list/read, and cross-tenant denial; remove the disposable records after
      verification.
- [~] GraphQL compatibility maps CRM CRUD, search, aggregates/charts, workspace,
      metadata, views/layouts, workflows, messaging, calendar, automation,
      settings, and auth operations; provider-dependent operations remain
      explicitly non-authoritative.
- [x] Port native sign-in/sign-up and session persistence to D1 (`native_users`,
      `native_sessions`); Cloudflare Access remains the preferred production
      identity provider.
- [x] Use the Workers-supported PBKDF2 ceiling (100,000 iterations) and cover
      native password hashing/verification with a regression test.
- [~] Port imports, exports, attachments, search, automations, and integrations
      through D1/R2/Queues. Direct attachment upload/completion is native and
      workflow jobs execute in D1. Full-workspace exports page D1 and use
      bounded R2 multipart NDJSON rather than a 10,000-row in-memory payload;
      the remaining import and provider contracts are tracked in
      `docs/FULL-PARITY-TODO.md` and the GraphQL inventory.
- [x] Build resumable PostgreSQL-to-D1/R2 migration and verification tooling.
      The separately audited
      `scripts/extract-twenty-postgres.mjs` step discovers the live workspace
      schema and exports all workspace tables plus workspace-scoped core tables
      under a `REPEATABLE READ READ ONLY` transaction with per-table checksums,
      counts, and resumable completed-table checkpoints. Credential-like
      columns are omitted unless explicitly requested.
      `scripts/reconcile-postgres-export.mjs` verifies every checksum and emits
      dependency-ordered family artifacts; `scripts/upload-reconciled-files.mjs`
      streams binary objects to tenant-scoped R2; and
      `scripts/import-reconciled-bundle.mjs` resumes each Workflow import and
      requires a persisted count/relationship/R2 reconciliation PASS.
- [~] Run preview and production security, migration, and workflow gates.
      Production security, migrations through 0052, health, signed inbound
      webhook persistence, and the signed outbound Queue round trip pass on
      the deployed Worker; the final extended
      observation/recovery rehearsal remains open.
- [x] Retire the legacy application-host and external release subsystem.

## Feature-parity matrix

| Area | Current implementation | D1-native status |
|---|---|---|
| Access authentication | Cloudflare Access JWT verification | Reused by vertical slice |
| Tenant isolation | Existing external Twenty workspace | Implemented with membership checks |
| Workspace roles | Twenty workspace permissions | Active/suspended membership and owner/admin role management implemented |
| Contacts | Legacy Twenty data model | D1 list/create/delete slice implemented |
| Companies, opportunities, activities | Legacy Twenty data model | D1 CRUD and tenant checks implemented |
| Custom objects/fields/views | Twenty metadata and PostgreSQL | D1 metadata, views, custom objects/records implemented |
| Files/attachments | R2 adapter through Twenty | D1/R2 one-time upload plus Twenty attachment record CRUD, download, and links implemented and tested |
| Async jobs/events | Queues + Durable Objects | Native D1 workflow executor with execution receipts; provider jobs fail closed |
| Search/realtime | Twenty runtime + Cloudflare adapters | Unified bounded D1 search implemented; realtime subscriptions remain adapter-backed |
| PostgreSQL/Redis | Retired | D1 is authoritative; no external database or Redis dependency |

## API contract (vertical slice)

All requests require a valid Access identity and `x-workspace-id` for a
workspace in which that identity is an active member. Native auth provisioning,
session/logout, contacts, companies, opportunities, pipelines, activities,
metadata, custom objects, relationships, files, imports, and workflow-backed
exports are exposed under `/api/auth/*` and `/api/crm/*`.

## Known blockers

The repeatable release procedure is documented in
`docs/CLOUDFLARE-NATIVE-DEPLOY.md`.

The remaining gaps include exact contract and UI verification beyond the core
record slice, plus provider-bound behavior (payment processor checkout,
external OAuth/SMTP delivery, enterprise licensing, and execution by a real AI
model). Provider actions fail explicitly. `pnpm contract:graphql:audit`
currently fails while any generated operation remains unclassified; this is a
release blocker, not an informational warning.

Production onboarding still requires either a native account created through
`/sign-up` or a Cloudflare Access application/policy for the Worker hostname;
the current Wrangler token has no Access-write scope, so Access configuration
must be performed by an account administrator.
