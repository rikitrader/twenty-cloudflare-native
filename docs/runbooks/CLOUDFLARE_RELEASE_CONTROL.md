# Cloudflare-native release control

Releases are Worker versions deployed from the reviewed repository state.
`wrangler.jsonc` is the binding contract. D1 migrations are applied explicitly
before code that requires them; long-running import/export/backup work runs in
Cloudflare Workflows.

Before deploy, run typecheck, unit and browser suites, migration checks, secret
name inspection, a dry-run bundle inspection, and production health smoke.
Record the active version for rollback. After deploy, verify authentication,
tenant isolation, CRUD, files, queues, webhooks, and status endpoints. Roll back
the Worker version on failure; never conceal a failed gate by editing evidence.
