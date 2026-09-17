CREATE TABLE IF NOT EXISTS crm_notifications (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  recipient_subject TEXT NOT NULL,
  notification_type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  data_json TEXT NOT NULL DEFAULT '{}',
  dedupe_key TEXT,
  read_at TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id,recipient_subject,dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_notifications_inbox ON crm_notifications(workspace_id,recipient_subject,archived_at,read_at,created_at DESC);

CREATE TABLE IF NOT EXISTS crm_notification_deliveries (
  id TEXT PRIMARY KEY,
  notification_id TEXT NOT NULL REFERENCES crm_notifications(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('in_app','email','operational')),
  status TEXT NOT NULL CHECK (status IN ('pending','delivered','failed','disabled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  delivered_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(notification_id,channel)
);

