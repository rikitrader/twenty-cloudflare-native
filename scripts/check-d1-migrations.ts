import { Database } from "bun:sqlite";
import { readdir, readFile } from "node:fs/promises";

const migrationDirectory = new URL("../migrations/", import.meta.url);
const migrations = (await readdir(migrationDirectory))
  .filter((name) => /^\d+_.+\.sql$/.test(name))
  .sort();

if (migrations.length === 0) throw new Error("no D1 migrations found");

const database = new Database(":memory:", { strict: true });
try {
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of migrations) {
    const sql = await readFile(new URL(migration, migrationDirectory), "utf8");
    database.transaction(() => database.exec(sql))();
  }

  const tables = database
    .query<{ name: string }, []>(
      `SELECT name FROM sqlite_schema
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all()
    .map(({ name }) => name);
  for (const required of [
    "events",
    "backups",
    "job_failures",
    "job_failure_audit",
    "release_runs",
    "release_events",
    "release_lock",
    "crm_audit_events",
  ]) {
    if (!tables.includes(required))
      throw new Error(`missing required table after migrations: ${required}`);
  }

  database
    .query(
      `INSERT INTO job_failures (
         id, source, status, reason, job_json, failed_at,
         first_seen_at, last_seen_at
       ) VALUES (?, 'application', 'quarantined', ?, '{}', ?, ?, ?)`,
    )
    .run(
      "migration-probe",
      "retry-limit-exceeded",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );
  database
    .query(
      `INSERT INTO job_failure_audit (
         failure_id, event_key, action, actor, to_status, created_at
       ) VALUES (?, ?, 'ingested', 'migration-check', 'quarantined', ?)`,
    )
    .run(
      "migration-probe",
      "ingested:migration-probe",
      "2026-01-01T00:00:00.000Z",
    );

  console.log(
    JSON.stringify({
      migrations,
      tables,
      result: "passed",
    }),
  );
} finally {
  database.close();
}
