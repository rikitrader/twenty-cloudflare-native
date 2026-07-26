-- Durable operations ledger for application quarantines and platform DLQ events.
-- Twenty CRM records remain in PostgreSQL; this contains operational envelopes only.
CREATE TABLE IF NOT EXISTS job_failures (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('application', 'platform')),
  status TEXT NOT NULL CHECK (
    status IN ('quarantined', 'replay_pending', 'replayed', 'dismissed')
  ),
  reason TEXT NOT NULL,
  job_id TEXT,
  queue_name TEXT,
  job_name TEXT,
  job_json TEXT NOT NULL,
  failed_at TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  delivery_count INTEGER NOT NULL DEFAULT 1 CHECK (delivery_count > 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  replay_count INTEGER NOT NULL DEFAULT 0 CHECK (replay_count >= 0),
  replay_job_id TEXT,
  replay_requested_at TEXT,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_job_failures_status_created
  ON job_failures(status, first_seen_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_job_failures_job_id
  ON job_failures(job_id);

CREATE TABLE IF NOT EXISTS job_failure_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  failure_id TEXT NOT NULL,
  event_key TEXT NOT NULL UNIQUE,
  action TEXT NOT NULL CHECK (
    action IN (
      'ingested',
      'replay_requested',
      'replay_enqueued',
      'replay_failed',
      'dismissed'
    )
  ),
  actor TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  note TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (failure_id) REFERENCES job_failures(id)
);

CREATE INDEX IF NOT EXISTS idx_job_failure_audit_failure
  ON job_failure_audit(failure_id, created_at DESC, id DESC);
