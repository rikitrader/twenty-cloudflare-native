# Cloudflare-native Twenty migration

Baseline commit: `a200957e1a0539140949c95378b13513d62f8414`

Upstream Twenty source checkout: `/Users/ricardoprieto/projects/twenty-upstream`
at commit `2cb6c6da94e8be914aede6f2aa716f8594915d1a`. The primary server schema
and migrations are under `packages/twenty-server/src/database/typeorm/core`.
The local `feat/full-native-stack` and `feat/phase2-cf-native` branches were
also inspected; they complete Cloudflare runtime/Redis adapters but do not
contain a PostgreSQL-to-D1 CRM rewrite.

## Selected storage architecture

The migration uses a shared D1 database (`CRM_DB`) with mandatory
`workspace_id` scoping on every CRM row. `workspace_members` is the server-side
authorization boundary. R2 remains the attachment store; Queues, Durable
Objects, and Workflows remain responsible for asynchronous work and
coordination. `OPS_DB` is retained for platform operations and is not used for
CRM records. `D1_NATIVE_MODE=true` is the only production mode; the former
Neon/container path has been retired.

## Implementation checklist

- [x] Repository instructions and baseline commit recorded.
- [x] Existing entry points, bindings, containers, queues, Durable Objects,
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
- [~] GraphQL compatibility maps CRM CRUD, search, aggregates/charts, workspace,
      metadata, views/layouts, workflows, messaging, calendar, automation,
      settings, and auth operations; provider-dependent operations remain
      explicitly non-authoritative.
- [x] Port native sign-in/sign-up and session persistence to D1 (`native_users`,
      `native_sessions`); Cloudflare Access remains the preferred production
      identity provider.
- [x] Use the Workers-supported PBKDF2 ceiling (100,000 iterations) and cover
      native password hashing/verification with a regression test.
- [x] Port imports, exports, attachments, search, automations, and integrations
      through D1/R2/Queues; external delivery providers remain optional.
- [~] Build resumable PostgreSQL-to-D1/R2 migration and verification tooling
      (`scripts/migrate-crm-ndjson.mjs` provides dry-run, resumable state,
      bounded batches, and replay-safe request IDs; PostgreSQL extraction is
      intentionally a separately audited read-only export step).
- [ ] Run preview and production security, migration, and workflow gates.
- [x] Retire PostgreSQL containers and the external release subsystem.

## Feature-parity matrix

| Area | Current implementation | D1-native status |
|---|---|---|
| Access authentication | Cloudflare Access JWT verification | Reused by vertical slice |
| Tenant isolation | Existing external Twenty workspace | Implemented with membership checks |
| Workspace roles | Twenty workspace permissions | Active/suspended membership and owner/admin role management implemented |
| Contacts | Twenty PostgreSQL container | D1 list/create/delete slice implemented |
| Companies, opportunities, activities | Twenty PostgreSQL container | D1 CRUD and tenant checks implemented |
| Custom objects/fields/views | Twenty metadata and PostgreSQL | D1 metadata, views, custom objects/records implemented |
| Files/attachments | R2 adapter through Twenty | D1/R2 authorized upload, download, links implemented |
| Async jobs/events | Queues + Durable Objects | Existing infrastructure retained |
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

The remaining gaps are provider-bound behavior (payment processor checkout,
external OAuth/SMTP delivery, enterprise licensing, and execution by a real AI
model). Those operations are intentionally explicit and non-authoritative;
core voter/member CRM workflows are D1-authoritative.

Production onboarding still requires either a native account created through
`/sign-up` or a Cloudflare Access application/policy for the Worker hostname;
the current Wrangler token has no Access-write scope, so Access configuration
must be performed by an account administrator.
