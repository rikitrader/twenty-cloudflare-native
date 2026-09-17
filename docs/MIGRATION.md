# Cloudflare-native migration

Production runs entirely on Cloudflare: Workers and Static Assets serve the
application, D1 stores relational CRM and operational data, R2 stores files,
Queues and Workflows execute durable background work, Durable Objects provide
coordination, and KV stores disposable status/cache data.

The production Worker has no external database, Redis service, persistent
filesystem, or always-running server dependency. Historical Durable Object
migration class exports are retained only so Cloudflare can preserve namespace
history; they are not runtime bindings.

Existing customer data can be imported with the read-only extraction and
reconciliation tools documented in `PRODUCTION-CUTOVER-TODO.md`. Source data is
never modified. The normalized bundle is validated, written to D1 and R2 in
resumable batches, and reconciled before cutover.

Authoritative configuration is `wrangler.jsonc`. Release gates and evidence
are tracked in `FULL-PARITY-TODO.md` and `docs/evidence/`.
