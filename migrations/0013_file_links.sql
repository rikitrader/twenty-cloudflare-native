CREATE TABLE IF NOT EXISTS crm_file_links (
  file_id TEXT NOT NULL REFERENCES crm_files(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  record_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (file_id, record_type, record_id)
);
CREATE INDEX IF NOT EXISTS idx_crm_file_links_record ON crm_file_links(workspace_id, record_type, record_id);
