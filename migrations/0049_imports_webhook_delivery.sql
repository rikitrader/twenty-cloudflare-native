ALTER TABLE migration_runs ADD COLUMN object_key TEXT;
ALTER TABLE migration_runs ADD COLUMN object_type TEXT;
ALTER TABLE migration_runs ADD COLUMN workflow_id TEXT;
ALTER TABLE migration_runs ADD COLUMN bytes INTEGER;
ALTER TABLE migration_runs ADD COLUMN source_etag TEXT;

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL REFERENCES native_webhooks(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','delivering','delivered','failed','dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  response_status INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  delivered_at TEXT,
  UNIQUE (webhook_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_workspace ON webhook_deliveries(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status ON webhook_deliveries(status, updated_at);
