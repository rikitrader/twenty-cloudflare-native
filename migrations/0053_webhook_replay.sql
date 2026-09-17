ALTER TABLE webhook_deliveries ADD COLUMN payload_json TEXT;
ALTER TABLE webhook_deliveries ADD COLUMN replay_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE webhook_deliveries ADD COLUMN last_replayed_at TEXT;
ALTER TABLE webhook_deliveries ADD COLUMN replayed_by TEXT;

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_workspace_status_created
  ON webhook_deliveries(workspace_id, status, created_at DESC);
