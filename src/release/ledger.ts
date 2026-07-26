import {
  RELEASE_STATES,
  type ReleaseParams,
  type ReleaseRunRecord,
  type ReleaseState,
} from "../release-contracts";

const LOCK_NAME = "production-database";
const LOCK_TTL_MS = 2 * 60 * 60_000;

function nowIso(): string {
  return new Date().toISOString();
}

export async function ensureRelease(
  db: D1Database,
  params: ReleaseParams,
): Promise<ReleaseRunRecord> {
  const now = nowIso();
  await db
    .prepare(
      `INSERT OR IGNORE INTO release_runs
        (release_id, git_sha, app_image_digest, app_version, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'preflight', ?, ?)`,
    )
    .bind(
      params.releaseId,
      params.gitSha,
      params.appImageDigest,
      params.appVersion,
      now,
      now,
    )
    .run();
  const record = await getRelease(db, params.releaseId);
  if (!record) throw new Error("release ledger insert failed");
  if (
    record.git_sha !== params.gitSha ||
    record.app_image_digest !== params.appImageDigest ||
    record.app_version !== params.appVersion
  )
    throw new Error("release ID is already bound to different artifacts");
  return record;
}

export async function getRelease(
  db: D1Database,
  releaseId: string,
): Promise<ReleaseRunRecord | null> {
  return db
    .prepare("SELECT * FROM release_runs WHERE release_id = ?")
    .bind(releaseId)
    .first<ReleaseRunRecord>();
}

export async function deployedImageExists(
  db: D1Database,
  digest: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT release_id FROM release_runs
       WHERE app_image_digest = ? AND state = 'deployed'
       LIMIT 1`,
    )
    .bind(digest)
    .first<{ release_id: string }>();
  return Boolean(row);
}

export async function transitionRelease(
  db: D1Database,
  releaseId: string,
  toState: ReleaseState,
  updates: {
    branchId?: string | null;
    backupWorkflowId?: string | null;
    backupR2Key?: string | null;
    cloudflareVersionId?: string | null;
    errorMessage?: string | null;
    detail?: unknown;
  } = {},
): Promise<void> {
  if (!RELEASE_STATES.includes(toState))
    throw new Error(`invalid release state: ${toState}`);
  const current = await getRelease(db, releaseId);
  if (!current) throw new Error(`unknown release: ${releaseId}`);
  const now = nowIso();
  await db.batch([
    db
      .prepare(
        `UPDATE release_runs SET
          state = ?,
          branch_id = COALESCE(?, branch_id),
          backup_workflow_id = COALESCE(?, backup_workflow_id),
          backup_r2_key = COALESCE(?, backup_r2_key),
          cloudflare_version_id = COALESCE(?, cloudflare_version_id),
          error_message = ?,
          updated_at = ?,
          completed_at = CASE WHEN ? = 'deployed' THEN ? ELSE completed_at END
         WHERE release_id = ?`,
      )
      .bind(
        toState,
        updates.branchId ?? null,
        updates.backupWorkflowId ?? null,
        updates.backupR2Key ?? null,
        updates.cloudflareVersionId ?? null,
        updates.errorMessage ?? null,
        now,
        toState,
        now,
        releaseId,
      ),
    db
      .prepare(
        `INSERT INTO release_events
          (release_id, from_state, to_state, detail_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        releaseId,
        current.state,
        toState,
        updates.detail === undefined
          ? null
          : JSON.stringify(updates.detail),
        now,
      ),
  ]);
}

export async function acquireReleaseLock(
  db: D1Database,
  releaseId: string,
): Promise<void> {
  const now = nowIso();
  const expires = new Date(Date.now() + LOCK_TTL_MS).toISOString();
  await db.batch([
    db
      .prepare(
        "DELETE FROM release_lock WHERE lock_name = ? AND expires_at < ?",
      )
      .bind(LOCK_NAME, now),
    db
      .prepare(
        `INSERT OR IGNORE INTO release_lock
          (lock_name, release_id, acquired_at, expires_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(LOCK_NAME, releaseId, now, expires),
  ]);
  const lock = await db
    .prepare(
      "SELECT release_id FROM release_lock WHERE lock_name = ?",
    )
    .bind(LOCK_NAME)
    .first<{ release_id: string }>();
  if (lock?.release_id !== releaseId)
    throw new Error(`production database release is locked by ${lock?.release_id}`);
}

export async function releaseReleaseLock(
  db: D1Database,
  releaseId: string,
): Promise<void> {
  await db
    .prepare(
      "DELETE FROM release_lock WHERE lock_name = ? AND release_id = ?",
    )
    .bind(LOCK_NAME, releaseId)
    .run();
}
