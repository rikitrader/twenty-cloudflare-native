# Starter-scale cost control

## What the invoice proves

Cloudflare invoices usage at the account level. The July 2026 invoice was
$285.26, but the live Twenty operations database contains only one event and
77 backup rows. The invoice therefore cannot be assigned to Twenty without
per-database D1 analytics; other account databases are substantially larger.

Do not remove Twenty audit writes until the D1 Billable Usage dashboard or
GraphQL analytics identifies Twenty as the source of the rows-read/written
spike.

## Starter profile

The production deployment uses:

- one production Worker, one server container, and one worker container;
- one `basic` backup companion that wakes only for eligible backups;
- `standard-1` for the application server and job worker after load testing;
- `basic` only for the backup companion;
- a 15-minute health schedule that probes containers only while customer
  traffic is recent, plus an hourly backup that skips when customers made no
  changes;
- a 20-minute container sleep policy, allowing idle beta-container memory and
  disk billing to stop;
- no continuously deployed canary, staging, probe, or release containers
  outside bounded test or upgrade windows;
- queue batching and bounded retries;
- D1 only for operational metadata, not CRM data or unbounded raw payloads;
- R2 for large webhook/archive payloads when retention is required;
- observability sampling below 100% outside incident windows.

## Budget guardrails

Create account budget alerts at $50, $100, and $150. Alerts are informational;
they do not cap usage. Review the Billable Usage dashboard daily during the
first week after each deployment.

Recommended starter service budgets (excluding the Workers Paid subscription):

| Service | Warning | Action threshold |
| --- | ---: | ---: |
| Container memory + disk + CPU | $25/mo | $50/mo |
| D1 | $10/mo | $25/mo |
| Durable Objects | $5/mo | $15/mo |
| Total account usage | $50/mo | $100/mo |

## Safe optimization order

1. Attribute D1 usage by database and day.
2. Stop unused canary/staging deployments and their cron triggers.
3. Right-size production containers using a load test and rollback plan.
4. Add D1 indexes for every repeated filter and replace unbounded scans with
   cached summaries.
5. Move only confirmed archival payloads to R2 with explicit retention.
6. Re-check the invoice after one complete billing cycle.

The production deploy performs one bounded warm-up so a new release is ready
before handoff and its versioned SPA shell is stored at the edge. This does not
create a permanent minimum instance: after customer traffic stops, health
probes stop waking the server/worker and both may sleep after 20 minutes.

Normal server restarts set `DISABLE_DB_MIGRATIONS=true` and
`DISABLE_CRON_JOBS_REGISTRATION=true` to avoid repeating release maintenance.
For a Twenty schema or cron-definition upgrade, run an explicitly approved
bootstrap rollout with `RUN_NEON_INIT=true`, verify it, then remove the flag and
run the normal warm-up gate. Never enable that flag merely to keep containers
hot.

## Account-wide D1 finding

The July 2026 account invoice is materially driven by the `sismo911` D1
database, not Twenty. Its last-seven-day D1 insights show approximately 40.8
billion rows read from a hospital-patient status-normalization `UPDATE` run
262 times, plus approximately 1.4 billion rows read by a repeated `personas`
count query. These queries should be fixed in the `sismo911` application by:

- materializing normalized names and status priority at ingest time;
- processing only changed hospital rows using an indexed cursor;
- replacing correlated full-table updates with bounded batches;
- adding composite partial indexes for moderation/protected/status filters;
- caching dashboard counters and using keyset pagination instead of repeated
  `COUNT(*)` and `OFFSET` scans.

Those changes belong to the `sismo911` application and should not be applied to
Twenty's D1 schema. Twenty's own recent D1 insights show only 118 rows read
over 59 backup inserts.

Never delete a database, container image, backup, or audit table as a cost
measure without a verified export and a recovery test.
