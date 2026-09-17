# CRM functionality repair and sample seed

Baseline production version: `6809027b-0019-48f6-b728-352e5bd151af`.
The user confirms login now works but CRM workflows do not, and requests sample
data plus working features. Existing source modifications are preserved.

## Plan / acceptance checklist

- [x] Confirm the seed target has one active owner membership.
- [x] Inspect actual generated frontend contracts, not only HTTP status codes.
- [x] Reproduce create-with-client-ID fake success in the existing implementation.
- [x] Core sidebar links display and navigate to their record tables (local compiled UI).
- [x] Default view columns are visible (local compiled UI).
- [x] People create persists a client-supplied UUID (API and local UI).
- [x] Company create persists a client-supplied UUID (API).
- [x] Opportunity create persists related company/contact (API).
- [x] Activity create persists related record (API).
- [x] Record edits survive re-fetch (API; person name also compiled UI).
- [x] Records return Apollo typenames and correct response roots.
- [x] Aggregate queries return the requested root and correct total.
- [x] Filtering matches the generated UI query (compiled Email Contains filter returns one match).
- [x] Sorting matches the generated UI query (compiled Name sort uses PascalCase directions).
- [x] Pagination returns stable cursors for the tested dataset.
- [x] Delete moves a record to trash (API).
- [x] Restore returns a trashed record (API).
- [x] Cross-workspace foreign-key references are denied.
- [x] Default member deletion is denied server-side.
- [x] Stored role-permission overrides are enforced on repaired paths.
- [x] Custom-field UUIDs map to native object types.
- [x] User view changes persist (API and compiled Save as new view).
- [x] Seed contains only labeled fictional records and non-deliverable addresses.
- [x] Seed re-run preserves existing edits.
- [x] Seed refuses inactive/non-owner target membership.
- [x] Production seed counts match 3 companies / 5 people / 1 pipeline / 4 opportunities / 6 activities.
- [x] Production seeded relationships are same-workspace.
- [x] Compiled UI renders the seeded records (no record-data mocks).
- [ ] Real Chrome demonstrates navigation and an edited demo record.
- [x] Independent security/data-integrity review passes the changed scope (83 tests independently run; not full-product approval).
- [x] Full regression suite passes (277 passed, 3 skipped).
- [x] Typecheck and Worker dry-run pass.
- [x] Disposable local Workers runtime passes signup/session, create/edit/read, filtered-list, tenant denial, and layouts checks.
- [ ] Additive lifecycle migration is applied only after validation.
- [ ] Deployment and rollback versions are recorded.

## Scope and remaining feature matrix

| Feature family | Status at start | Required evidence |
|---|---|---|
| Login/signup | User confirms login | Preserve regression tests |
| People, companies, opportunities, activities | Broken contract/CRUD | UI + SQLite + live demo records |
| Navigation, views, fields, filtering | Missing/wrong contracts | Actual generated operations + UI |
| Search, tasks, notes, record relations | Partial/unverified | Exact contracts + persistence |
| Attachments/import/export | REST infrastructure exists, UI mapping unverified | Authorized file round trip and UI |
| Custom objects and schema settings | Incomplete bootstrap/mutations | Dynamic object CRUD + UI |
| Workflows/automations | Definitions/queue scaffolding, parity unverified | Saved workflow executes and records result |
| Notifications/calendar/email | Contracts/provider behavior unverified | Exact UI integration + no accidental sends |
| Workspace/settings/roles | Partial; permission gaps | Authorization tests + persisted settings |
| Integrations/billing/AI | External provider-bound and incomplete | Configuration and real provider tests where authorized |

HTTP 200, a generic fallback response, or a visible shell is not feature parity.
Do not mark this matrix complete based on core CRUD alone.

## Data and release decisions

- Target: `75c22091-10d6-4791-bd04-43ffd8ef0926` (the signed-in user's sole
  active owner workspace, confirmed by read-only production query).
- Sample seed is additive, deterministic, and repeat-safe. It never changes
  existing rows on conflict, sends email, starts workflows, or resets auth.
- Shared D1 with mandatory workspace membership remains the data authority;
  the upstream Twenty frontend/design is retained. No Redis/PostgreSQL added.
- Lifecycle migration adds nullable deletion timestamps; no records dropped.
- The prior login-only emergency release exception does not silently cover an
  unlimited feature release. Existing readiness gates remain open. Required
  security/data-integrity findings must be resolved before publishing changes.

## Verification

Seed SQLite tests: 4 passed (including relationship collision after preflight).
Final regression: 37 test files passed, 1 skipped; 277 tests passed, 3 skipped.
TypeScript and Wrangler dry-run passed. No skips are counted as successful tests.
Production seed completed with verified counts and relationships. No existing
records were overwritten. CLI dry-run is manifest-only; live preflight happens
with apply. A partial interrupted seed is safe to rerun, not claimed atomic.
Production deployment completed on 2026-09-17. Migration `0035` was applied
before the Worker publish and is additive/backward-compatible. The initial CRM
repair version was `d476ac5f-1fd4-45ea-9b1f-1ab0c190d948`; the follow-up legacy
sidebar repair is `30e32eea-308f-4400-b349-de8e7bc6589a`. The prior Worker
rollback target is `6809027b-0019-48f6-b728-352e5bd151af`. Worker rollback does
not reverse D1 migrations.

Compiled CRM scenario passes: four sidebar destinations and seeded tables,
New Person creates a sixth persisted contact, inline first/last-name edit sends
UpdateOnePerson and saves, return navigation shows the edited record, Name sort
sends AscNullsLast, Email Contains filters to one person, and Save as new view
persists and activates the filtered view. Six authentication scenarios also pass.
Normal test-suite coverage includes this compiled CRM scenario now.

Commands:

```sh
pnpm test
pnpm exec tsc --noEmit
node test/compiled-login-harness.mjs crm
pnpm exec wrangler deploy --dry-run
# Use a disposable directory; all resource modes must remain local:
pnpm exec wrangler d1 migrations apply CRM_DB --local --persist-to /path/to/disposable-state
pnpm exec wrangler dev --local --persist-to /path/to/disposable-state --ip 127.0.0.1 --port 8788
node test/local-worker-smoke.mjs http://127.0.0.1:8788
```

Non-failing frontend warnings remain: stored es-VE locale falls back to English;
upstream dynamic PersonFragment variants trigger a fragment-name warning.
Neither warning is reported as repaired. No complete responsive-browser test
has run for these changes.

## Concrete UI causes found

- Missing navigation, columns, command definitions, and record layouts.
- Invalid `USER` metadata writability: upstream accepts `OPEN`, `APPLICATION`,
  or `SYSTEM`; this made native record fields read-only.
- Core toolbar hooks unconditionally required internal `workspaceMember`,
  `workflowVersion`, and `workflow` metadata, even on the People table.
- CRUD fallback treated a client-generated ID as an update and could return
  a successful-looking response without creating a record.
- Actual sort controls send PascalCase direction values such as
  `AscNullsLast`; tests must exercise that exact payload.

Internal workflow metadata is read-only and represents the single persisted
native definition, not full upstream workflow/version-history parity.
Record layouts currently support native Fields and Form Field widgets only.
Legacy malformed layouts fall back to validated defaults without deleting data.
Core CRUD currently does not emit the full upstream automation/audit/outbox
event chain. Custom objects, integrations, file UI, and broad settings still
need additional implementation and verification. Do not call this full parity.

The compiled UI harness executes the shipped React modules against real resolver
code and ephemeral SQLite. It supplies jsdom event-realm bridges and nonzero
measurement sizes; it does not prove browser cookies, responsive layout, or
production UI success. A separate localhost Wrangler check covers actual Workers
runtime and D1 bindings. Production Chrome now renders the full Activities table
with six seeded records and active New Activity, Filter, Sort, and Options
controls. A legacy partial sidebar snapshot was also repaired by merging
generated standard-object entries while retaining current per-item tombstones.
The follow-up passed the complete test suite, typecheck, production security
check, Worker dry-run, deployment, and a cache-bypassed live version/health check.
