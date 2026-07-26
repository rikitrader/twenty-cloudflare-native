-- Cloudflare-controlled release ledger. Twenty CRM data remains in PostgreSQL.
CREATE TABLE IF NOT EXISTS release_runs (
  release_id TEXT PRIMARY KEY,
  git_sha TEXT NOT NULL,
  app_image_digest TEXT NOT NULL,
  app_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN (
      'preflight',
      'maintenance',
      'backup_verified',
      'migrating',
      'ready_to_deploy',
      'verifying_deployment',
      'deployed',
      'failed',
      'needs_review'
    )
  ),
  branch_id TEXT,
  backup_workflow_id TEXT,
  backup_r2_key TEXT,
  cloudflare_version_id TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_release_runs_deployed_digest
  ON release_runs(app_image_digest)
  WHERE state = 'deployed';

CREATE INDEX IF NOT EXISTS idx_release_runs_state_updated
  ON release_runs(state, updated_at DESC);

CREATE TABLE IF NOT EXISTS release_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  release_id TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  detail_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (release_id) REFERENCES release_runs(release_id)
);

CREATE INDEX IF NOT EXISTS idx_release_events_release
  ON release_events(release_id, created_at, id);

CREATE TABLE IF NOT EXISTS release_lock (
  lock_name TEXT PRIMARY KEY CHECK (lock_name = 'production-database'),
  release_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
