# Production webhook replay and PostgreSQL cutover

Last updated: 2026-09-17

## Webhook failure and replay controls

- [x] Retain the exact original payload for every new outbound delivery.
- [x] List delivery status, attempts, response status, timestamps, and bounded error details by workspace.
- [x] Restrict delivery history and replay to workspace owners and administrators.
- [x] Require explicit confirmation and same-origin requests for browser replay.
- [x] Atomically claim only `failed` or `dead` deliveries for replay.
- [x] Use a unique Queue job/deduplication identity for every manual replay.
- [x] Preserve cumulative attempts and record replay count, actor, timestamp, and immutable audit evidence.
- [x] Fail closed when a historical delivery has no recoverable original payload.
- [x] Add an authenticated, CSP-protected delivery-history interface at `/_ops/webhooks`.
- [x] Link the interface from Twenty's webhook settings screen.
- [x] Add tenant-isolation, authorization, payload-availability, confirmation, audit, and interface tests.
- [x] Apply D1 migration `0053_webhook_replay.sql` to both production databases.
- [x] Deploy the Worker and verify a failed-delivery replay reaches the registered receiver exactly once.

Production evidence:

- Worker version `54181337-b0e4-4dcc-a304-dfe5e54250d1` (previous auth-only version `39d1d932-4e38-4d77-aab2-c0e73f1c1f30`; rollback version `a6988e56-5895-45d2-b9b8-f28bf42b97fe`).
- The production replay verifier observed one Queue delivery, one persisted receiver receipt, HTTP `202`, and terminal delivery status `delivered`; its temporary API key, delivery, and receipt rows were removed in `finally`.
- Pre-migration D1 Time Travel bookmarks: CRM `0000007d-000005ee-000050e9-47d7f5e8d0dd86adc125a22835e792f0`; OPS `0000000d-00000000-000050e9-8116530a9e819f296abfc6ae680d0ec8`.

## Actual PostgreSQL to D1/R2 cutover

- [x] Provide a read-only, repeatable-read PostgreSQL extractor with resumable table checkpoints.
- [x] Checksum every exported table and preserve source IDs, timestamps, and workspace ownership.
- [x] Convert supported Twenty tables into dependency-ordered D1 import families.
- [x] Upload attachment binaries to tenant-scoped R2 before importing attachment metadata.
- [x] Resume D1 imports with Workflow checkpoints and idempotent record IDs.
- [x] Reconcile record counts, relationships, attachment references, and R2 object presence.
- [x] Add a strict cutover-input gate that rejects missing, incomplete, mismatched, or tampered artifacts.
- [ ] Obtain the real source PostgreSQL connection or completed `manifest.json` export.
- [ ] Obtain the real attachment binary directory matching `r2-required.json`.
- [ ] Identify and approve the source workspace UUID and target production workspace.
- [ ] Record the write-freeze boundary and final source manifest checksum.
- [ ] Run the real extraction, conversion, R2 upload, Workflow import, and persisted reconciliation.
- [ ] Verify representative values and authenticated CRM journeys against the migrated records.
- [ ] Preserve the source database and attachment store unchanged for rollback.

## Current input audit

- [x] Searched the project, Desktop, Downloads, Documents, and local project tree for a Twenty migration manifest or NDJSON export: none found.
- [x] Checked the active environment for `TWENTY_POSTGRES_URL`, `TWENTY_SOURCE_WORKSPACE_ID`, and `TWENTY_ATTACHMENT_ROOT`: none configured.
- [x] Checked authorized local data sources for a legacy database/attachment export: none present.

The actual customer-data cutover is therefore blocked on source data, not on application code. It must remain unchecked until the real records and binaries are provided and verified; sample data is not a valid substitute.
