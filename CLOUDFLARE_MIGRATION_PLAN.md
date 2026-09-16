# Twenty → Cloudflare-native migration plan

Baseline adapter commit: `a200957e1a0539140949c95378b13513d62f8414`
Upstream source: `/Users/ricardoprieto/projects/twenty-upstream`

## Design decisions

- [x] Cloudflare Worker is the public API and static-asset boundary.
- [x] D1 is the canonical relational store for migrated CRM data.
- [x] Shared D1 database with mandatory `workspace_id` predicates and a
      membership table is the initial tenant architecture.
- [x] R2 stores attachments, imports, exports, and backup artifacts.
- [x] Queues provide at-least-once asynchronous delivery; consumers are
      idempotent and use a dead-letter queue.
- [x] Durable Objects provide serialized per-workspace coordination and
      realtime state; KV is cache/configuration only.
- [x] Workflows handle long-running imports, exports, and migration batches.
- [x] Neon/PostgreSQL and Containers remain rollback infrastructure until all
      parity gates pass.

## Delivery checklist

### Audit

- [x] Record adapter baseline and upstream source revision.
- [x] Inventory server/frontend entry points and bindings.
- [x] Inventory PostgreSQL TypeORM entities and workspace migrations.
- [x] Inventory Redis, BullMQ, sessions, storage, search, realtime, and cron.
- [ ] Map every API and UI workflow to a native replacement.

### Foundation

- [x] Add typed `CRM_DB` binding and opt-in `D1_NATIVE_MODE`.
- [x] Add workspace and membership authorization boundary.
- [x] Add Node-native D1 migration runner/checks for CRM schema (no Bun
      dependency required).
- [x] Validate migration ordering and SQLite syntax locally across migrations
      `0001` through `0013`.
- [x] Implement contacts CRUD vertical slice.
- [~] Add common repository/query/filter/pagination primitives (bounded
      workspace-scoped list primitives are implemented in the native handler;
      shared repository extraction remains).
- [x] Add request correlation, same-origin mutation protection, rate limits,
      and tenant-scoped audit events.

### Core CRM parity

- [~] People/contacts, companies, opportunities, pipelines (D1 schema plus
      contacts/companies/opportunities list/create APIs; pipeline CRUD pending).
- [ ] Tasks, notes, calls, emails, and timeline activities.
- [~] Relationships and ownership with atomic updates (tenant-scoped
      relationship creation and bidirectional lookup implemented; ownership
      assignment is persisted and validated against active members).
- [~] Custom fields, metadata, saved views, and filters (definitions, views,
      and contact custom-value validation/projection implemented; broader
      record projection and custom objects remain).
- [~] Custom objects and records (workspace-scoped definitions and generic
      record CRUD APIs implemented; relationship metadata and advanced filters
      remain).
- [~] Workspace roles, permissions, and session migration (active/suspended
      membership, owner/admin role management, and expiring hashed invitations
      are implemented; external identity handoff/email delivery remains).
- [x] Persist voter profile/settings per workspace with authorized read/update
      APIs and audit events.
- [~] Search replacement and realtime subscriptions (bounded tenant-scoped
      unified search is implemented; FTS ranking and realtime subscriptions
      remain).

### Files and automation

- [~] R2 upload/download authorization (tenant-owned upload, list, and download
      routes implemented; attachment-to-record relations and signed external
      URLs remain; core-record links are now implemented).
- [ ] Resumable imports and exports through Queues/Workflows.
- [~] Tenant-scoped JSON export to R2 and resumable import ledger implemented;
      Queue/Workflow execution and attachment manifests remain.
- [~] Notifications, integrations, webhooks, and replay protection (native
      CRM creates persist unique event IDs in a D1 outbox and enqueue
      tenant-scoped envelopes; scheduled replay retries pending/failed events
      up to ten attempts; admin inspection/manual replay is exposed; downstream
      consumers remain).
- [ ] Scheduled reconciliation and failed-job replay tooling.

### Data migration and release

- [~] Build dry-run/resumable PostgreSQL export importer (admin-only bounded
      `/api/crm/import` batches with preserved IDs/timestamps and D1 progress
      ledger; `migrate:crm` and `verify:crm-export` provide resumable transfer
      and independent count/reference/value checks; source extraction remains
      read-only and separately audited).
- [x] Persist workflow-backed export status and R2 artifact metadata for
      authorized polling via `/api/crm/exports/:id`, including running and
      bounded failed states.
- [ ] Preserve IDs, relationships, ownership, timestamps, and tenant keys.
- [ ] Verify counts, foreign-key relationships, and representative values.
- [ ] Run preview parity/security tests and browser workflow tests.
- [ ] Cut over with write-freeze/dual-write procedure and rollback evidence.
- [ ] Retire PostgreSQL/Redis/container dependencies only after sign-off.

## Current status

The first vertical slice is implemented in `src/d1-crm.ts` and migration
`migrations/0005_crm_core.sql`. The upstream repository contains the complete
PostgreSQL-first implementation and migrations, but no existing PostgreSQL →
D1 rewrite was found in the local branches or upstream tree. Full parity is
therefore an entity-by-entity port, not a mechanical schema conversion.
