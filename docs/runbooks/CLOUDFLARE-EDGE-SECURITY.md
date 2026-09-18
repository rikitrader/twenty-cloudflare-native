# Cloudflare edge-security runbook

The production Worker is available on `crm.mipolitico.com` (zone
`mipolitico.com`) and the compatibility workers.dev hostname. Zone WAF rules
protect only the custom hostname. Workers observability is enabled separately;
it is not a substitute for Logpush.

## Required least-privilege access

Use a short-lived API token scoped to account
`0dd0d155f8dafdca9d2bade1141986a2` and zone
`a331800c10c2d88ef61b99ab9763f15b` with only:

- Zone WAF/Rulesets read and edit for `mipolitico.com`.
- Account Logpush read and edit for inspection and job configuration.

Do not put the token or Logpush destination credentials in this repository,
shell history, browser bundles, evidence, or logs.

## Inspect

```bash
export CLOUDFLARE_ACCOUNT_ID=0dd0d155f8dafdca9d2bade1141986a2
export CLOUDFLARE_ZONE_ID=a331800c10c2d88ef61b99ab9763f15b
export CLOUDFLARE_API_TOKEN='set-outside-the-repository'
npm run edge-security:inspect
```

The command fails on denied API access; it never reports a successful
inspection from an empty or unauthorized response.

## WAF staged rollout

`npm run edge-security:waf:stage` idempotently creates two host-scoped custom
rules with stable refs. Both are deliberately **disabled** on creation:

- block TRACE/CONNECT on `crm.mipolitico.com`;
- block common source/secret-file probes on `crm.mipolitico.com`.

After staging, leave the rules disabled while production authentication,
GraphQL/metadata, uploads, OAuth callbacks, and both webhook directions are
exercised. Review Security Events for false positives. Enable one rule at a
time only during an approved change window, then repeat the journeys. Do not
copy these rules to unrelated hostnames.

Managed rules and rate limiting must follow the same observe-first rollout.
The account plan/entitlement determines which managed rulesets, logging mode,
and rate-limit characteristics are available; the runbook does not pretend an
unavailable control exists.

## Logpush staged rollout

The destination must be customer-owned, encrypted at rest, access-controlled,
and configured with an explicit retention policy. Complete the provider's
ownership challenge first, then pass its destination string without writing it
to disk:

```bash
export LOGPUSH_DESTINATION_CONF='provider-specific secret destination string'
npm run edge-security:logpush:stage
```

This creates a disabled `workers_trace_events` job named
`twenty-crm-workers-traces`; it refuses to create a duplicate. Verify a test
delivery at the destination, confirm timestamps and Worker events, restrict
destination readers, and only then enable the job in Cloudflare. Record the job
ID, dataset, enabled state, first delivered timestamp, retention period, and a
redacted destination identifier in `docs/evidence/`. Never record destination
credentials.

## Current blocker

The Wrangler OAuth grant used for deployment has zone read but no WAF edit or
Logpush read/write scope. The custom hostname and persisted Workers logs/traces
are live; WAF rules and Logpush delivery are not yet verified or claimed as
configured.
