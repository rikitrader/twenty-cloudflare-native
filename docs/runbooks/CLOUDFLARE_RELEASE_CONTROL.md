# Cloudflare-controlled Twenty releases

## Purpose

Twenty server and worker restarts never initialize, migrate, or register cron
jobs. The `twenty-crm-release` Worker owns those operations through a durable,
audited Cloudflare Workflow.

PGlite is intentionally excluded from production. It is an embedded,
single-connection database and cannot safely provide the shared concurrent
PostgreSQL service required by the separate Twenty server and worker
Containers.

## One-time provisioning

Configure these secrets on `twenty-crm-release`:

- `NEON_API_KEY`
- `NEON_PROJECT_ID`
- `NEON_PARENT_BRANCH_ID`
- `NEON_DATABASE_NAME`
- `NEON_ROLE_NAME`
- `RELEASE_TOKEN`

The controller obtains the existing PostgreSQL and application-encryption
credentials only through the private `ReleaseControlService` binding. They are
validated against the D1 release state and are never duplicated as controller
secrets.

Configure these GitHub Actions secrets:

- `CLOUDFLARE_API_TOKEN`
- `RELEASE_TOKEN`
- `RELEASE_ACCESS_CLIENT_ID`
- `RELEASE_ACCESS_CLIENT_SECRET`

Create a Cloudflare Access self-hosted application covering:

`twenty-crm-release.rikitrader.workers.dev/v1/releases/*`

The allow policy must accept only the GitHub Actions service token. The Worker
also requires the independent `RELEASE_TOKEN` bearer credential.

## Initial bootstrap

1. Apply D1 migration `0004_release_control.sql`.
2. Deploy `twenty-crm` once to publish `ReleaseControlService` and the
   maintenance gate.
3. Deploy `twenty-crm-release`.
4. Set the release Worker secrets above.
5. Record the currently deployed application-image digest as the initial
   `deployed` release in D1.
6. Delete the obsolete `RUN_NEON_INIT` production secret if it exists.
7. Trigger a no-database-change release and verify its final state is
   `deployed`.

## Normal automatic release

1. CI builds the exact production image and records its SHA-256 image ID.
2. Static, security, vulnerability, cost, and enterprise gates run.
3. CI deploys the release controller from the same commit.
4. The Workflow creates a minimum-compute Neon branch with two-hour expiry.
5. The candidate image runs its strict migration against the branch.
6. The Workflow deletes the branch.
7. The Workflow acquires the D1 production release lock.
8. Production enters maintenance and both application Containers stop.
9. A fresh PostgreSQL dump is checksummed, stored in R2, and recorded in D1.
10. The candidate image migrates production and registers schedules once.
11. The Workflow pauses in `ready_to_deploy`.
12. CI deploys the prepared production Worker version.
13. CI sends the exact Cloudflare version ID back to the Workflow.
14. The Workflow starts and verifies the server and worker internally.
15. Maintenance clears only after every verification succeeds.

An application image digest that already has a successful database release
skips Neon compute, backup, and migration. This keeps Worker-only beta releases
fast and inexpensive.

## Failure policy

- Before production migration starts: clean up the branch and migrator, clear
  maintenance, release the lock, and mark the release `failed`.
- After production migration starts: mark `needs_review`, retain maintenance,
  retain the lock, and do not retry or restore automatically.
- Never restore a dump over the live database automatically.
- Before manual recovery, inspect the D1 release event ledger, Workflow status,
  migration Container logs, backup checksum, and PostgreSQL schema state.

## Operator checks

```sh
npx wrangler workflows instances describe twenty-release <release-id> \
  --config wrangler.release.jsonc

npx wrangler d1 execute OPS_DB --remote \
  --command "SELECT * FROM release_runs ORDER BY created_at DESC LIMIT 5"

curl -H "Authorization: Bearer \$RELEASE_TOKEN" \
  "https://twenty-crm-release.rikitrader.workers.dev/v1/releases/<release-id>"
```
