CREATE TABLE IF NOT EXISTS email_deliveries (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_subject TEXT NOT NULL,
  recipient_json TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','sending','sent','failed','dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  provider_message_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_email_deliveries_workspace ON email_deliveries(workspace_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_deliveries_status ON email_deliveries(status,updated_at);
