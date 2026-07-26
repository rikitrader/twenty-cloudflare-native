# Merge plan: Cloudflare-native Redis replacement and starter cost controls

Date: 2026-07-25
Target: `main`
Status: merge plan; production cutover is not authorized yet

## Objective

Merge the Twenty Cloudflare-native state, queue, scheduling, pub/sub, backup,
security, and cost-control work as a reviewable sequence. The target runtime
must not start a Redis process, open a Redis connection, resolve a Redis host,
or depend on BullMQ for active traffic.

The replacement is native Cloudflare behavior, not a Redis or Meowdis protocol
emulator:

| Redis responsibility | Replacement |
| --- | --- |
| queue delivery/retries | Cloudflare Queues + idempotent job receipts |
| cache/session state | SQLite Durable Objects |
| locks/counters/deduplication | sharded Durable Objects with fencing tokens |
| schedules | Scheduler Durable Object alarms + cron |
| pub/sub and AI streaming | PubSub Durable Object and typed event transport |
| backups/exports | R2 + Backup Workflow |
| CRM system of record | Neon/PostgreSQL via Hyperdrive; not D1 |

## Current repository state

The canonical checkout contains a large, uncommitted implementation and must
not be merged wholesale. First split it into focused commits/PRs. The current
enterprise readiness result is not green: G3, G10, and G13 remain incomplete.
Production is therefore still on the rollback-compatible path until those
gates and the cutover evidence are complete.

## Merge sequence

### 1. Baseline and inventory

- Create a clean worktree from the latest `origin/main`.
- Regenerate the pinned Twenty v2.20 contract and runtime contract.
- Run `npm test`, `npm run typecheck`, contract checks, secret scan, and the
  enterprise-readiness check.
- Classify every Redis reference as **active runtime**, **rollback**,
  **contract/evidence**, or **historical documentation**.

No deletion happens during this phase.

### 2. Cloudflare state and routing foundation

Merge the Durable Object state router, internal authenticated gateway,
`REDIS_BACKEND` feature gate, migration bindings, and unit tests. Keep the
default backend unchanged so the PR is behavior-preserving.

Required gates: typecheck, unit tests, Wrangler dry-run, and gateway auth
tests.

### 3. Cache, sessions, locks, queues, schedules, and pub/sub

Merge the adapters in separate reviewable commits, each with differential and
failure-path tests:

- cache/session store and TTL behavior;
- fencing-token locks and counters;
- queue envelope, retry, DLQ, and execution receipts;
- scheduler alarms, timezone/DST behavior, and cancellation;
- pub/sub event ordering, long-polling, and AI cancellation.

Each adapter must have an explicit idempotency key and bounded resource
partition. Do not claim exactly-once delivery.

### 4. Container image and deployment wiring

- Build the pinned production image.
- Apply the adapter patch only when its target hash matches the pinned image.
- Verify the image contains no Redis server package/process and no active
  `REDIS_URL`.
- Keep the old Redis variables only in the rollback configuration, never in
  the Cloudflare-native production environment.
- Apply D1 migrations and deploy through the gated Wrangler workflow.

### 5. Cost controls

- Keep the production health probe at a 15-minute cadence and backups hourly.
- Cap container instances per environment and scale only from measured queue
  backlog/latency.
- Bound Durable Object alarms, queue retries, DLQ replay, and R2 backup
  retention.
- Review D1 row scans and writes weekly; use indexes and bounded queries for
  operations data.
- Add a budget alert and a monthly cost evidence artifact before cutover.

### 6. Canary and controlled cutover

- Deploy the Cloudflare-native backend to the isolated canary.
- Run authenticated CRUD, queue retry/DLQ, scheduler, pub/sub, backup/restore,
  crash-injection, and load tests.
- Complete Access separation (application vs audience), token rotation,
  rollback drill, and production observation.
- Pause producers, drain old BullMQ queues, switch the production flag, and
  validate status, SLOs, and zero Redis traffic.
- Keep the old backend available but inactive for the documented rollback
  window.

### 7. Final Redis decommissioning

Only after the observation gate passes for 14 consecutive days:

- remove Redis secrets and service bindings from Cloudflare;
- remove the Redis rollback deployment and unused container process;
- delete Redis-only dependencies and code paths from the production image;
- remove rollback-only scripts/configuration after exporting evidence;
- retain sanitized contract/evidence documents that explain what was replaced.

## What “clean all Redis files” means

The following must be removed before final decommissioning:

- active `REDIS_URL`/Redis bindings in production configuration;
- Redis process startup and Redis health checks in production images;
- runtime Redis clients, BullMQ workers, and direct Redis/pub-sub calls;
- Redis-only dependencies from the production lockfile;
- rollback deployment manifests and secrets after the rollback window.

The following must **not** be deleted prematurely:

- migration feature flags and rollback tests;
- sanitized Redis/BullMQ contract manifests used to prove compatibility;
- readiness evidence, cutover, rollback, and incident runbooks;
- historical design documents explaining the migration and cost decisions.

These files do not create Redis traffic and are required for auditability. They
can be renamed to “legacy-backend” terminology after decommissioning if the
repository policy requires a zero-match documentation scan.

## Merge acceptance checklist

- [ ] Clean worktree and branch based on latest `origin/main`.
- [ ] No unrelated WIP included in a PR.
- [ ] All tests, typecheck, contract, build, secret scan, and dry-run checks
      pass.
- [ ] Enterprise gates G0–G13 are passed or explicitly tracked with evidence;
      no production cutover while G3/G10/G13 are incomplete.
- [ ] Production config selects Cloudflare adapters and has no `REDIS_URL`.
- [ ] Access application and audience are separate and verified.
- [ ] Queue/Durable Object failure, restore, and rollback drills pass.
- [ ] 14-day zero-Redis observation passes.
- [ ] Cost evidence shows starter-scale limits and budget alerts are active.
- [ ] Redis secrets/services are revoked only after the rollback window.

