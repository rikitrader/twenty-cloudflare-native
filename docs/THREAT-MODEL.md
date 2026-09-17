# Cloudflare-native threat model

Protected assets are tenant CRM data, sessions and permissions, R2 files,
durable job receipts, and secrets. Trust boundaries are browser-to-Worker,
Worker-to-Cloudflare bindings, background execution, and allowlisted providers.

Required controls:

- Resolve identity from a verified session or Cloudflare Access token.
- Derive workspace membership server-side; never trust a client tenant ID.
- Enforce permissions before every read and mutation.
- Authorize every R2 key by workspace ownership.
- Persist a mutation or durably accept it before returning success.
- Make Queue deliveries idempotent and record retries and dead letters.
- Sign outbound webhooks and authenticate inbound receivers.
- Keep secret values out of source, browser bundles, logs, and evidence.
- Preserve current WAF, Logpush, binding, and secret-name evidence.

For an incident, revoke affected credentials, rotate the relevant secret,
disable compromised integrations, preserve evidence, and reconcile durable
receipts before replaying work.
