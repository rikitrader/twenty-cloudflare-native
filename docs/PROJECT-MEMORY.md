# Project memory

Updated: 2026-09-17

Production is `twenty-crm` at the zone hostname `https://crm.mipolitico.com`,
with `https://twenty-crm.observatorio-publico.workers.dev` retained for
backward compatibility. The upstream Twenty
interface is served by Workers Static Assets. D1 bindings `CRM_DB` and `OPS_DB`
store authoritative data, R2 stores files, Queues and Workflows own background
work, Durable Objects coordinate state, and KV stores disposable status data.
The public open-source publication repository is
`https://github.com/rikitrader/twenty-cloudflare-native`; its `main` branch is
the reviewable source for this Cloudflare-native derivative. It is also a
GitHub template repository with Issues, Discussions, secret scanning, push
protection, Dependabot, and private vulnerability reporting enabled.

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
remain available, but the owner confirmed on 2026-09-17 that legacy-data
migration is not applicable: this is a fresh Cloudflare-native deployment with
no PostgreSQL records or attachments to preserve. Release sources of truth are
`wrangler.jsonc`, `FULL-PARITY-TODO.md`, and current files in `docs/evidence/`.

Schema migrations through `0055_provider_callback_origin.sql` are applied to
production CRM and ops D1 databases. They add durable operational-continuity
samples, encrypted Google/Microsoft integration state, and origin-bound OAuth
callbacks for both production hostnames. Production version
`3aaed4c1-6f50-45a1-968e-5e040fe3640b` is the current production version; it
retains persistent invocation logs,
sampled traces, query-string redaction, and the custom hostname. WAF and
Logpush remain gated because the authenticated automation grant lacks those
permissions; do not describe either as configured. The new continuity window
starts with its first post-deploy 15-minute sample and cannot complete before
seven real days have elapsed.
