# twenty-cf — Twenty CRM on Cloudflare

Twenty CRM deployed as a Cloudflare-native Worker with D1, R2, KV, Queues,
Durable Objects, Workflows, and Cron Triggers.

- Live: https://twenty-crm.rikitrader.workers.dev · demo login `tim@apple.dev` / `tim@apple.dev`
- Architecture + activation runbook: `docs/MIGRATION.md`
- Criteria/verification: `ISA.md`
- Production requires no PostgreSQL, Redis, Docker, or external database.
- Production has no legacy server-process runtime. Historical Durable Object
  migration classes are unbound compatibility shims only.
- Deploy: `npm run deploy` or `npx wrangler deploy`.
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
