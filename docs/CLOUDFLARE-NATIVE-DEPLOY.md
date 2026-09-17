# Cloudflare-native CRM deployment runbook

This runbook applies the checked-in D1 migrations and activates the native CRM
route only after a verified export and preview test. It never deletes or
modifies the PostgreSQL source.

## Preflight

```sh
npm ci
npm run typecheck
npm test -- --run
npm run db:migrations:check
npm run security:production:check
npx wrangler whoami
npx wrangler deploy --dry-run
```

The account printed by `wrangler whoami` must own the configured D1, R2,
Queues, Workflow, and Access resources. Stop if it does not.

## Create and migrate D1

Run once with the authorized production account:

```sh
npx wrangler d1 create twenty-crm
# Add the returned database_id to wrangler.jsonc.
npx wrangler d1 migrations apply CRM_DB --remote
```

For an isolated preview database, add `preview_database_id` and apply with
`--preview`. Verify the migration output reaches the latest checked-in file
(`0020_record_ownership.sql` or newer).

## Data transfer

1. Produce a read-only PostgreSQL NDJSON export using the approved exporter.
2. Run `npm run verify:crm-export -- --input export.ndjson --expected counts.json`.
3. Transfer with `npm run migrate:crm -- --input export.ndjson --endpoint https://<preview-host> --workspace-id <id> --access-token <token>`.
4. Poll `/api/crm/import/:runId` and compare counts and representative values.
5. Repeat against production during the approved write freeze. Keep the source
   database and attachments unchanged until rollback sign-off.

## Activation and rollback

Set `D1_NATIVE_MODE=true` only in the approved preview or production release.
Run the browser workflow and security gates, then monitor the outbox, export,
and migration status endpoints. Roll back by setting `D1_NATIVE_MODE=false`
and restoring the previous Worker version; do not delete D1 rows or source
records. Post-cutover writes must be reconciled before any retry.

For standard Observatorio members authenticated by Cloudflare Access, member
provisioning is an explicit change-control step: set
  `AUTO_PROVISION_ACCESS_MEMBERS=true` only after approving the target shared
  workspace and membership policy. It is enabled in the checked-in production
  configuration following that approval. Native password users must still be
  imported or created through the Twenty signup flow.

## Operations

- Failed CRM events: `GET /api/crm/outbox`, then replay with
  `POST /api/crm/outbox/:eventId/replay`.
- Export status: `GET /api/crm/exports/:id`; artifacts are tenant-prefixed in R2.
- D1 backups and Cloudflare audit logs are required before destructive changes.
- Invitations and profile settings are workspace-scoped and require Access
  identity plus active membership.
