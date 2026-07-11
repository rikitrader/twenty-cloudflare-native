# Twenty CRM → Cloudflare: Migration Architecture

Zero changes to Twenty's codebase. Everything below is deployment topology, env mapping, and Cloudflare config against the stock upstream images (plus a thin wrapper layer — `Dockerfile` + `cf/` — that adds a backup agent beside Twenty, not inside it).

## 0. Full-stack status (live)

| Service | Role | Status |
|---|---|---|
| Workers | Front door: routing, auth guards, status, cache | ✅ live |
| Durable Objects | 3 container classes, WS proxy, restore orchestration | ✅ live |
| Containers | All-in-one demo (wrapper image) + dormant server/worker pair | ✅ live |
| KV | `/_status` at edge + activity/backup timestamps | ✅ live |
| R2 | Backup store (`backups/`), attachments once S3 keys set | ✅ live |
| D1 `twenty-ops` | `events` (webhooks) + `backups` ledger | ✅ live |
| Queues `twenty-events` (+dlq) | Twenty webhooks → durable consumer → D1 | ✅ live |
| Workflows `twenty-backup` | idle-check → pg_dump via DO tunnel → R2 → verify → ledger | ✅ live |
| Cron Triggers | `0 12 * * 1-5` warm-up · `0 * * * *` backup | ✅ live |
| Cache API | Immutable frontend assets at edge | ✅ live |
| Worker Secrets | ENCRYPTION_KEY, APP_SECRET (legacy), BACKUP_TOKEN, WEBHOOK_TOKEN | ✅ set |
| Hyperdrive | One command once Neon exists | ⏳ user credentials |
| D1/KV/Queues *as Twenty's internals* | Impossible without forking (pg wire / Redis protocol / BullMQ) | ❌ documented |

**Ephemerality is mitigated**: hourly backups (skipped while idle) + restore-on-boot mean demo data survives sleeps and redeploys with RPO ≈ 1h. Production-grade persistence still = Neon/Upstash flip (§5).

**Webhook pipeline activation**: in Twenty → Settings → API & Webhooks → add target
`https://twenty-crm.rikitrader.workers.dev/webhooks/twenty?token=<WEBHOOK_TOKEN>`.

## 1. Dependency graph (from repo inspection)

```
twenty-server (NestJS 10, @nestjs/platform-express)
├─ TypeORM → pg wire protocol → PostgreSQL 16 (schema-per-workspace multi-tenancy)
├─ BullMQ → Redis (Lua scripts, blocking ops) — queues + repeatable (cron) jobs
├─ @nestjs/schedule + cron:register:all → BullMQ repeatable jobs
├─ GraphQL Yoga (@graphql-yoga/nestjs) + subscriptions (WebSockets)
├─ Auth: @nestjs/passport, JWT, SAML (@node-saml), MS/Google OAuth (optional)
├─ Storage driver: local FS │ S3 (@aws-sdk/client-s3, lib-storage, presigner)
├─ Email: @aws-sdk/client-sesv2 or SMTP (optional)
└─ Serves twenty-front React build (@nestjs/serve-static)
twenty-worker = same image, entrypoint `yarn worker:prod` (BullMQ consumer)
```

## 2. Subsystem disposition (decision per the 9 options)

| Subsystem | Disposition | Why |
|---|---|---|
| HTTP edge, routing, status | **1. Workers** (`src/index.ts`) | Native |
| Container lifecycle, WS proxy | **3. Durable Objects** (`Container` classes) | Native |
| NestJS server + GraphQL + auth + tenancy | **Cloudflare Containers** (`TwentyServer`) | Can't run in workerd (NestJS/TypeORM/node natives); Containers supersedes option 9 (Tunnel+VPS) — same isolation, no server to run |
| BullMQ worker | **Cloudflare Containers** (`TwentyWorker`) | Same |
| PostgreSQL | **8. Hyperdrive → Neon** | D1 = SQLite, no pg wire protocol → technically impossible without fork |
| Redis | **External (Upstash)** | Directive's own rule: "Redis only if no CF-native replacement" — KV/DO lack Redis protocol/Lua/blocking ops |
| BullMQ → Queues | **Rejected** | No feature parity (repeatable jobs, delayed jobs, Lua) without forking Twenty |
| File storage | **6. R2** via Twenty's native S3 driver | Env-only ✅ (bucket `twenty-storage` created) |
| Frontend assets | Served by container; **Cache API** at edge for immutable assets | Pages split possible but violates "least architectural change" (CORS/cookie/session split) |
| Cron | **Cron Triggers** (warm-up + status) + Twenty's in-app BullMQ cron | Both, complementary |
| Long-running jobs → Workflows | **Rejected** | Jobs live inside Twenty's BullMQ; no insertion point without fork |
| KV | Edge status cache (`/_status` never wakes container) | Real use, native |
| D1 | **Not appropriate** (documented limitation) | — |
| Zero Trust / Access | Optional post-deploy: Access app on the workers.dev route | Dashboard step |
| Cloudflare Images | Not applicable — attachments handled by Twenty/S3 | — |

## 3. Architecture

```
Users ──► Cloudflare DNS/WAF/Cache ──► Worker twenty-crm (src/index.ts)
    /_status ──► KV STATUS_KV (no container wake)
    immutable assets ──► Cache API
    everything else ──► DO ──► Container:
        MODE all-in-one (now): twenty-app-dev:v2.20 [PG+Redis+server+worker]
        MODE external-db (auto when secrets set): twenty:v2.20 server (:3000)
                                                  twenty:v2.20 worker (yarn worker:prod)
             ├─ PG_DATABASE_URL → Hyperdrive → Neon Postgres
             ├─ REDIS_URL → Upstash (rediss://)
             └─ STORAGE_TYPE=s3 → R2 twenty-storage
Cron Trigger (0 12 * * 1-5) ──► warm-up + KV status refresh
```

Mode flip is automatic: setting both `PG_DATABASE_URL` and `REDIS_URL` secrets switches routing to the external-DB classes on the next request. No code change, no image rebuild.

## 4. Environment variable mapping

| Twenty env | Source | Mode |
|---|---|---|
| `SERVER_URL` | wrangler var | both |
| `APP_SECRET` | Worker Secret (set) | both |
| `PG_DATABASE_URL` | Worker Secret (pending — Neon/Hyperdrive string) | external |
| `REDIS_URL` | Worker Secret (pending — Upstash `rediss://`) | external |
| `STORAGE_TYPE=s3`, `STORAGE_S3_NAME/ENDPOINT/REGION` | auto-set when R2 keys present | external |
| `STORAGE_S3_ACCESS_KEY_ID` / `STORAGE_S3_SECRET_ACCESS_KEY` | Worker Secrets (pending — R2 API token); `AWS_*` also passed as legacy aliases | external |
| `ENCRYPTION_KEY` / `FALLBACK_ENCRYPTION_KEY` | Worker Secrets (`ENCRYPTION_KEY` set; fallback used during rotation) | both |
| `BACKUP_TOKEN` | Worker Secret → container agent auth (`/_agent/*`, `/_backup/run`) | demo |
| `WEBHOOK_TOKEN` | Worker Secret → webhook URL query token | both |
| `DISABLE_DB_MIGRATIONS` / `DISABLE_CRON_JOBS_REGISTRATION` | hardcoded per upstream compose (worker: true) | external |

## 5. Activation runbook (the only human steps)

```bash
# 1. Neon (free): create project → copy pooled connection string, then:
wrangler hyperdrive create twenty-pg --connection-string="postgres://...neon.tech/neondb?sslmode=require"
wrangler secret put PG_DATABASE_URL        # Neon string (or Hyperdrive-fronted string)
# 2. Upstash (free): create Redis → copy rediss:// URL, then:
wrangler secret put REDIS_URL
# 3. R2 keys: dash.cloudflare.com → R2 → Manage API Tokens → Object R/W on twenty-storage:
wrangler secret put AWS_ACCESS_KEY_ID
wrangler secret put AWS_SECRET_ACCESS_KEY
wrangler secret put STORAGE_S3_ENDPOINT    # https://<account_id>.r2.cloudflarestorage.com
# 4. Redeploy (or just wait — secrets apply on next instance start):
npx wrangler deploy
```

## 6. CI/CD, rollback, monitoring, ops

- **CI/CD**: `.github/workflows/deploy.yml` — typecheck + `wrangler-action` on push to main. Needs repo secret `CLOUDFLARE_API_TOKEN`.
- **Local dev**: `bun install && bunx wrangler dev` (containers run locally via Docker when present).
- **Rollback**: `wrangler rollback` to a previous version ID, or `wrangler versions list` + redeploy of prior git tag. Container image is version-pinned (`v2.20`) — bump deliberately, never `latest`.
- **Monitoring**: Workers observability (enabled) + `GET /_status` (KV-served, zero container cost — point uptime monitors here, NOT at `/healthz`, or they'll keep the container awake).
- **Security**: secrets only in Worker Secrets; image pinned; optional Cloudflare Access in front; WAF at the edge by default.
- **Cost**: scale-to-zero. Demo mode awake ≈ $0.06/hr (standard-2 provisioned memory). External mode server+worker awake ≈ $0.07/hr combined but data persists so `sleepAfter` can drop to 10m. Neon/Upstash/R2 free tiers ≈ $0.
- **Scalability**: bump `max_instances` + route `getContainer(env.TWENTY_SERVER, workspaceId)` for per-tenant instances; Hyperdrive pools connections; R2 offloads disk.
