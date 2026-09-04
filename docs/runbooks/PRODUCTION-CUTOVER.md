# Controlled Redis-free production cutover

The cutover is deliberately blocked until enterprise gates G0–G12 and the
production security preflight pass. G13 is the post-cutover observation gate.
Do not set the approval variable to bypass a failed preflight.

## Dry run

```sh
npm run cutover:production -- --dry-run
```

The dry run records the current Worker version and `/_status` snapshot in
`docs/evidence/g13-production-cutover.json` without changing production.

## Authorized cutover

After production Access/IdP/MFA, WAF, Logpush, external PostgreSQL, and Worker
secrets are provisioned and G0–G12 are passed:

```sh
CUTOVER_APPROVAL=CUTOVER_APPROVAL_REQUIRED npm run cutover:production
```

The command snapshots the current version, deploys the exact `wrangler.jsonc`
artifact, verifies `/_status` reports `redisBackend=cloudflare`,
`productionReady=true`, and `durableRedis=true`, and automatically rolls back
to the snapshot if health validation fails. G13 observation must then be
enabled with the repository variable `G13_OBSERVATION_ENABLED=true`.

Production remains unchanged until the explicit approval variable is supplied
and all preflights pass.
