CREATE TABLE IF NOT EXISTS webhook_receiver_events (
  event_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webhook_receiver_workspace
  ON webhook_receiver_events(workspace_id, received_at DESC);

CREATE TABLE IF NOT EXISTS migration_reconciliations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_manifest_sha256 TEXT NOT NULL,
  source_counts_json TEXT NOT NULL,
  target_counts_json TEXT NOT NULL,
  relationship_errors INTEGER NOT NULL DEFAULT 0,
  missing_r2_objects INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('passed','failed')),
  report_object_key TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, source_manifest_sha256)
);
