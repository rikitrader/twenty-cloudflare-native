# Controlled production cutover

1. Run typecheck, unit tests, GraphQL coverage, Playwright desktop/mobile, and
   dependency/security checks.
2. Confirm all D1 migrations are applied and R2/Queue/Workflow/DO/KV bindings
   match `wrangler.jsonc`.
3. Confirm required secret names exist; never export secret values.
4. Capture WAF, Logpush, Access/MFA, binding, and observability evidence.
5. Run `npm run cutover:production -- --dry-run` and retain the version/status
   snapshot.
6. Deploy, verify `/_status`, authentication, tenant isolation, CRUD, file
   authorization, Queue delivery, and `/_status/g3` collection.
7. Roll back to the recorded Worker version if health or smoke checks fail.

Time-based gates remain open until their full observation window completes.
