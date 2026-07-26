# Twenty CRM on Cloudflare: production topology

The only persistent deployment is `twenty-crm`:

https://twenty-crm.rikitrader.workers.dev

Production is permanently Neon-backed and Redis-free. It fails closed when
`PG_DATABASE_URL`, `INTERNAL_SERVICE_TOKEN`, or the Cloudflare coordination
backend is unavailable; there is no all-in-one or Redis fallback.

## Live topology

```text
Users
  |
  v
Cloudflare Worker: twenty-crm
  |-- Access/JWT validation
  |-- edge shell and immutable-asset cache
  |-- status, operations, queues, schedules, and release gates
  |
  |-- TwentyServer (standard-1, max 1, sleeps after 20m)
  |     `-- Neon PostgreSQL + R2 attachments
  |
  |-- TwentyWorker (standard-1, max 1, sleeps after 20m)
  |     `-- Cloudflare state/queue/scheduler/pub-sub gateways
  |
  `-- TwentyBackup (basic, max 1, sleeps after 10m)
        `-- read-only pg_dump from Neon to R2
```

The production ceiling is exactly three container instances:

1. one HTTP/API server;
2. one background-job worker;
3. one short-lived backup companion.

The backup is not a third continuously running application process. It wakes
for an eligible backup and returns to sleep. `max_instances` is a safety cap,
not a permanent minimum.

## Persistence and coordination

| Concern | Production implementation |
|---|---|
| PostgreSQL | Neon through the `PG_DATABASE_URL` Worker secret |
| Redis replacement | Durable Objects, Queues, scheduler DO, and pub/sub DO |
| Files and attachments | R2 bucket `twenty-storage` through Twenty's S3 driver |
| Operational ledger | D1 database `twenty-ops` |
| Status and activity cache | KV namespace `STATUS_KV` |
| Backups | Workflow + basic backup container + R2 |

`REDIS_BACKEND=cloudflare` is fixed in production configuration. The server and
worker container environments never receive `REDIS_URL`.

## Required secrets

- `PG_DATABASE_URL`
- `INTERNAL_SERVICE_TOKEN`
- `ENCRYPTION_KEY`
- `BACKUP_TOKEN`
- `WEBHOOK_TOKEN`
- `STORAGE_S3_ACCESS_KEY_ID`
- `STORAGE_S3_SECRET_ACCESS_KEY`

`APP_SECRET` and `FALLBACK_ENCRYPTION_KEY` remain supported for compatibility
and controlled key rotation.

## Release operations

Database migrations are intentionally not run whenever a normal server or
worker starts. The release-plane source under `src/release/` and
`wrangler.release.jsonc` is retained in Git for explicit, temporary upgrade
operations. It is not a continuously deployed production container and must be
retired after each release completes.

Canary, staging, and probe configurations are also retained as source-controlled
test fixtures. They must not remain deployed outside a bounded validation
window.

## Validation

```bash
bun run typecheck
bun run test
bun run cost:starter:check
bun run security:production:check
bun run readiness:check
curl -fsS https://twenty-crm.rikitrader.workers.dev/_status
```

The status response must report:

- `status: "ok"`
- `mode: "external-db"`
- `productionReady: true`
- `redisBackend: "cloudflare"`
- `durableRedis: true`
- `lastBackupError: null`

## Enterprise versus production

`production` identifies the live environment. `Enterprise-level` identifies
the controls applied to that environment: access control, fail-closed
configuration, tested recovery, immutable releases, auditability, monitoring,
bounded retries, and documented rollback.

Enterprise-level does not require idle duplicate containers. Additional server
or worker replicas are justified only by measured load or an explicit
availability objective. At the current workload, one server plus one worker is
the correct production topology.
