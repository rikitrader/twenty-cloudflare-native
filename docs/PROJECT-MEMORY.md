# Twenty CRM on Cloudflare — project memory

Last updated: 2026-07-27

## Canonical production

- Main application: <https://twenty-crm.rikitrader.workers.dev/>
- Cloudflare Worker: `twenty-crm`
- Production database: Neon PostgreSQL.
- Production is currently healthy in `external-db` mode.
- Last observed production Worker version:
  `5de997b6-6095-41d0-a9b2-15a28dacab64`.
- The live frontend still served the older `index-CIzqhGD8.js` bundle at the
  last check. The v2.24.1 candidate serves `index-D5fIvGAM.js`; therefore
  v2.24.1 was not deployed at that time.

## Hard requirements

1. The architecture must remain Redis-free.
2. Never add Redis, `redis-server`, `REDIS_URL`, Upstash, or a Redis container
   as a workaround, fallback, rollback target, or canary dependency.
3. Rewrite/adapt upstream Twenty Redis assumptions to Cloudflare Durable
   Objects, Queues, scheduler, and pub/sub gateways.
4. Keep Twenty connected to Neon.
5. Keep one primary Cloudflare project and one canonical production URL.
6. Production topology is limited to:
   - one normally running Twenty server container;
   - one normally running Twenty worker container;
   - one short-lived backup/release container;
   - maximum three involved containers.
7. Retire temporary/canary Workers and container definitions after drills.
8. Do not bypass readiness or security gates merely to deploy faster.
9. Do not claim a time-based soak passed by running its samples rapidly.

Some upstream-compatible status and adapter names still contain the word
`redis`, including `redisBackend` and `durableRedis`. These are compatibility
field names, not evidence of a Redis process. The required runtime value is
`redisBackend: "cloudflare"`. Production and candidate images must contain no
Redis server or Redis URL.

## Twenty v2.24.1 candidate

- Registry release verified as `v2.24.1`.
- Production image is pinned to:
  `twentycrm/twenty@sha256:cd812094cd3439e91deaf727470ecb302129447306200fff853ba0d7e9609079`.
- Canary also uses the Redis-free production image family. Never restore
  `twentycrm/twenty-app-dev` as a deployable canary base because it bundles
  Redis configuration.
- The frontend auth-revocation patch was adapted to the v2.24.1 bundle.
- Vulnerability patches include `tar@7.5.20` and
  `brace-expansion@5.0.8` with a CommonJS compatibility adapter.
- Database upgrade was tested from a disposable seeded v2.20 database to
  v2.24.1, including an interrupted and idempotently resumed upgrade.
- Before production deployment, run the release preflight against a temporary
  Neon branch and preserve the production backup/rollback controls.
- Last complete local validation:
  - 24 test files passed;
  - 153 tests passed;
  - TypeScript typecheck passed;
  - production security configuration passed;
  - runtime/static Twenty contracts passed;
  - 90/90 processor idempotency checks passed;
  - dependency audit found no known vulnerabilities;
  - image scan found zero HIGH and zero CRITICAL findings;
  - production candidate contained no `redis-server` or `REDIS_URL`;
  - reproducible image builds passed.

## Enterprise gates

- G12 Redis-free rollback: passed.
  - 25 delayed jobs enqueued;
  - 25 completed;
  - zero missing;
  - backend remained Cloudflare;
  - Worker rollback completed in 34.203 seconds;
  - production version was unchanged.
- G3 session/cache continuity: partial.
  - It is a seven-day continuity test, not a batch test.
  - Required: 673 boundary-inclusive samples, approximately every 15 minutes.
  - Last observed: 12 consecutive passing samples, zero failures, approximately
    2.75 hours collected.
  - Rapidly executing 673 samples would not validate TTL, sleep/wake,
    maintenance, scheduling, or multi-day stability.
- G10 security: partial.
  - repository security preflight passed;
  - production Cloudflare Access enforcement returned the expected login
    redirect;
  - production Worker secrets included database, encryption, internal service,
    storage, backup, operations, and webhook secrets;
  - WAF and Logpush could not be independently inspected because the available
    Cloudflare API connection returned an authentication/scope error.
- G13 production observation: blocked until the controlled v2.24.1 cutover.
  It is a post-cutover gate and must not be required before cutover.
- The cutover preflight must require G0 through G12 plus production security.
  It must not circularly require G13.

## Canary and cost status

- The temporary Worker `twenty-crm-redis-free-canary` was deleted after G12.
- Its URL returned 404 and Cloudflare reported that the Worker no longer
  existed.
- Consumers were removed from:
  - `twenty-jobs-canary-v2`;
  - `twenty-jobs-canary-v2-dlq`;
  - `twenty-redis-canary-probe`.
- Those queues had zero consumers after retirement.
- The canary D1 operations ledger was preserved as rollback evidence.
- Do not leave a canary container deployable or running merely to collect G3;
  production collects G3 samples using its existing scheduled handler.

## Merge versus deploy

- Merging means saving the validated v2.24.1 implementation into the main
  project history.
- Deploying means changing the live customer application and database runtime.
- The candidate was considered technically ready to merge.
- It was not considered safe to describe as an issue-free production deploy
  while G3, G10, the Neon branch preflight, and post-cutover G13 remained.
- Never promise that a production deployment will have "no issues"; report the
  passed evidence and remaining risks precisely.

## Console-error context

- Browser messages from `contentscript.js`, `injected.js`, `evmAsk.js`,
  `ObjectMultiplex`, `ethereum`, or listener limits are typically injected by
  wallet/browser extensions rather than Twenty.
- `Cloudflare state /v1/state/set failed (400): invalid body size` originates
  from the application/state integration and must be treated separately from
  extension noise.
