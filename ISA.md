---
project: twenty-cf
task: Deploy Twenty CRM on Cloudflare, maximum-native stack
effort: E3
phase: verify
progress: 10/12
mode: build
started: 2026-07-10
updated: 2026-07-10
---

## Problem
Twenty CRM (NestJS/TypeORM/BullMQ monolith) has no Cloudflare deployment path; user wants it on a Cloudflare-first stack without forking the app.

## Vision
`twenty-crm.rikitrader.workers.dev` opens Twenty instantly; every Cloudflare primitive that has a real, non-fork insertion point is in use; flipping to persistent external databases is a secret-swap, not a rebuild.

## Out of Scope
Forking/rewriting Twenty (D1, KV-as-Redis, CF Queues-for-BullMQ, Workflows); Pages split of the frontend; custom domain; Cloudflare Access policy (optional follow-up).

## Constraints
Zero code changes to Twenty. Images pinned (v2.20). Secrets only in Worker Secrets. Ship cycle: branch→PR→merge→deploy queue.

## Goal
Twenty live on Cloudflare Containers behind a Worker using Workers+DO+KV+R2+Cache+Cron Triggers now, with external-DB mode (Neon/Hyperdrive+Upstash+R2) activating automatically when credentials land.

## Criteria
- [x] ISC-1: `GET /healthz` returns 200 via workers.dev
- [x] ISC-2: `GET /` serves Twenty React shell
- [x] ISC-3: `POST /graphql` answers introspection
- [x] ISC-4: Container app active with ≥1 instance on demand
- [x] ISC-5: KV-served `GET /_status` returns JSON without waking container
- [x] ISC-6: R2 bucket `twenty-storage` exists
- [x] ISC-7: Cron trigger `0 12 * * 1-5` registered on deploy
- [x] ISC-8: Dual-mode routing code deployed (external classes defined, migration v2)
- [x] ISC-9: Typecheck clean (`tsc --noEmit`)
- [x] ISC-10: PR merged; deploy from merged main via ship-deploy queue
- [x] ISC-11: hybrid-Neon mode live — Twenty serves on :2020 against Neon Postgres (795KB, 69 tables); Upstash not needed (local Redis retained)
- [ ] ISC-12: Anti: no secret string appears in any tracked file (verify: `git grep -iE 'postgres://[^t]|rediss://|AKIA'` — only the localhost default may match)
- [x] ISC-13: webhook endpoint rejects bad token (401), accepts valid (202), rejects malformed (400)
- [x] ISC-14: queue consumer lands webhook event as D1 `events` row
- [x] ISC-15: deploy registers both crons, queue producer+consumer, `twenty-backup` workflow
- [x] ISC-16: unit suite green — 8/8 vitest
- [x] ISC-17: `STORAGE_S3_ACCESS_KEY_ID`/`STORAGE_S3_SECRET_ACCESS_KEY` used (upstream names), AWS_* as aliases
- [x] ISC-18: `ENCRYPTION_KEY` supported + set; `FALLBACK_ENCRYPTION_KEY` plumbed; APP_SECRET legacy
- [x] ISC-19: manual `/_backup/run` → R2 object `backups/2026-07-11T0504.sql` (795690 B) + D1 ledger row status=ok
- [x] ISC-20: data persists across container restart — Neon is external, container is stateless (survives sleep/redeploy by construction)
- [x] ISC-21: Anti: backup never dumps an unsettled boot (external-PG path marks settled only after agent up; verified 795KB dump not seed-sized)
- [x] ISC-22: init-db override skips redundant remote migration — twenty-server binds :2020 in ~90s vs never (root-cause fix, docs/MIGRATION.md)

## Test Strategy
ISC-1..3,5 | HTTP | curl status+body | 200/shape | Bash
ISC-4,7 | CLI | wrangler containers list / deploy output | active/cron listed | Bash
ISC-9 | build | tsc --noEmit | exit 0 | Bash
ISC-12 | anti | git grep | no matches | Bash

## Decisions
- 2026-07-10: Containers over Tunnel+VPS (same isolation, no server). D1/KV/Queues/Workflows rejected — fork-only insertion points; documented in docs/MIGRATION.md.
- 2026-07-10: Dual-mode routing keyed on secret presence — activation without redeploy.
- 2026-07-10: Delegation floor show-my-math: Forge agent type absent from session registry; single-author ~150-line Worker, sequential chain.
- 2026-07-10: refined: `/_status` served from KV so uptime monitors don't defeat scale-to-zero.

## Changelog
- conjectured: pixel verification via Interceptor is always available → refuted_by: CLI absent from PATH, Chrome extension disconnected → learned: probe verification tooling during PLAN preflight, not at VERIFY → criterion_now: HTTP-evidence accepted, pixel QA tracked as deferred follow-up.

## Verification
- ISC-1: curl — HTTP 200 `{"status":"ok","info":{},"error":{},"details":{}}`
- ISC-2: curl — `<meta name="description" content="A modern open-source CRM" />`
- ISC-3: curl — `{"data":{"__typename":"Query"}}`
- ISC-4: `wrangler containers list` — twenty-crm-twentycontainer active, 1 live instance
- ISC-5..10: see PR #2 verification block in session vault
