# Project memory

Updated: 2026-09-17

Production is `twenty-crm` at
`https://twenty-crm.observatorio-publico.workers.dev`. The upstream Twenty
interface is served by Workers Static Assets. D1 bindings `CRM_DB` and `OPS_DB`
store authoritative data, R2 stores files, Queues and Workflows own background
work, Durable Objects coordinate state, and KV stores disposable status data.
The private publication repository is
`https://github.com/rikitrader/twenty-cloudflare-native`; its `main` branch is
the reviewable source for this Cloudflare-native derivative.

Production must not gain an external database, Redis service, persistent local
disk, or traditional application host. Historical Durable Object class exports
exist only for safe namespace migration history and are not bound.

Security invariants:

1. Server-side membership and permissions govern every tenant operation.
2. Unknown GraphQL operations fail closed.
3. Mutations complete synchronously or are durably accepted before success.
4. R2 operations validate tenant ownership.
5. Secrets remain Cloudflare secrets and never appear in evidence.
6. Time-based and security gates are never marked complete without evidence.

The read-only legacy-data extractor and resumable D1/R2 reconciliation pipeline
require an authorized real source export for a customer cutover; sample data is
not accepted as production evidence. Release sources of truth are
`wrangler.jsonc`, `FULL-PARITY-TODO.md`, and current files in `docs/evidence/`.
