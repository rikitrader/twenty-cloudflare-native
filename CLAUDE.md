# twenty-cf — Twenty CRM on Cloudflare

Stock Twenty (never forked) deployed on Cloudflare: Worker front door → Durable
Objects → Containers, with KV status, R2 backups + restore-on-boot, D1 ops store,
Queues webhook pipeline, Workflows backup orchestration, Cron Triggers.

- Live: https://twenty-crm.rikitrader.workers.dev · demo login `tim@apple.dev` / `tim@apple.dev`
- Architecture + activation runbook: `docs/MIGRATION.md`
- Criteria/verification: `ISA.md`
- External-DB (production) mode activates automatically when `PG_DATABASE_URL`
  and `REDIS_URL` secrets are set. R2 attachments need `STORAGE_S3_*` secrets.
- Deploy: `bun x wrangler deploy` (needs Docker running for the wrapper image).
  Always `unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID` first (OAuth session).
- Tests: `bun run test` (vitest). Typecheck: `bun x tsc --noEmit`.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec
