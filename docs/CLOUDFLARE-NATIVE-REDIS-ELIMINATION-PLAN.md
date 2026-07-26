# Cloudflare-Native Redis Elimination for Twenty

Date: 2026-07-24
Status: enterprise implementation in progress; production activation intentionally blocked
Supersedes: `MEOWDIS-REDIS-REPLACEMENT-PLAN.md` as the preferred approach

## Implementation progress

Phase 1 foundation landed locally on 2026-07-24 and remains disabled for live
traffic:

- `TwentyState` SQLite Durable Object and Wrangler migration `v3`;
- sharded JSON values with versions and bounded TTLs;
- alarm-driven expiration cleanup;
- atomic counters;
- owner-checked locks with monotonically increasing fencing tokens;
- authenticated internal HTTP gateway;
- `twenty-state.internal` container outbound interception;
- `REDIS_BACKEND=redis|cloudflare` migration flag;
- status reporting for selected backend and state readiness;
- unit tests and a successful Wrangler dry-run bundle/configuration check.

Phase 2 cache/session compatibility landed locally on 2026-07-24:

- typed batch, expiry, set, hash, scan, and namespace-clear State APIs;
- clean-room cache-manager store preserving Twenty's exact optimized Redis
  client surface without implementing RESP or accepting arbitrary commands;
- owner-safe lock compatibility with fencing handled by the State DO;
- custom `express-session` store with cookie-derived TTL and `touch`;
- deterministic build patch against pinned Twenty image digest
  `d3dd949725e6196c57dab66ebe83ba9cdd2561885c35f94ef20f9ae38cd6d333`;
- immutable production image build and in-image adapter/rollback verification;
- 30 passing unit/contract tests.

Phases 3-5 implementation landed locally on 2026-07-24:

- versioned Cloudflare Queue job envelope and authenticated producer gateway;
- delayed-message chaining, per-job retry limits, explicit DLQ writes, and
  consumer-side Durable Object occurrence deduplication;
- authenticated HTTP executor embedded in the Twenty worker process;
- `CloudflareQueueDriver` wired into Twenty's existing message-queue seam;
- `TwentyScheduler` SQLite Durable Object with alarms, cron expressions,
  timezone/DST handling, interval schedules, and removal/update behavior;
- `TwentyPubSub` Durable Object with a bounded event log and long polling;
- direct AI heartbeat, accumulated chunk list, cancellation, and subscription
  behavior routed through typed Cloudflare state/event clients;
- Redis and BullMQ admin/health paths replaced with Cloudflare-safe responses;
- exact pinned production image builds and selects every Cloudflare adapter
  without `REDIS_URL`;
- Durable Object job execution leases and seven-day completion receipts suppress
  concurrent delivery and replay of completed Cloudflare job envelopes;
- deterministic pinned-image contract inventory covers 168 relevant runtime
  files, 82 queue enqueue sites, 87 processors, 29 scheduling calls, direct
  Redis/pub-sub calls, optimized cache calls, and compiled patch target hashes;
- CI fails closed if the pinned Twenty contract changes or a discovered method
  is not implemented by the Cloudflare adapters;
- 63 passing unit/contract tests plus successful canary and production
  Wrangler dry-run builds;
- a sanitized live Redis/BullMQ runtime contract covering 16 queues and four
  BullMQ Lua digests;
- durable completed and quarantined execution receipts with an in-place SQLite
  schema migration;
- an isolated deployed Queue/DO fault suite covering retry exhaustion,
  connection loss, worker-process crash, and post-crash recovery;
- a Bun dependency override pins patched PostCSS `8.5.23`; `bun audit` reports
  zero known vulnerabilities.

The routing gate now accepts either Redis (the default) or the explicit
combination `REDIS_BACKEND=cloudflare` plus `INTERNAL_SERVICE_TOKEN`. The
production configuration does not set the Cloudflare flag, so current traffic
remains on Redis. Do not activate the flag until the zero-Redis canary and crash
injection acceptance gates pass.

## Objective

Remove Redis from the Twenty deployment by replacing each Redis responsibility
with the Cloudflare product that provides the corresponding behavior.

This is not a Redis emulator. Twenty will use native Cloudflare adapters:

- Cloudflare Queues for background-job delivery and retries;
- Durable Objects with SQLite for strongly consistent cache state, sessions,
  locks, deduplication, and dynamic schedules;
- Durable Object WebSockets for cross-process pub/sub;
- Workflows for long-running orchestration where a job is naturally multi-step;
- R2 for logical exports and disaster-recovery snapshots;
- Containers for the unchanged Twenty server and job executors;
- Neon/Postgres remains Twenty's system-of-record database.

“Full Cloudflare stack” means Cloudflare owns the edge, compute, coordination,
delivery, object storage, operational data, security controls, telemetry, and
deployment plane. Twenty still requires PostgreSQL semantics, so its CRM
system of record remains PostgreSQL reached through Hyperdrive. Replacing that
database with D1 is outside this project and would require a separate Twenty
application fork.

## Enterprise program charter

### Non-negotiable invariants

1. Redis is absent from the active server and worker topology: no `REDIS_URL`,
   Redis process, Redis DNS lookup, Redis TCP connection, BullMQ worker, or
   Redis-backed health dependency.
2. Queues are treated as retryable delivery. Every job has a durable execution
   receipt, and every externally visible side effect has a stable idempotency
   key or transactional outbox.
3. Durable Objects are partitioned around the unit of coordination. A global
   singleton is prohibited outside an explicitly capacity-tested global
   scheduler.
4. KV is never used for locks, sessions, counters, deduplication, or schedules.
5. Internal container gateways are reachable only through Worker-controlled
   outbound interception and require an independently rotated service token.
6. Unknown Redis methods, BullMQ options, job shapes, and patch anchors fail
   closed during build or canary.
7. Production cutover is reversible without rebuilding an image or deleting
   the Redis rollback secret.
8. A green unit suite is not a release gate by itself. Production topology,
   fault injection, load, security, restore, and rollback evidence are required.

### Product architecture

| Plane | Cloudflare product | Enterprise responsibility |
| --- | --- | --- |
| Public edge | DNS, TLS, Workers, Cache API | routing, static caching, health, headers |
| Application compute | Containers | pinned Twenty server and worker processes |
| Strong coordination | SQLite Durable Objects | sessions, cache metadata, locks, receipts |
| Async delivery | Queues | priority lanes, retries, backpressure, DLQs |
| Dynamic scheduling | Durable Object alarms | Twenty-created cron and interval schedules |
| Long orchestration | Workflows | backups, restore validation, reconciliation, replay |
| Realtime | Hibernatable WebSocket Durable Objects | GraphQL and AI stream pub/sub |
| Primary relational data | Hyperdrive to PostgreSQL | pooled access to Twenty’s system of record |
| Files and recovery | R2 | attachments, exports, backups, telemetry archive |
| Operational ledger | D1 | deployments, DLQ cases, restore drills, audit events |
| Edge snapshots | KV | non-authoritative status and feature rollout snapshot |
| Metrics | Analytics Engine and Workers metrics | queue/state latency, cardinality, SLOs |
| Logs and traces | Workers Logs, traces, Tail Worker/Logpush | investigation and SIEM export |
| Identity and perimeter | Access, WAF, DDoS, rate limiting, API Shield | administrative and API controls |
| Secrets | Secrets Store where available; Worker secrets fallback | rotation and least privilege |
| Delivery | GitHub Actions plus Wrangler versions | signed, gated, gradual releases and rollback |

Cloudflare documents Durable Object storage as transactional, strongly
consistent, and serializable. It also recommends designing one object per
logical coordination unit instead of a global singleton. Cloudflare Queues
provide explicit acknowledgement, retry, retry delay, concurrency, and DLQ
controls; this plan therefore requires application idempotency rather than
claiming exactly-once delivery.

### Target service topology

```text
Internet
  |
  v
Cloudflare DNS/TLS/WAF/API Shield/Rate Limiting
  |
  v
Front-door Worker --------------------------------------+
  |                                                     |
  +--> Cache API / KV status                            |
  +--> Twenty Server Container shard                    |
  |      +--> Hyperdrive --> PostgreSQL                 |
  |      +--> R2 attachments                            |
  |      +--> internal authenticated gateways ----------+
  |                                                     |
  +--> Queue producer --> high / normal / low Queues    |
  |                          |                          |
  |                          v                          |
  |                    Queue consumer                   |
  |                          |                          |
  |                          v                          |
  |                  Twenty Worker Container shard      |
  |                                                     |
  +--> State router --> State DO shards                 |
  |                    cache:<workspace>:<bucket>        |
  |                    session:<hash-prefix>             |
  |                    lock:<resource-hash>              |
  |                    execution:<workspace>:<bucket>    |
  |                                                     |
  +--> Scheduler DO shards --> Queues                    |
  +--> PubSub DO per workspace --> hibernatable WS       |
                                                        |
Workflows --> backup / restore / reconciliation --> R2 + D1
Telemetry --> Workers Logs / Traces / Analytics --> Logpush/SIEM
```

### Workstreams and ownership

| Workstream | Accountable role | Required output |
| --- | --- | --- |
| Twenty contract | Application owner | machine-readable Redis/BullMQ call inventory |
| Native adapters | Platform engineering | versioned queue, state, session, pub/sub adapters |
| Idempotency | Application owner | handler inventory and side-effect keys/outbox |
| Data/state | Platform engineering | sharding, TTL, capacity, export/restore |
| Reliability | SRE | fault suite, SLOs, alerts, runbooks, rollback |
| Security | Security owner | threat model, Access/WAF/API Shield, rotation evidence |
| Delivery | Release engineering | signed artifacts, SBOM, provenance, gradual rollout |
| Compliance | Business/security owner | retention, residency, audit, vendor-plan decisions |

One person may hold several roles, but each gate must name a human approver
before production activation.

## Production SLOs and error budgets

Initial targets must be confirmed against observed production traffic:

| Signal | Target |
| --- | --- |
| Front-door availability | 99.95% monthly |
| Authenticated session read/write | 99.99% success, p95 under 100 ms at gateway |
| Job enqueue durability | 99.99% accepted messages persisted |
| Ordinary job start delay | p95 under 30 s, p99 under 120 s |
| Scheduled occurrence accuracy | 99.9% within 60 s of due time |
| Lost acknowledged jobs | zero |
| Duplicate externally visible effects | zero for handlers marked idempotent |
| Pub/sub reconnect | p95 under 10 s after eviction or restart |
| State recovery | RPO 15 min or better; RTO 60 min or better |
| Rollback | backend rollback decision-to-completion under 15 min |

Any unknown adapter call, lost job, missing schedule, session-corruption event,
or security-boundary failure consumes the entire migration error budget and
halts rollout.

## Release gate matrix

| Gate | Evidence | Current state |
| --- | --- | --- |
| G0 reproducible build | pinned image, lockfile, SBOM, vulnerability policy | passed |
| G1 complete contract | static inventory plus runtime trace and replay | passed |
| G2 state correctness | real DO concurrency, TTL, alarm, eviction tests | passed |
| G3 session/cache | browser login/logout/restart and cache invalidation suite | partial |
| G4 job safety | execution receipts, handler idempotency, crash injection | passed |
| G5 scheduling | DST, timezone, missed alarm, duplicate alarm differential suite | passed |
| G6 realtime | hibernatable WS, reconnect, multi-server and AI cancellation | passed |
| G7 production topology | production image, external PG, no Redis process/network | passed |
| G8 capacity/cost | 5x peak load, hotspot analysis, documented monthly estimate | passed |
| G9 operations | real metrics, DLQ ledger/replay, alerts and on-call runbooks | passed |
| G10 security | threat model, secret rotation, perimeter and dependency review | partial |
| G11 recovery | R2 export/restore and PostgreSQL restore drill | passed |
| G12 rollback | timed backend rollback and queue reconciliation drill | passed |
| G13 observation | 14 continuous zero-Redis days within SLO | blocked |

No production Redis removal is authorized until G0-G13 are passed with links
to immutable evidence.

### G0 reproducible build evidence

G0 is passed. Both Twenty base images are pinned by multi-architecture digest,
the Worker dependency graph is frozen by `bun.lock`, and all GitHub Actions in
the build/deployment path are pinned to immutable commits.

Two independent no-cache production image builds were exported as
timestamp-normalized OCI archives. Both produced SHA-256
`6d8378df372a7fc16f77e2ae4952e223abf5a869d76cc06f0618d28e92cde4dc`
and normalized manifest
`fabe136cdffc21734aa2b99e0ea2109cf132f347f89390714433f8292083742c`.
The verifier is `scripts/verify-reproducible-image.sh` and runs before any
production migration or deployment.

The first production image scan exposed one fixable critical and eleven
fixable high package findings inherited from the pinned upstream image. The
build now applies integrity-checked, exact-version OS and Node package patches.
The final Trivy 0.72.0 scan reports zero fixable HIGH and zero CRITICAL
findings. Syft 1.49.0 generated a valid SPDX 2.3 SBOM containing 1,293 packages
and 2,816 relationships. CI retains the SBOM and JSON vulnerability report for
90 days and performs a daily rescan.

The fail-closed threshold, exception requirements, and evidence retention are
defined in `docs/CONTAINER-VULNERABILITY-POLICY.md`. Sanitized evidence is in
`docs/evidence/g0-reproducible-build.json`. Production was not deployed or
modified while closing this gate.

### G1 runtime evidence baseline

The exact disposable Twenty all-in-one image digest now has a sanitized runtime
contract in `docs/twenty-v2.20-runtime-contract.json`. The artifact records both
that capture digest and the separate production target digest. The collector
exercises the root page, health endpoint, and anonymous GraphQL endpoint while
observing one full BullMQ scheduler interval through Redis `MONITOR`.

The committed artifact retains only command families, BullMQ queue names,
`EVALSHA` digests, and HTTP scenario status codes. It never writes the raw
trace, Redis values, job identifiers, timestamps, headers, cookies, or payloads
to disk. CI verifies the normalized artifact without requiring Docker or a
live Redis instance.

The baseline observed 16 Twenty queues, four BullMQ Lua digests, blocking
delayed-job polling, recurring cron execution, and direct cache commands.
An authenticated canary browser then completed signup, workspace provisioning,
profile onboarding, and the Companies GraphQL application. The workflow replay
exercised personal-email, new-company, existing-company, and workflow-run
delete/restore branches with cleanup. Sanitized evidence is in
`docs/evidence/g1-authenticated-contract-canary.json`.

The closure artifact `docs/evidence/g1-contract-closure-canary.json` maps every
previously unexercised scenario to a fresh canary run or adapter contract test.
Twenty v2.20 exposes no GraphQL subscription root (`subscriptionType=null`), so
that scenario is explicitly not applicable; the equivalent authenticated edge
realtime path is covered by G6. The job fault runner now covers retry, DLQ,
worker/container crash, and post-crash recovery.

### G2 state correctness evidence

G2 is passed on the isolated Cloudflare canary. A live probe issued 64
concurrent increments against one SQLite-backed Durable Object key. Every
result was unique, the final value and version were both 64, and no update was
lost.

The same probe proved lock ownership and fencing behavior: a competing owner
could not acquire or release the active lease, the valid owner could release
it, and fencing tokens advanced from 1 to 2 and then to 3 after TTL expiry.
Scalar, set, hash, list, and lock TTL rows were physically removed before any
expiry-on-read operation. The object retained a later alarm for unrelated
namespaces, and that shared alarm was not overdue.

A canary-only secret-version update forced the Durable Object incarnation ID
to change from `fcd483a8-d9a1-4600-9ea2-0738b50d67ef` to
`adca1b18-fc0b-453e-afab-ac5678ce06dc`. The durable counter survived with
value 64 and version 64, proving storage continuity across the reset. The
diagnostic RPC is unavailable unless `CANARY_MODE` is exactly `true`, and the
HTTP probe remains bearer-protected.

The repeatable driver is `scripts/run-state-fault-canary.mjs`; sanitized live
evidence is in `docs/evidence/g2-canary-state-correctness.json`. Production
remained on version `5b42c895-ed4a-4a31-93df-1a14c43acbef` throughout.

### G5 scheduler correctness evidence

G5 is passed on the isolated Cloudflare canary. Logical occurrences now use a
deterministic SHA-256 job identifier as well as a retained dedupe key. A live
probe seeded an occurrence more than five seconds in the past, injected two
copies before invoking the alarm path, and invoked the alarm twice. The
schedule was removed at its end date and exactly one execution receipt
completed with one attempt.

The differential calendar suite verifies `America/New_York` behavior across
the 2026 spring-forward gap and fall-back overlap. The missing 02:30
spring-forward occurrence resolves deterministically to 03:30 local time; the
01:30 fall-back wall-clock occurrence runs once, followed by the next day's
01:30 occurrence.

The repeatable driver is `scripts/run-scheduler-fault-canary.mjs`; sanitized
evidence is in `docs/evidence/g5-canary-scheduler-correctness.json`. The
dedicated scheduler probe queue returned to zero backlog, and production
remained on version `5b42c895-ed4a-4a31-93df-1a14c43acbef`.

The same run exposed a separate container-executor failure on the application
queue. That queue reached 122 pending canary messages and direct executor
requests timed out twice after 30 seconds. This does not weaken the isolated
scheduler result, but it keeps G4 partial. The explicit gap and required
remediation are recorded in
`docs/evidence/g4-canary-executor-gap.json`.

## Execution sequence

### Wave A — Contract and safety foundation

1. Generate an inventory from the pinned Twenty image of every cache, session,
   Redis client, queue driver, job option, registered processor, and scheduler.
2. Trace a disposable Redis deployment while exercising the complete Twenty
   workflow catalog; merge static and runtime inventories.
3. Fail CI on an unknown call, option, processor, or compiled patch anchor.
4. Classify every job side effect: database-only, idempotent external API,
   non-idempotent external API, or long-running orchestration.
5. Add stable idempotency keys or a PostgreSQL outbox to all unsafe handlers.

Exit: G0 and G1 pass; every job has an explicit execution-safety disposition.

### Wave B — Native data plane

1. Replace `workspace:default` with deterministic routing:
   `cache:<workspace>:<bucket>`, `session:<hash-prefix>`,
   `lock:<resource-hash>`, `execution:<workspace>:<bucket>`,
   `pubsub:<workspace>`, and `schedule:<workspace>`.
2. Add per-operation structured telemetry and bounded cardinality.
3. Add export manifests, checksums, encryption metadata, and restore tooling.
4. Convert PubSub long polling to hibernatable WebSockets for production.
5. Implement three priority queues or prove that Twenty does not require
   priority differentiation.

Exit: G2, G5, and G6 pass at 5x measured peak.

### Wave C — Operations and security

1. Replace synthetic queue health with actual depth, oldest age, completion,
   failure, retry, DLQ, and executor latency signals.
2. Add authenticated DLQ inspect/replay/quarantine flows backed by a D1 audit
   ledger and Workflows for controlled bulk replay.
3. Add Worker traces, Analytics Engine series, Logpush/Tail Worker routing,
   alert thresholds, and correlation IDs across edge, queue, DO, and container.
4. Apply Access to operations routes; WAF/rate limits/API protections to public
   routes; disable public access to internal gateways.
5. Rotate service, database, storage, and encryption credentials and prove
   least-privilege recovery.

Exit: G9 and G10 pass; on-call can diagnose and recover without shell access.

### Wave D — Production-topology staging

1. Deploy `Dockerfile.production` with separate server and worker Containers.
2. Use a schema-only staging PostgreSQL branch, a Worker-side Hyperdrive
   binding, an encrypted branch-specific Container connection, and isolated
   staging R2/D1/Queues.
3. Omit `REDIS_URL`; disable/remove the Redis process; capture DNS and network
   evidence showing no Redis traffic.
4. Run browser, API, workflow, AI, scheduler, restart, eviction, deployment,
   dependency-failure, and regional-failure suites.
5. Execute capacity, cost, backup/restore, and timed rollback drills.

Exit: G3, G4, G7, G8, G11, and G12 pass.

### Wave E — Controlled production migration

1. Deploy the same immutable artifact with `REDIS_BACKEND=redis`.
2. Enable Cloudflare cache for an internal workspace, then sessions, ordinary
   jobs, schedules, and realtime in separate rollout steps.
3. Pause producers, drain BullMQ, snapshot repeatable jobs, and record a signed
   cutover ledger before switching queue ownership.
4. Start one Cloudflare worker executor, validate, then raise concurrency.
5. Observe for 14 days with the former Redis backend available but inactive.
6. Remove Redis credentials and service only after G13 passes.

Exit: no Redis process or traffic, all SLOs met, rollback window formally closed.

## Rollback and uncertain-execution policy

Backend selection remains a flag. Rollback does not delete secrets or rebuild
images. If an executor response is lost after a side effect may have committed,
the occurrence is **uncertain**: it must not be blindly replayed. The
reconciliation workflow checks the application/database/outbox state, records
an operator decision in D1, and then completes, retries, or quarantines it.

Immediate rollback triggers:

- unknown Redis/BullMQ contract use;
- lost or missing scheduled occurrence;
- session corruption or cross-workspace state access;
- unexplained queue divergence or DLQ growth;
- Durable Object hotspot or sustained SLO breach;
- inability to restore or reconcile state;
- any public reachability of an internal gateway.

## Current-documentation decisions

The plan was refreshed against Cloudflare documentation on 2026-07-24:

- Queues expose batch size/timeout, retry count/delay, concurrency, explicit
  acknowledgements, and DLQs; message handlers must remain idempotent.
- SQLite Durable Objects provide transactional, strongly consistent,
  serializable storage.
- Cloudflare recommends one Durable Object per logical coordination atom and
  hibernatable WebSockets for idle realtime connections.
- Containers are controlled through Durable Object-backed classes and can call
  Workers through outbound host interception.
- Container local disk is not the durability boundary; PostgreSQL, DO storage,
  D1, and R2 own durable data.

## Cloudflare account baseline

Read-only inventory on 2026-07-24 confirms:

- the live `twenty-crm` Worker and isolated
  `twenty-crm-redis-free-canary` Worker exist as separate deployments;
- `twenty-pg` Hyperdrive exists and targets the Neon PostgreSQL origin;
- R2 bucket `twenty-storage`, D1 database `twenty-ops`, KV namespace
  `STATUS_KV`, and the existing `twenty-events` queue/DLQ exist;
- the isolated `twenty-jobs-canary-v2`, canary DLQ, and
  `twenty-redis-canary-probe` queues exist with active bindings;
- the production `twenty-jobs` and `twenty-jobs-dlq` queues are declared in
  Wrangler but were not present in the account inventory and must not be
  created or bound to live traffic until the production-topology gate;
- the interactive Wrangler credential is broad and suitable for development,
  not the final deployment identity. CI must use a dedicated least-privilege
  token, protected environment approval, and an auditable production role.

This baseline means no new primary storage service is required for the next
wave. The immediate infrastructure task is a separate staging environment with
isolated names and data, followed by security and observability resources.

## Important discovery from the pinned Twenty image

The deployed production image contains:

- BullMQ `5.78.0`;
- ioredis `5.10.1`;
- a `MessageQueueDriver` abstraction;
- existing `BullMQDriver` and `SyncDriver` implementations;
- a queue module factory that is presently hard-coded to BullMQ;
- separate cache-storage and session-storage factories;
- direct Redis clients for GraphQL subscriptions and AI chat streaming.

Therefore, a native Cloudflare driver is a supported architectural seam. We do
not need to reproduce BullMQ's Redis data model, Lua scripts, or RESP protocol.

## What to ingest from Meowdis

Meowdis demonstrates a useful Cloudflare pattern:

```text
HTTP command gateway
        |
        v
one Durable Object
        |
        v
SQLite transactions
```

Reuse the architectural ideas:

- Durable Object SQLite as the persistent state engine;
- authenticated HTTP calls from non-Worker runtimes;
- transactional batches;
- explicit expiry timestamps;
- typed tables for strings, hashes, sets, and lists;
- deterministic unit tests for state operations.

Do not copy Meowdis source into this repository until its licensing is
clarified. No license file was present at inspected commit
`99c36621ad55a2950efb7857a69279cf80b7ff35`. If permission is not obtained,
implement the small state service clean-room from the behavior described here.

Do not ingest:

- the Upstash REST wire format;
- Redis command translation as the main application API;
- the single global Durable Object topology;
- `KEYS`/full-database scans;
- bearer-token access over a public workers.dev endpoint.

## Target architecture

```text
                           Cloudflare Worker
                    +-----------------------------+
Browser/API ------->| front door and WS proxy     |
                    |                             |
Twenty Server       | internal container egress  |
Container ----------|--> State Gateway ----------|--> State DO shards
                    |                             |      - cache
                    | Queue Producer ------------|--> Cloudflare Queues
                    |                             |
                    | Queue Consumer ------------|--> Twenty Worker Container
                    |                             |        internal job endpoint
                    | Cron Scheduler ------------|--> Scheduler DO alarms
                    +-----------------------------+             |
                                                                  v
                                                        Cloudflare Queues

State DO shards:
  workspace cache | sessions | locks/idempotency | pub/sub | schedules

Durability:
  DO SQLite primary state -> scheduled logical exports -> R2
  Twenty CRM records       -> Neon/Postgres
```

Containers call internal Worker handlers through the Containers
`outboundByHost`/outbound interception facility:

```text
http://twenty-state.internal
http://twenty-queue.internal
http://twenty-events.internal
```

These names are intercepted inside Cloudflare and are not public DNS records.
The public Worker must reject all corresponding internal paths.

## Redis responsibility mapping

| Existing Redis responsibility | Cloudflare replacement | Twenty integration |
| --- | --- | --- |
| BullMQ job enqueue | Queues producer binding | `CloudflareQueueDriver.add()` |
| Job consumption | Queues consumer -> container request | internal job-dispatch endpoint |
| Retries and DLQ | Queues retry/ack and dead-letter queue | consumer response mapping |
| Delayed jobs | Queue message delay | `options.delay` conversion |
| Job deduplication | transactional Durable Object claim | queue/idempotency namespace |
| Dynamic recurring jobs | Scheduler DO + alarms | `addCron` / `removeCron` |
| Fixed platform schedules | Cron Triggers or scheduled Workflows | Wrangler configuration |
| Long-running multi-step jobs | Workflows, selectively | dedicated adapter per job type |
| Cache get/set/delete | Cache State DO | custom cache-manager store |
| Sets, hashes, counters | typed State DO methods | `CacheStorageService` adapter |
| Distributed locks | lock DO with owner/fencing token | replace cache Redis lock calls |
| Express sessions | Session DO shards | custom `express-session` store |
| GraphQL pub/sub | PubSub DO WebSockets | custom `PubSubEngine` |
| AI stream heartbeat/cancel | State DO + PubSub DO | replace direct ioredis calls |
| Redis health indicator | component health aggregate | State DO/Queues health checks |

Cloudflare KV is intentionally excluded from locks, sessions, counters, queue
deduplication, and scheduling because those operations require immediate,
strongly consistent coordination. KV may be used only for non-critical,
eventually consistent edge snapshots such as `/_status`.

## Adapter design

### 1. `CloudflareQueueDriver`

Implement the existing Twenty `MessageQueueDriver` contract:

```ts
interface CloudflareQueueDriver {
  register(queueName: MessageQueue): void;
  work(
    queueName: MessageQueue,
    handler: (job: MessageQueueJob) => Promise<void>,
    options?: MessageQueueWorkerOptions,
  ): void;
  add(
    queueName: MessageQueue,
    jobName: string,
    data: unknown,
    options?: QueueJobOptions,
  ): Promise<void>;
  addCron(input: AddCronInput): Promise<void>;
  removeCron(input: RemoveCronInput): Promise<void>;
}
```

Producer path:

1. Twenty calls `add()`.
2. The driver POSTs a signed job envelope to `twenty-queue.internal`.
3. The Worker claims any idempotency key transactionally in a Durable Object.
4. The Worker writes the message to a Cloudflare Queue, including delay and
   retry metadata.
5. The producer returns only after Queue persistence succeeds.

Consumer path:

1. Cloudflare invokes the Worker's `queue()` handler.
2. The Worker acquires a durable execution receipt before invoking Twenty.
3. The Worker routes the message to the pinned `TwentyWorker` container.
4. An internal Twenty endpoint calls the handler registered by `work()`.
5. HTTP 2xx commits the receipt before `ack`; retryable 5xx abandons the
   receipt before `retry`.
6. Permanent responses and exhausted retries become durable quarantined
   receipts before the application writes the Cloudflare DLQ and acknowledges.
7. Transport failures keep the active lease and delay redelivery until its
   expiry, preventing rapid retries from executing concurrently.
8. An ambiguous final outcome is quarantined and cannot automatically invoke
   the handler again; operator-controlled replay remains a G9 requirement.

The Queue consumer configuration permits 10 retries, matching the maximum
accepted by the versioned job envelope. The platform DLQ remains a final safety
net if the consumer itself cannot complete application-level quarantine.

The job envelope must include:

```ts
type CloudflareTwentyJob = {
  schemaVersion: 1;
  id: string;
  queueName: string;
  jobName: string;
  data: unknown;
  createdAt: string;
  retryLimit: number;
  priority: number;
  notBefore?: number;
  dedupeKey?: string;
  dedupeClaimed?: boolean;
  retainDedupe?: boolean;
};
```

Explicit Queue retry re-delivery preserves the originally serialized body, so
job dedupe locks are re-entrant for the same job owner without advancing the
fencing token. A different job owner remains a duplicate and is acknowledged
without executing. Completion receipts are retained for seven days; terminal
quarantine receipts use the same retention period.

Current unit evidence covers success, duplicate delivery, completed replay,
active-lease contention, delayed chaining, transient failure, permanent
failure, retry exhaustion, ambiguous transport failure, quarantine replay,
retry-delay bounds, and configuration drift.

The deployed isolated canary subsequently passed the real Queue/DO fault suite
recorded in `docs/evidence/g4-canary-job-faults.json`: normal completion,
permanent-response quarantine, transient retry exhaustion, connection-loss
quarantine, forced worker-process crash quarantine, and successful execution
after restart. Four failure scenarios produced exactly four additional
Cloudflare DLQ messages. No production Worker or production Queue was changed.

The earlier executor-gap observation is superseded by the later final safety
drill in `docs/evidence/g4-final-job-safety.json`: it destroyed the complete
container during an in-flight job, observed quarantine without replay, then
verified post-crash completion. All 87 processors have explicit dispositions,
the backlog returned below the documented bound, and executor/queue-age alerts
are covered by G9. G4 is passed.

The later application-queue outage was traced to an image packaging error, not
to Cloudflare Queues or Durable Objects. The security rewrite placed
CommonJS `brace-expansion@2` beside root ESM `balanced-match@4`; `init-db`
therefore failed before the server, worker, and job-executor ports could bind.
The image now installs `balanced-match@1.0.2` inside the legacy dependency tree
and retains version 4 for the modern tree. The rebuilt image started both
Twenty processes locally, returned HTTP 200, and the isolated live executor
returned HTTP 204. The complete six-scenario fault suite passed again. The
application backlog fell from a peak observation of 156 to 48 while the
consumer was raised to the production-parity batch/concurrency settings; the
DLQ and dedicated fault queue remained at zero. Detailed evidence is in
`docs/evidence/g4-canary-executor-gap.json`.

### G3 session and cache evidence

The first real browser signup exposed a critical integration defect: the three
container classes declared `static outboundByHost` as class fields. The
Containers SDK registers outbound handlers through an inherited static setter,
so those fields shadowed the setter and left `ContainerProxy` with no internal
hostname registry. Requests to `twenty-state.internal` fell through to DNS and
returned HTTP 530.

The handlers are now assigned after each class definition, which invokes the
SDK setter. A regression test rejects the shadowing form. On the corrected
canary, 84 observed container-originated state calls returned HTTP 200 across
get/set/delete/mget/increment/expire, set membership, and lock operations.

A clean browser then completed signup, workspace creation, profile onboarding,
and loading the authenticated Companies application with its five seed
records. The same browser session remained authenticated and loaded metadata
and record GraphQL data after the canary Durable Object/container was reset.
Sanitized evidence is in
`docs/evidence/g3-canary-session-state.json`.

The first fresh logout probe exposed that Twenty's access JWT is stateless. The
Worker now provides `/_auth/revoke`, stores a SHA-256 access-token fingerprint
in the `auth-revocation` Durable Object namespace until the JWT expires, and
checks that marker before forwarding authenticated requests. The pinned image's
logout bundle calls this endpoint before clearing local state. A live canary
request returned 200 from revocation and 401 for the same token afterward.

G3 is partial rather than blocked. The Worker revocation endpoint and old-token
401 behavior are live-proven, and the immutable bundle contains the sign-out
hook. A fresh-profile browser click against the latest image was also observed
live: it emitted `POST /_auth/revoke` with HTTP 200 and returned to `/welcome`.
Concurrent-session behavior, live Twenty permission-change invalidation, and the
seven-day canary soak remain required before it can pass; adapter-level
permission-key invalidation is covered by the Cloudflare adapter suite. The fresh TTL/eviction boundary
run is recorded in `docs/evidence/g3-state-ttl-boundary-canary.json`, and
the canary-only cumulative ledger endpoint is `/_canary/g3/soak` with a
seven-day/672-sample readiness check.
the scheduled probe is `.github/workflows/g3-session-soak.yml`. An attempted
document-level capture-listener enhancement was reverted after its canary image
failed container readiness; production was not affected.

### G6 realtime recovery evidence

The Cloudflare-native event plane now stores a one-hour retained event log and
per-channel cursor/retention floor in a SQLite Durable Object. Publishing,
cursor lookup, bounded replay, long polling, and hibernatable WebSockets all
share that log. WebSocket attachments preserve authentication, channel, and
cursor state across hibernation. A client asking for data older than the
retention floor receives an explicit gap instead of silently skipping events.

The isolated live canary proved unauthenticated denial, backlog replay, live
delivery, reconnect from the last cursor with missed-event recovery,
multi-subscriber fanout, retention-gap detection, and close code 4009 for a
stale subscriber. The final canary returned HTTP 200 after deployment, and the
Vitest suite passes 87 tests across 17 files. Sanitized evidence is in
`docs/evidence/g6-canary-realtime.json`.

The same scenario also passed against the Access-protected, production-shaped
staging deployment. HTTP automation traverses the Access service policy;
WebSocket upgrades traverse a private Worker service binding from the
bearer-protected probe to staging. This proves the retained log, reconnect,
fanout, and gap behavior through the real split server/worker topology.
Sanitized evidence is in
`docs/evidence/g6-production-topology-staging-realtime.json`.

Cloudflare telemetry also exposed an important transport boundary: the real
Twenty container successfully uses `twenty-events.internal` for cursor, poll,
and publish HTTP requests, while Node's native WebSocket did not traverse the
Container outbound host interceptor. Containers therefore use abortable,
cursor-aware long polling over the private binding. The hibernatable WebSocket
endpoint remains available at the Worker/Durable Object edge, where Cloudflare
can terminate and forward the upgrade.

G6 is passed. Twenty v2.20 has no GraphQL subscription root, so that requested
scenario is explicitly not applicable. The authenticated edge realtime suite,
local forced-eviction harness, AI adapter cancellation tests, and the
production-topology five-times-peak/multi-server drill cover the applicable
recovery responsibilities. Evidence is in `g6-canary-realtime.json`,
`g6-local-eviction.json`, and `g8-production-topology-capacity.json`.

The Worker Access verifier now also supports an optional `ACCESS_ALLOWED_GROUPS`
allowlist. When configured, a validly signed Access JWT must carry at least one
matching group claim; otherwise the request is rejected. This is implemented and
unit-tested, but the production group policy still requires the organization
IdP/Access application setup recorded in the G10 threat model.

The fresh Access-protected staging operations run passed unauthenticated denial,
service-auth readiness, audit integrity, optimistic conflicts, uncertain-outcome
confirmation, bounded replay, redaction, and queue metrics. It is recorded in
`docs/evidence/g10-production-shaped-staging-ops.json`; production perimeter
controls remain intentionally unprovisioned.

### G7 zero-Redis production topology evidence

The production-shaped staging deployment uses separate `TwentyServer` and
`TwentyWorker` Containers built from the pinned production Dockerfile and an
isolated schema-only Neon branch. Its deployed binding and encrypted-secret
inventories contain no `REDIS_URL`. The immutable image contains neither a
`redis-server` executable nor the Alpine Redis package, and its image
environment contains no Redis URL.

Live Cloudflare Queue execution, DLQ replay through the separate worker
Container, and realtime replay/fanout all completed in this topology. With no
Redis process, socket, URL, binding, or secret available, those completed paths
demonstrate that state, locks, jobs, and pubsub use the Cloudflare adapters.
Sanitized evidence is in
`docs/evidence/g7-zero-redis-production-topology.json`. G7 passes.

### G8 capacity and cost evidence

G8 passes on the Access-protected, production-shaped staging topology. The
14-day production analytics baseline peaked at 1,525 Worker requests per
minute. The bounded test therefore issued exactly 7,625 operations over one
minute: 4,572 atomic state writes, 1,907 realtime publishes, 764 server
requests, and 382 Queue jobs.

All 7,625 operations succeeded. Overall latency was 249 ms at p95 and 427 ms
at p99. Atomic state values and realtime event identifiers were unique. All
382 jobs completed across four distinct worker executors, job completion was
4.191 seconds at p95 and 5.439 seconds at p99, and the final Queue backlog was
zero.

The drill identified and corrected three production-relevant hotspots before
passing:

- execution receipts now distinguish a reserved delivery from a handler that
  actually started, allowing safe rapid retry for pre-handler transport
  failures without replaying ambiguous side effects;
- Queue batches are processed concurrently with a bounded batch size of 10
  and four consumer invocations instead of serial one-message dispatch; and
- each of the two server and four worker processes is limited to five
  PostgreSQL pool clients. A fifth worker Container slot is migration headroom
  only and is not selected by current routing.

At current published Cloudflare rates, sustaining the full tested peak every
minute for a 30-day month is estimated at $758.39, with a modeled range of
$742.44-$826.67 based on Container CPU utilization and Durable Object active
duration. This deliberately conservative scenario is far above the observed
34,605-requests-per-month extrapolation. It excludes PostgreSQL, workload-
specific R2, egress, email, Access, taxes, and enterprise discounts. The exact
inputs, formulas, exclusions, and current pricing links are recorded in
`docs/evidence/g8-capacity-cost-model.json`; the sanitized live result is in
`docs/evidence/g8-production-topology-capacity.json`.

### G9 operations and DLQ evidence

The isolated canary now consumes both application quarantine envelopes and
platform retry-exhausted messages from `twenty-jobs-canary-v2-dlq` into the
separate `twenty-ops-canary` D1 database. Failure ingestion and its first audit
event execute in one D1 batch transaction. Deterministic failure identifiers
make repeated terminal delivery an idempotent update rather than a duplicate
case.

The bearer-protected operations API provides bounded cursor pagination,
single-case inspection, realtime Queue backlog/age metrics, optimistic-version
dismissal, and controlled replay. Job payloads are omitted from list and
summary responses. Replay creates a stable new job identifier, explicitly
releases any retained dedupe claim, and uses the existing execution receipt to
make recovery from an uncertain D1 finalization safe. Ambiguous executor
outcomes require an additional explicit confirmation.

The live evidence in `docs/evidence/g9-canary-dlq-operations.json` proves:

- the existing platform DLQ backlog drained into D1;
- unauthenticated inspection was rejected;
- stale versions and unconfirmed ambiguous replay were rejected;
- an approved replay traversed the real Queue and Container executor and
  completed;
- replay and dismissal produced immutable audit events;
- current Queue backlog metrics were returned; and
- production remained on version
  `5b42c895-ed4a-4a31-93df-1a14c43acbef`.

G9 is passed. The canary and production-topology staging operations paths are
protected by separate Cloudflare Access applications. Controlled bounded bulk
replay passed live, and the
restricted Cloudflare Email Service binding accepted a synthetic critical
delivery containing the executor-readiness, job-queue-age, and DLQ-age alert
codes. The final operations drill then passed against separate immutable
server and worker Containers, isolated D1/KV/R2/Queues, and a schema-only Neon
branch. The operator procedure and rollout thresholds are in
`docs/runbooks/DLQ-OPERATIONS.md`.

### G10 security evidence

The canary `/_ops/*` path now has its own self-hosted Cloudflare Access
application and exact-operator allow policy. Access uses a one-hour session,
HttpOnly cookie, and binding cookie. An unauthenticated request receives the
Access login challenge while `/_canary/*` continues to reach the Worker,
proving the application is path-scoped rather than protecting or breaking the
entire CRM host.

The Worker independently validates `Cf-Access-Jwt-Assertion` with the Access
JWKS, an RS256 algorithm allowlist, exact team-domain issuer, exact application
audience, and required expiry, issued-at, and subject claims. A separate
operations bearer remains mandatory. A Workers Rate Limiting binding enforces
60 requests per minute per verified Access subject. API responses are
non-cacheable and carry restrictive content and framing headers.

Webhook authentication is now bearer-only; query-string credentials are
rejected because URLs are commonly retained in logs. The complete boundary,
threat, control, incident-response, and remaining production requirements are
documented in `docs/THREAT-MODEL.md`. Live evidence is recorded in
`docs/evidence/g10-canary-security.json`.

G10 is partial rather than blocked. It still requires a separate production
Access audience, organization IdP with phishing-resistant MFA, group/service
authorization, WAF and Logpush configuration, and a complete least-privilege
secret rotation drill. The Worker now fails closed if `REDIS_BACKEND=cloudflare`
is selected without the external PostgreSQL and internal service-token
topology, and it also rejects the legacy bearer-only operations fallback in
that mode; the behavior is covered by `test/access.test.ts` and
`test/types.test.ts`. The production `INTERNAL_SERVICE_TOKEN` prerequisite was
generated and uploaded as a Worker secret; its value is never recorded in
source or evidence. The remaining production configuration is recorded in
`docs/evidence/g10-production-internal-token.json`.

### G11 recovery evidence

G11 passes on the production-shaped staging topology. A dedicated `basic`
Container runs only the private backup agent and `pg_dump`; it starts neither
Twenty, BullMQ, nor Redis. Its `/restore` operation is disabled, and the live
PostgreSQL credential is never provided to the recovery target.

The Workflow streamed a fresh 404,689-byte PostgreSQL plain-SQL export into
R2 through a fixed-length stream. R2 validated its SHA-256 during upload, and
the Workflow wrote a colocated versioned manifest containing size, digest,
format, source engine, and encryption metadata. It then verified R2 metadata
and recorded the artifact and manifest in the D1 backup ledger.

The drill downloaded both objects, independently recomputed SHA-256, and
restored the export into an isolated, disposable PostgreSQL 18 container
pinned by digest and backed by tmpfs. Restore completed in 593 ms; validation
found 107 application tables, one application sequence, and a 16,332,479-byte
database. End-to-end recovery completed in 36.628 seconds, within the 60-minute
RTO target. Evidence is in `docs/evidence/g11-recovery-drill.json`, and the
repeatable operator procedure is in `docs/runbooks/RECOVERY.md`.

### G12 rollback evidence

G12 passes on the isolated Redis-free canary. The rollback flag changed the
primary backend from Cloudflare to embedded Redis in 45.836 seconds, below the
15-minute decision-to-completion target. During the rollback window, the
consumer-only Cloudflare drain bridge remained registered while Redis owned
new producers and schedules.

Twenty-five delayed Cloudflare Queue jobs were created before the switch. All
25 completed with unique IDs, no missing receipts, no DLQ increase, and zero
queue backlog after reconciliation. Reconciliation completed 89.307 seconds
after the rollback decision. The canary was returned to Cloudflare afterward,
and production remained on
`5b42c895-ed4a-4a31-93df-1a14c43acbef`. Evidence is in
`docs/evidence/g12-rollback-drill.json`; the operator procedure is in
`docs/runbooks/ROLLBACK.md`.

### 2. Priority

Cloudflare Queues do not substitute automatically for BullMQ's numeric
priority behavior. Start with three physical queues:

- `twenty-jobs-high` for Twenty priorities 1-2;
- `twenty-jobs-normal` for priorities 3-5;
- `twenty-jobs-low` for priorities 6-7.

Configure more concurrency for high priority and less for low priority. Before
production, verify whether Twenty actually depends on strict cross-priority
ordering. If strict ordering is required, add a per-workspace Dispatcher DO
that releases the next job to one execution queue in priority order.

### 3. Dynamic schedules

Twenty calls `addCron()` dynamically, so Wrangler-only Cron Triggers are not
sufficient.

Use a `ScheduleDurableObject`:

- SQLite table keyed by Twenty's scheduler/job key;
- fields for cron/every configuration, timezone, payload, next run, and version;
- one Durable Object alarm set to the earliest `next_run_at`;
- on alarm, enqueue all due jobs transactionally, calculate their next runs,
  and set the next alarm;
- use a deterministic dispatch ID so an alarm retry cannot enqueue a logical
  occurrence twice;
- `removeCron()` deletes the definition and recalculates the next alarm.

### 4. State service

Use multiple Durable Object shards rather than Meowdis's one global object:

```text
cache:<workspaceId>:<bucket>
session:<hash-prefix>
lock:<resource-hash>
pubsub:<workspaceId>
scheduler:<workspaceId-or-global>
```

Suggested SQLite tables:

```sql
kv(namespace, key, value_json, expires_at, version)
set_members(namespace, key, member, expires_at)
hash_fields(namespace, key, field, value_json, expires_at)
locks(namespace, key, owner, fencing_token, expires_at)
idempotency(namespace, key, result_json, expires_at)
schedules(id, queue_name, job_name, payload_json, spec_json, next_run_at, version)
```

Every lock acquisition returns an owner token and monotonically increasing
fencing token. Release must compare the owner token; it must not blindly delete
the lock.

Expiry should be enforced on read and cleaned in bounded alarm-driven batches.
Never scan an entire Durable Object in a request.

### 5. Cache and sessions

Replace the hard-coded Redis cache factory with a custom cache-manager store
whose `get`, `set`, `del`, `mget`, `mset`, and reset operations call the State
Gateway.

Implement the additional Twenty cache behaviors as typed State API operations:

- set add/remove/pop/cardinality/members;
- hash get/set/delete and conditional update;
- increment;
- prefix invalidation;
- atomic lock acquisition/release.

Replace `connect-redis` with a small `express-session` store implementing
`get`, `set`, `touch`, and `destroy` over Session DO shards.

### 6. Pub/sub and AI streaming

Create a per-workspace PubSub DO:

- containers publish over internal HTTP;
- Twenty server instances subscribe through a WebSocket;
- the DO broadcasts events to connected server containers;
- hibernatable WebSockets keep idle cost low;
- subscribers reconnect and resubscribe after container or DO eviction.

Replace direct `RedisClientService.getClient()` uses in AI chat streaming with
a typed `DistributedStateService` and `DistributedPubSubService`.

## Repository implementation layout

```text
src/
  cloudflare-state/
    state-do.ts
    schedule-do.ts
    pubsub-do.ts
    schema.ts
    gateway.ts
  jobs/
    producer.ts
    consumer.ts
    envelope.ts
    retry-policy.ts
  internal/
    authentication.ts
    container-egress.ts
twenty-adapters/
  cloudflare-queue-driver/
  cloudflare-cache-store/
  cloudflare-session-store/
  cloudflare-pubsub/
cf/
  patch-cloudflare-adapters.cjs
  entrypoint-server.sh
  entrypoint-worker.sh
test/
  state-do.test.ts
  scheduler-do.test.ts
  queue-driver.test.ts
  queue-consumer.test.ts
  redis-elimination-e2e.test.ts
```

For the first implementation, adapters can be built as a small package and
copied into the pinned image, with a deterministic build-time patch selecting
the Cloudflare drivers. Long term, maintain a Twenty source fork or contribute
the driver interfaces upstream; avoid accumulating opaque edits to compiled
JavaScript.

## Delivery plan

### Phase 0 — Contract inventory and clean-room boundary (2-3 days)

- Record the exact Redis call sites from the pinned image.
- Extract executable interface contracts from source maps.
- Decide whether Meowdis can be licensed; otherwise document a clean-room
  boundary.
- Add `REDIS_BACKEND=redis|cloudflare` without changing production behavior.

Gate: complete responsibility inventory and unchanged current deployment.

### Phase 1 — State DO and container gateway (1-2 weeks)

- Implement sharded KV, set, hash, counter, lock, and idempotency operations.
- Add expiry cleanup and R2 export/import.
- Configure authenticated container outbound interception.
- Differential-test supported operations against current Redis behavior.

Gate: state operations pass concurrency, expiry, restart, and restore tests.

### Phase 2 — Cache and session cutover (1 week)

- Build the cache-manager and express-session stores.
- Patch the cache/session factories behind feature flags.
- Run browser login, logout, concurrent session, cache flush, permission, and
  workspace metadata tests.

Gate: seven-day canary with no session loss or cache correctness failures.

### Phase 3 — Cloudflare queue driver (1-2 weeks)

- Build producer, consumer, internal executor, retry mapping, dedupe, DLQ, and
  metrics.
- Preserve Twenty worker concurrency and graceful shutdown.
- Test every registered Twenty processor and failure mode.
- Initially keep `REDIS_QUEUE_URL` pointed at Redis for rollback.

Gate: no lost jobs under crash injection; retries, delays, and dedupe match the
defined contract.

### Phase 4 — Dynamic scheduler and priority (1 week)

- Implement schedule storage, alarm processing, remove/update behavior, and
  priority mapping.
- Compare scheduled occurrences against BullMQ for DST, timezone, missed-run,
  deploy, and duplicate-alarm scenarios.

Gate: scheduler differential suite passes and no duplicate logical occurrence
is observed.

### Phase 5 — Pub/sub and AI stream state (1-2 weeks)

- Replace GraphQL Redis subscriptions.
- Replace AI heartbeat, cancellation, and stream state calls.
- Test WebSocket reconnects, multiple server instances, container sleep, and
  network interruption.

Gate: all direct Redis call sites are removed or disabled.

### Phase 6 — Production migration (1 week plus observation)

- Canary one subsystem at a time: cache, sessions, ordinary jobs, cron jobs,
  pub/sub.
- Keep Redis available for rollback but stop writing to each migrated
  subsystem.
- Drain BullMQ before moving job production.
- Delete `REDIS_QUEUE_URL`, then finally `REDIS_URL`, only after the zero-Redis
  acceptance suite passes.

Gate: 14 days without Redis traffic, unknown adapter calls, lost jobs, session
loss, or subscription divergence.

## Acceptance criteria

- Twenty server and worker start with neither `REDIS_URL` nor
  `REDIS_QUEUE_URL`.
- Login/session survives server sleep, restart, and redeploy.
- All Twenty cache operations have atomic equivalents.
- Locks cannot be released by a non-owner and stale owners are fenced.
- Every enqueued job is acknowledged only after the Twenty handler completes.
- Worker crash produces retry, not job loss.
- Delayed and recurring jobs execute once per logical occurrence within the
  agreed timing tolerance.
- DLQ replay is authenticated, idempotent, and auditable.
- GraphQL and AI stream events reconnect after container/DO eviction.
- State can be exported to R2 and restored in a drill.
- `/_status` reports each native component independently.
- Redis network traffic remains zero for 14 consecutive production days before
  Redis is decommissioned.

## Effort and recommendation

Expected effort:

- first useful milestone (State DO plus cache/session): 2-3 weeks;
- Cloudflare queue replacement: another 2-3 weeks;
- full Redis elimination including schedules and pub/sub: approximately
  6-10 engineering weeks plus canary observation.

This native-adapter architecture is the recommended route. It uses Meowdis's
best idea—Durable Object SQLite behind a gateway—without inheriting its limited
Redis compatibility or forcing Twenty/BullMQ through an emulated Redis server.

## Primary references

- Meowdis: https://github.com/zion-off/meowdis
- Twenty: https://github.com/twentyhq/twenty
- Cloudflare Queues:
  https://developers.cloudflare.com/queues/configuration/javascript-apis/
- Durable Object SQLite:
  https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
- Durable Object alarms:
  https://developers.cloudflare.com/durable-objects/api/alarms/
- Durable Object WebSockets:
  https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- Container outbound interception:
  https://developers.cloudflare.com/durable-objects/api/container/
- Workflows:
  https://developers.cloudflare.com/workflows/
