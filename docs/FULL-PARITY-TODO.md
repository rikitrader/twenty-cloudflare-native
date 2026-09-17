# Twenty Cloudflare full-parity implementation TODO

Last updated: 2026-09-17

This is the release source of truth for the 16 remaining areas. A checkbox is
completed only after persistence, server authorization, the exact shipped
Twenty client contract, automated tests, and a production-browser verification
all pass. Returning HTTP 200 or rendering a placeholder is not completion.

Architecture: the upstream Twenty React interface remains the client; Workers
and Static Assets host it; shared tenant-scoped D1 is authoritative for CRM
data; R2 owns files; Queues own retryable jobs; Workflows own durable multi-step
operations; Durable Objects own realtime/coordination. External relational or
cache services, traditional application hosts, and persistent local disk are prohibited.

## Program gates

- [x] Baseline and deployed version recorded.
- [x] Core authentication and tenant-scoped CRM vertical slice exists.
- [x] Current Twenty and Cloudflare documentation rechecked.
- [x] No known mutation returns success without completing or durably accepting the action.
- [x] Every shipped frontend GraphQL operation is classified: implemented, provider-disabled with an explicit error, or intentionally unavailable in the UI.
  - [x] Classify the original 163/333 unclassified generated operations and reduce the unclassified count to zero.
  - [x] Eliminate the remaining `implementation-required` bucket: the audited inventory is now 203 implemented-review, 96 provider-disabled-review, and 34 explicitly-unavailable.
- [ ] Full regression, typecheck, security, migration, preview, adversarial, accessibility, responsive, and production smoke gates pass.
  - [x] Add a non-cached `/healthz` readiness probe that fails closed unless the authoritative CRM D1 database answers a real query.
- [ ] Rollback and recovery rehearsal is recorded for the final schema and Worker version.

## 1. Production UI verification

- [ ] Exercise People, Companies, Opportunities, and Activities in production.
- [ ] Verify create/read/update/archive/restore/destroy, relations, filters, sort, pagination, views, and sidebar navigation.
- [x] Add Playwright desktop/mobile critical-journey coverage using a disposable workspace.
- [x] Capture console/network failures and screenshots as release evidence.

## 2. Attachments

- [x] Map Twenty attachment GraphQL operations to the authorized R2 REST lifecycle.
- [x] Verify upload, metadata commit, attachment create/list/rename/trash/restore/destroy, record link, download, unlink, and deletion.
- [x] Enforce tenant ownership, content/size limits, safe filenames, one-time upload tokens, and expired-orphan cleanup.
- [x] Add R2 failure, duplicate commit, cross-workspace, unauthorized download, and lifecycle tests.

## 3. Tasks, notes, and relationships

- [ ] Match the shipped activity/task/note/timeline operation contracts.
- [ ] Persist task completion, rich note content, and relationship-picker changes.
- [ ] Verify inverse relationships, same-tenant targets, pagination, and record side panels.
- [ ] Emit audit/outbox events for every mutation.
  - [x] Implement exact `task`, `taskTarget`, `note`, and `noteTarget` generated record operations.
  - [x] Commit each task/note business mutation, audit row, and outbox row atomically in one D1 batch.
  - [x] Drain mutation outbox events idempotently and prove duplicate delivery safety.

## 4. Custom objects and fields

- [ ] Replace generic JSON CRUD with schema-validated metadata-driven persistence.
- [ ] Add required/unique constraints and supported Twenty field families.
- [ ] Implement relation, select, multi-select, currency, address, rich-text, actor, and array semantics.
- [ ] Add schema migration/versioning, indexed filters, sort, aggregate, and dynamic UI tests.

## 5. Permissions

- [ ] Add custom roles, role assignments, object permissions, field permissions, and row predicates.
- [ ] Compile every permission decision server-side; never trust client flags.
- [ ] Apply permissions to records, search, files, exports, relationships, metadata, and automation.
- [ ] Add cross-tenant and privilege-escalation tests for every write family.
  - [x] Finish custom-role CRUD and immutable built-in role rules.
  - [x] Persist exact permission-flag and agent-role assignment contracts and expose them through `GetRoles`.
  - [ ] Enforce object permissions on GraphQL, REST, search, exports, files, relationships, and automations.
  - [ ] Enforce field read/write restrictions during projection, filtering, sorting, and mutation.
  - [ ] Compile and enforce row predicates with bounded, validated expressions.
  - [x] Reuse the record authorization compiler in global search so custom-role object grants, hidden fields, and bounded row predicates cannot be bypassed by the command menu.
  - [x] Recheck attachment targets through the target object's object/row policy for list, read, create, update, trash, restore, and destroy operations.

## 6. Workflows and automations

- [ ] Persist immutable workflow versions plus draft editing and publication.
- [ ] Persist nodes, edges, triggers, positions, run snapshots, step output/logs, retries, stop, and replay.
- [ ] Execute supported steps through Workflows/Queues with idempotency and bounded retries.
- [ ] Add webhook, schedule, manual, and record-event triggers.
  - [x] Add an API-key-authenticated `WEBHOOK` trigger endpoint with method validation, payload limits, rate limiting, deterministic idempotency, durable run persistence, and Queue dispatch.
- [ ] Verify the visual editor and run history against real D1 state.
  - [x] Implement the exact workflow-version, trigger, step, edge, position, publish, deactivate, and archive operations used by the visual editor.
  - [x] Snapshot published versions so later draft edits cannot change active executions.
  - [x] Dispatch committed CRM record events to matching published workflow triggers with deterministic run IDs and duplicate-delivery protection.
  - [x] Evaluate published UTC cron triggers every minute and create exactly one durable run per workflow/minute, including duplicate-cron protection and explicit failed state when queueing fails.

## 7. Email and calendar

- [x] Route Twenty `SendEmail` through Cloudflare Email Service for the verified `mipolitico.com` domain, with Queue retries, delivery state, sender enforcement, recipient validation, and rate limiting.
- [ ] Separate saved provider configuration from verified connected state.
- [ ] Implement real OAuth/credential validation and encrypted secret storage.
- [ ] Implement message folders, inbound/outbound sync, calendar sync, cursors, retries, disconnect, and reconciliation.
- [ ] Prevent provider-dependent actions from returning synthetic success.

## 8. Notifications

- [ ] Add tenant/user-scoped notification persistence and preferences.
- [ ] Implement list, unread counts, mark-read, archive, and idempotent delivery jobs.
- [ ] Connect in-app, email, and operational channels without making a third party mandatory.
- [ ] Verify accessibility and partial-delivery recovery.
  - [x] Implement persisted user-scoped notification list/unread/read/archive/create contracts with idempotent in-app delivery (no shipped generated notification operations were present in the 333-operation inventory).

## 9. Search and realtime

- [ ] Expand search to custom objects/fields, activities, relations, ranking, and highlighting.
- [ ] Add cursor pagination and permission-aware search results.
- [ ] Publish committed record/metadata changes through Durable Objects.
- [ ] Add reconnect, ordering, duplicate, stale-client, and permission-revocation tests.
  - [x] Replace metadata heartbeat-only SSE with authorized workspace event delivery.

## 10. Imports and exports

- [x] Implement UI column mapping, validation preview, resumable batches, progress, error rows, and cancellation.
- [ ] Stream large imports/exports through R2 and Workflows without Worker memory assumptions.
  - [x] Replace the 10,000-row in-memory JSON export with paginated, bounded multipart NDJSON written by a Cloudflare Workflow to R2.
  - [x] Include contacts, companies, pipelines, opportunities, activities, tasks/targets, notes/targets, relationships, custom metadata/records, views, attachment metadata, files, and file links in full-workspace exports.
  - [x] Stream dependency-ordered NDJSON uploads for all 17 exported standard/custom families directly to tenant-scoped R2 and process them with a resumable byte cursor in `CRM_IMPORT_WF`.
  - [x] Enable Twenty's shipped `IMPORT_RECORDS` spreadsheet wizard for column mapping and validation preview; expose the same parser through `/api/crm/imports/preview` for large-import clients.
- [ ] Preserve IDs/relationships/timestamps where authorized and verify counts/values.
  - [x] Reconcile the deployed core tables after the 0048 migration (1 workspace, 1 member, 5 contacts, 3 companies, 4 opportunities, 6 activities; zero writes during verification).
  - [x] Implement checksum-verified PostgreSQL artifact conversion, ordered D1/R2 transfer, target count/relationship/R2 verification, and persisted reconciliation reports. The production cutover run remains gated on a real source export.
- [ ] Add tenant authorization, duplicate delivery, restart, and cleanup tests.
  - [x] Persist and verify authorized resume/cancel/error-download API flows (the final shipped-UI browser journey remains part of the parent checkbox).

## 11. AI

- [x] Bind Workers AI for the implemented asynchronous text-chat journey; AI Gateway/Vectorize remain optional and unbound.
- [ ] Persist model/run provenance, limits, failures, and user-visible status.
- [ ] Add prompt-injection, tenant namespace, tool authorization, PII minimization, and cost controls.
- [x] Keep queued messages distinct from persisted assistant answers; retry provider failures and publish only completed answers.

## 12. Billing and enterprise licensing

- [ ] Keep billing disabled unless a real processor is configured.
- [ ] Replace synthetic credit/subscription success responses with authoritative state or explicit provider-disabled errors.
- [ ] Implement signed webhook reconciliation, idempotency, entitlement checks, portal/checkout, and audit logs when configured.
- [ ] Verify that billing is never required infrastructure for core CRM use.

## 13. SSO and external integrations

- [ ] Implement OIDC authorization-code + PKCE and SAML validation with exact redirect/entity configuration.
- [ ] Encrypt credentials, serialize refresh, revoke on disconnect, and bind installations to workspaces.
- [ ] Verify outbound webhooks with SSRF controls, signatures, retries, DLQ, and replay.
  - [x] Implement Twenty-compatible inbound HMAC-SHA256 validation over the exact timestamp/raw-body bytes, a five-minute replay window, deterministic event IDs, payload limits, and durable Queue acceptance.
  - [x] Configure the production `WEBHOOK_TOKEN` secret and verify the public `/webhooks/twenty` receiver with a correctly signed request persisted through Queue to OPS D1.
  - [x] Implement explicit-host allowlisting, private-address rejection, HMAC-signed delivery, timeouts, idempotent receipts, bounded Queue retries, and terminal 4xx handling.
  - [x] Configure `OUTBOUND_WEBHOOK_SECRET` plus the exact `WEBHOOK_ALLOWED_HOSTS`, register the production receiver, and verify a signed Queue round trip with a persisted 202 receipt.
  - [x] Add a tenant-scoped owner/admin delivery ledger with explicit-confirmation replay for terminal/failed webhook deliveries, retained-payload checks, audit evidence, and production Queue/receiver verification.
- [ ] Add provider health, reconnect, and schema-drift handling.

## 14. PostgreSQL data migration

- [x] Build/document the read-only PostgreSQL extraction step.
- [x] Complete resumable D1/R2 import for every supported object and attachment.
- [x] Add relationship/count/value verification reports and sensitive-safe errors.
- [ ] Rehearse write freeze or change capture, cutover, rollback, and post-cutover reconciliation without deleting the source.
  - [x] Export every workspace-schema table plus workspace-scoped core metadata/membership/file-reference rows inside a PostgreSQL `REPEATABLE READ READ ONLY` transaction, with per-table checksums, counts, resumable table checkpoints, and no source writes.
  - [x] Convert verified source artifacts into dependency-ordered per-family NDJSON, upload required binary objects to tenant-scoped R2, resume Workflow imports, and persist final target reconciliation evidence.

## 15. Release and operational gates

- [ ] Complete G3 seven-day session/cache continuity evidence.
  - [x] Deploy the 15-minute production sampler, no-store status endpoint, and evidence capture command.
  - [ ] Accumulate 673 consecutive passing samples over at least 604,800,000 ms with no gap over 30 minutes.
- [ ] Complete G10 WAF/Logpush/secrets/binding inspection.
  - [x] Inspect and record Worker bindings, required secret names, Workers observability, account MFA enforcement, route topology, and Logpush visibility.
  - [ ] Move the production hostname onto a Cloudflare zone/custom domain and verify zone WAF managed/custom/rate-limit rules.
  - [ ] Grant narrowly scoped Logpush inspection access and verify an enabled `workers_trace_events` job and destination.
  - [ ] Enable account-wide two-factor enforcement and recapture the account security evidence.
- [ ] Complete G13 production observation after the final cutover.
- [ ] Add structured SLOs, alerts, synthetic journeys, cost budgets, backup/restore, DLQ replay, and incident runbooks.
- [ ] Run the architecture, security, data-integrity, reliability, cost, UX/accessibility, and release-evidence adversarial reviews with no unresolved critical/high finding.
  - [ ] Run production-browser authentication and critical CRM journeys in the existing signed-in Chrome profile.
  - [x] Record Wrangler dry-run, production smoke, migrations through 0053, deployed version `54181337-b0e4-4dcc-a304-dfe5e54250d1`, previous version `39d1d932-4e38-4d77-aab2-c0e73f1c1f30`, rollback target `a6988e56-5895-45d2-b9b8-f28bf42b97fe`, signed webhook receipt evidence, and an exactly-once manual replay verification.
  - [x] Replace the eight-hour native-session expiry with one consistent seven-day TTL across credential login, signup, invitation signup, renewal, and REST session creation.
  - [x] Return protected GraphQL authentication loss as HTTP 200 with `extensions.code = UNAUTHENTICATED`, allowing Twenty's Apollo auth handling to recover instead of retrying raw HTTP 401 failures.
  - [x] Hard-reset concurrent expired-session errors to `/welcome`, reject `/not-found` as a saved return path, and redirect already-stranded `/not-found` tabs to the application root on reload.

## 16. Frontend and documentation quality

- [x] Deliberately normalize Venezuelan-Spanish profiles to Twenty's supported `es-ES` locale without fallback warnings.
- [x] Eliminate the duplicate dynamic cache fragment names (`CacheReadFragment` vs `CacheWriteFragment`).
- [x] Pass keyboard, screen-reader, contrast, mobile, tablet, and desktop checks.
  - [x] Add automated accessibility assertions and real-browser desktop/mobile screenshots for every critical journey.
  - [x] Verify the deployed authenticated Activities surface in the existing Chrome profile exposes named navigation, create/filter/sort/options controls, labeled row selection, and six linked records through the browser accessibility tree.
- [x] Consolidate stale architecture and release-version statements in project documentation.
- [ ] Record final architecture, bindings, secret names, commands, limitations, deployment version, and rollback procedure.

## Current implementation order

- [ ] Phase A — contract inventory and false-success elimination (program gates, 1, 16).
- [ ] Phase B — activities/relations/files plus audit/outbox (2, 3).
- [ ] Phase C — metadata/custom objects and permissions (4, 5).
- [ ] Phase D — workflow execution and realtime/search (6, 9).
- [ ] Phase E — providers, notifications, imports/exports, AI/billing/SSO (7, 8, 10–13).
- [ ] Phase F — migration rehearsal, operational gates, responsive/a11y browser matrix, final deployment (14–16).

## Implemented progress (not a parity waiver)

- [x] Removed false-success responses for unimplemented API-key roles, provider sync, chat control, workflow editing, billing credits, enterprise actions, and queue administration.
- [x] Added tenant-scoped metadata and CRUD for dynamic custom objects, including required/unique validation and soft-delete lifecycle.
- [x] Added an expiring, hashed-token direct-upload contract matching Twenty's `PUT` flow and authorized R2 completion response.
- [x] Replaced the retired server-process job hop with a native D1 workflow executor using per-step receipts and deterministic idempotency.
- [x] Added an exact generated-client operation inventory command; unclassified operations deliberately fail the audit.
- [x] Made generated API keys usable with hashed bearer verification, workspace binding, server-side roles, revocation, and last-used tracking.
- [x] Implemented Twenty's attachment metadata and record contract over the authorized one-time R2 upload lifecycle.
- [x] Added native task/note and polymorphic target contracts with rich text, completion state, assignee validation, tenant isolation, and atomic audit/outbox writes.
- [x] Added durable outbox retries and stable event-ID deduplication across Queues, D1, and Durable Object realtime delivery.
- [x] Added custom-role CRUD/assignment with immutable built-ins and core object, field, and bounded row-predicate enforcement.
- [x] Added immutable workflow-version publishing with persisted visual-editor triggers, steps, edges, and positions.
- [x] Added a D1-backed `/healthz` endpoint and regression coverage; the prior undocumented SPA redirect can no longer masquerade as a healthy runtime.
- [x] Added a tenant-scoped, rate-limited Workers AI chat queue/executor with deterministic assistant IDs, duplicate-delivery protection, D1 history, and realtime completion events.
