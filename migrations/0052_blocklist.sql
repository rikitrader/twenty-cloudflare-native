CREATE TABLE IF NOT EXISTS blocklist (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  handle TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'WORKSPACE' CHECK (scope IN ('WORKSPACE')),
  owner_subject TEXT NOT NULL,
  custom_fields_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  UNIQUE (workspace_id, handle)
);

CREATE INDEX IF NOT EXISTS idx_blocklist_workspace_active
  ON blocklist(workspace_id, deleted_at, created_at DESC);
