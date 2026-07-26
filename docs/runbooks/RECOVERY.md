# PostgreSQL and R2 recovery

## Safety boundary

The backup companion is read-only. It receives the source PostgreSQL URL only
to run `pg_dump`, exposes no public network address, and rejects restore
requests. Never provide a production or staging database URL to the recovery
target.

The automated drill restores into an exactly named disposable local container
whose database directory is tmpfs. It verifies the R2 manifest, byte count,
and SHA-256 before executing SQL. Cleanup removes only that generated
container and its generated temporary directory.

## Scheduled backup

The hourly Workflow performs:

1. a plain-SQL logical export with owner and privilege statements omitted;
2. a streamed R2 upload with a declared length and R2-validated SHA-256;
3. a colocated `*.manifest.json` containing artifact provenance and encryption
   metadata;
4. R2 metadata and manifest verification; and
5. a D1 ledger insert with the artifact key, manifest key, bytes, and digest.

A Workflow is successful only after all five operations complete.

## Recovery drill

Prerequisites:

- authenticated Wrangler access to the Cloudflare account;
- Docker running locally;
- the staging backup Workflow and R2 bucket deployed; and
- the staging access probe credentials configured.

Run:

```sh
npm run test:g11:recovery
```

The command creates a new staging export, downloads the SQL and manifest,
verifies both, restores into the pinned PostgreSQL image, validates application
objects, writes `docs/evidence/g11-recovery-drill.json`, and removes the
disposable target.

Pass criteria:

- Workflow status is `complete`;
- artifact size and SHA-256 match the manifest and Workflow output;
- `psql -v ON_ERROR_STOP=1` exits successfully;
- at least 50 non-system application tables exist after restore;
- RTO is less than 60 minutes; and
- no live database credential is provided to the restore target.

## Actual disaster recovery

For a real incident, first provision a new isolated PostgreSQL database. Do
not overwrite the affected database. Download and validate the selected R2
artifact exactly as the drill does, restore it with `ON_ERROR_STOP`, run
application and row-level validation, then update the application database
secret only through the approved change and rollback process. Preserve the
original database and the chosen R2 artifact until incident closure.
