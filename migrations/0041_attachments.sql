CREATE TABLE IF NOT EXISTS crm_attachments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES crm_files(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('person', 'company', 'opportunity', 'activity', 'task', 'note')),
  target_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_crm_attachments_target
  ON crm_attachments(workspace_id, target_type, target_id, deleted_at, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_attachments_active_file_target
  ON crm_attachments(workspace_id, file_id)
  WHERE deleted_at IS NULL;
