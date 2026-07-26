# Meowdis as Twenty's Redis Backend: Feasibility and Implementation Plan

Date: 2026-07-24

> Update: after inspecting the exact Twenty v2.20 image and finding its
> `MessageQueueDriver` abstraction, the preferred design is now a native
> Cloudflare adapter rather than RESP/BullMQ emulation. See
> `CLOUDFLARE-NATIVE-REDIS-ELIMINATION-PLAN.md`. This document remains the
> feasibility record for the Redis-emulation alternative.

## Decision

Do not replace `REDIS_URL` with the current Meowdis endpoint.

Meowdis is useful source material for a Cloudflare-native persistent store, but
it is not presently compatible with Twenty's Redis usage. A direct cutover
would prevent BullMQ workers from starting and would risk losing or corrupting
background jobs.

Proceed only as a gated engineering project: fork Meowdis, add a local Redis
RESP gateway to the Twenty server and worker containers, and implement the
exact Redis/BullMQ behavior required by the Twenty v2.20 image. Keep the current
Redis path as the production fallback until all acceptance gates pass.

## What was inspected

- Local deployment: `twenty-cf`, including `wrangler.jsonc`,
  `src/containers.ts`, `src/types.ts`, `Dockerfile.production`, and the existing
  migration runbook.
- Pinned runtime: `twentycrm/twenty` image digest
  `sha256:d3dd949725e6196c57dab66ebe83ba9cdd2561885c35f94ef20f9ae38cd6d333`
  (documented locally as Twenty v2.20).
- Meowdis: `zion-off/meowdis` commit
  `99c36621ad55a2950efb7857a69279cf80b7ff35`, dated 2026-03-10.
- BullMQ's current compatibility and production guidance.
- Current Cloudflare Workers, Containers, and Durable Objects networking and
  persistence documentation.

The Meowdis unit suite passes (33 tests). A clean TypeScript check does not:
the package currently lacks compatible Node/Vitest type configuration.

## Compatibility findings

| Requirement from Twenty/BullMQ | Current Meowdis | Result |
| --- | --- | --- |
| Redis RESP over a persistent TCP connection | Upstash-style HTTPS POST API | Blocker |
| Redis 6.2-compatible behavior | 37 basic commands | Blocker |
| Lua scripts (`EVAL`, `EVALSHA`, `SCRIPT LOAD`) | Not implemented | Blocker |
| Sorted sets for delayed, priority, and scheduled jobs | Not implemented | Blocker |
| Streams for queue events | Not implemented | Blocker |
| Blocking worker connections/commands | Not implemented | Blocker |
| Transactions and atomic multi-key queue transitions | Per-command SQLite transactions; no Redis transaction API | Blocker |
| `INFO` and server capability/version checks | Not implemented | Blocker |
| Pub/sub or equivalent wake-up signaling | Not implemented | Blocker |
| Hash/list/set primitives | Partially implemented | Insufficient |
| Durable persistence | Durable Object SQLite | Good foundation |
| Single-writer serialization | One global Durable Object | Correct but a scaling bottleneck |
| Production license | No license file found | Legal blocker until clarified |

Meowdis's "drop-in replacement for Upstash Redis" claim is limited to the
Upstash REST API and the commands listed in its README. Twenty does not use the
Upstash REST SDK; BullMQ connects through `ioredis` and requires blocking
connections, Lua scripts, sorted sets, streams, and atomic queue transitions.

## Recommended target architecture

```text
TwentyServer container                  TwentyWorker container
  Twenty / BullMQ                         Twenty / BullMQ
       | redis://127.0.0.1:6379                | redis://127.0.0.1:6379
       v                                         v
  local RESP gateway                       local RESP gateway
       | authenticated HTTP/RPC                 |
       +-------------------+---------------------+
                           v
                Meowdis/BullMQ Durable Object
                  - SQLite persistent storage
                  - atomic BullMQ operations
                  - waiter/event coordination
                           |
                           v
                    R2 logical exports
```

The local gateways solve the transport mismatch without initially forking
Twenty: BullMQ continues to see a normal Redis connection on localhost.
Cloudflare Containers can route outbound HTTP into Worker code, and the
Durable Object remains the authoritative persistent store.

Do not implement a general Redis clone or a general Lua interpreter in phase
one. Pin the BullMQ version in the Twenty v2.20 image and implement:

1. the ordinary Redis commands observed in an integration trace; and
2. first-class atomic Durable Object operations corresponding to that pinned
   BullMQ version's Lua scripts.

The gateway should recognize scripts by content/SHA and dispatch them to the
matching atomic operation. Unknown commands or scripts must fail closed and
emit a metric; they must never approximate queue behavior.

## Implementation phases and gates

### Phase 0 — Ownership and reproducibility (1-2 days)

- Obtain a license or written permission for Meowdis. If that is not possible,
  reimplement the small useful concepts rather than copying its source.
- Create an organization-owned fork pinned by commit SHA.
- Add an SBOM, dependency audit, release tags, and a Cloudflare compatibility
  date matching `twenty-cf`.
- Fix TypeScript configuration so tests, typecheck, lint, and deploy dry-run all
  pass in CI.

Gate: licensed source, reproducible build, green CI. Otherwise stop.

### Phase 1 — Capture Twenty's exact Redis contract (2-4 days)

- Extract the exact BullMQ and `ioredis` versions from the pinned production
  image.
- Run the Twenty server and worker against a disposable Redis/Valkey instance
  with command tracing enabled.
- Exercise login/session behavior, CRUD, workflows, webhooks, cron
  registration, delayed jobs, retries, failures, worker restart, and queue
  events.
- Produce a machine-readable command/script manifest:
  command name, arguments, blocking behavior, script SHA/body, key patterns,
  expected atomicity, and response encoding.
- Add a replay harness that runs the captured contract against both Redis and
  the candidate backend and compares results.

Gate: the manifest covers every exercised Twenty/BullMQ flow and can be replayed.

### Phase 2 — Persistent BullMQ storage core (2-4 weeks)

- Extend the Durable Object schema with:
  - sorted sets with deterministic score/member ordering;
  - streams and consumer/event offsets if required by the pinned BullMQ build;
  - queue metadata, delayed jobs, priorities, locks, rate limits, dependencies,
    and stalled-job state;
  - expiration indexes and alarm-driven cleanup.
- Implement each captured BullMQ Lua script as one synchronous Durable Object
  storage transaction.
- Implement fencing tokens and lock-renewal semantics.
- Implement blocked-worker wait registration and wake-up without polling the
  database continuously.
- Add size limits, backpressure, request deadlines, and structured errors.
- Replace `KEYS`-style scans in production paths with indexed/paginated
  operations.

Gate: differential contract tests pass against Redis for every captured
operation, including concurrent producers/workers and injected failures.

### Phase 3 — RESP gateway (1-2 weeks)

- Build a small, audited RESP2 server that listens only on
  `127.0.0.1:6379` inside each Twenty container.
- Support connection state, pipelining, binary-safe bulk strings, `AUTH`,
  `SELECT` policy, `CLIENT`, `INFO`, script registration, blocking calls, and
  the exact command set from Phase 1.
- Forward operations over authenticated internal HTTP/RPC to the Durable
  Object. Do not expose the gateway publicly.
- Add health/readiness checks; Twenty must not start until the gateway and
  storage backend are ready.
- Package the gateway in `Dockerfile.production` and start it in both
  `TwentyServer` and `TwentyWorker` entrypoints.

Gate: unmodified Twenty v2.20 starts with
`REDIS_URL=redis://127.0.0.1:6379` and passes the integration suite.

### Phase 4 — Integrate into `twenty-cf` behind a flag (3-5 days)

Expected repository changes:

- `wrangler.jsonc`: add the storage Durable Object binding/migration and
  optional R2 export binding.
- `src/containers.ts`: register the container outbound handler, inject
  `REDIS_URL=redis://127.0.0.1:6379`, gateway auth, and backend location.
- `src/types.ts`: add `REDIS_BACKEND=external|meowdis` and related secret
  bindings. Stop using mere `REDIS_URL` presence as the mode selector.
- `Dockerfile.production`: install the pinned gateway binary and supervised
  entrypoint.
- `src/index.ts`: expose authenticated operational health only; no public data
  API.
- Tests: backend routing, startup ordering, fail-closed behavior, and rollback.

Use a configuration flag, not secret deletion, for switching backends:

```text
REDIS_BACKEND=external  -> current production REDIS_URL
REDIS_BACKEND=meowdis   -> local gateway -> Durable Object
```

Gate: changing the flag and restarting containers performs a clean rollback
without rebuilding images or changing Twenty data.

### Phase 5 — Shadow and canary (1-2 weeks)

- Start with a non-production Twenty workspace.
- Mirror safe producer operations to the candidate backend and compare queue
  state asynchronously. Never allow both backends to execute the same job.
- Run fault injection: container sleep/restart, worker crash after lock
  acquisition, duplicate delivery, timeout, Durable Object eviction, network
  interruption, expired locks, and deployment rollback.
- Load test at at least 5x observed peak job rate and queue depth.
- Run a single canary worker/backend only after shadow results are clean.

Gate for production:

- zero unexplained state divergences;
- no lost jobs;
- duplicate delivery no worse than BullMQ's documented at-least-once failure
  case;
- delayed/repeatable jobs execute within the agreed tolerance;
- recovery succeeds after every injected failure;
- p95/p99 latency and Cloudflare cost are acceptable;
- 7 continuous days of canary stability.

### Phase 6 — Cutover and operations (2-3 days plus observation)

- Pause producers and recurring-job registration.
- Drain or explicitly migrate the current BullMQ queues. Do not copy arbitrary
  Redis keys without a versioned migration tool.
- Record queue counts and scheduled/repeatable job definitions.
- Switch `REDIS_BACKEND=meowdis`, start one worker, validate, then restore
  normal processing.
- Retain the former Redis backend read-only for the rollback window.
- Add dashboards and alerts for queue depth, oldest job age, active locks,
  stalled jobs, unknown commands/scripts, Durable Object errors, gateway
  reconnects, and export age.
- Export logical snapshots to R2 and perform scheduled restore drills.

Rollback trigger: any unknown script/command, missing scheduled job, sustained
queue divergence, unrecoverable lock state, or SLO breach. Pause producers,
switch back to the former backend, and reconcile jobs from the cutover ledger.

## Estimated effort

An honest production estimate is 6-10 engineering weeks for one experienced
engineer, excluding the canary observation period. The critical work is not
deploying Meowdis; it is reproducing BullMQ's atomic and blocking semantics.

If the primary objective is simply "no managed Redis vendor," the lower-risk
alternative is a self-managed Valkey deployment reachable through Cloudflare
Tunnel/VPC. It preserves BullMQ compatibility and is likely a 2-5 day project.
Running Valkey only on a Cloudflare Container disk is not durable: Cloudflare
documents that container disks are ephemeral after sleep/restart.

## Sources

- Meowdis repository and supported command list:
  https://github.com/zion-off/meowdis
- Twenty repository/stack:
  https://github.com/twentyhq/twenty
- Twenty local setup:
  https://docs.twenty.com/developers/contribute/capabilities/local-setup
- BullMQ Redis compatibility:
  https://docs.bullmq.io/guide/redis-tm-compatibility
- BullMQ connections and blocking requirements:
  https://docs.bullmq.io/guide/connections
- BullMQ production persistence and eviction guidance:
  https://docs.bullmq.io/guide/going-to-production
- Cloudflare Workers protocol support:
  https://developers.cloudflare.com/workers/reference/protocols/
- Cloudflare Container TCP port API:
  https://developers.cloudflare.com/durable-objects/api/container/
- Cloudflare Container disk lifecycle:
  https://developers.cloudflare.com/containers/platform-details/architecture/
