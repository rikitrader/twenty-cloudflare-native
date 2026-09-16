CREATE TABLE IF NOT EXISTS custom_objects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL,
  label TEXT NOT NULL,
  plural_label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, object_key)
);

CREATE TABLE IF NOT EXISTS custom_records (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id, object_key) REFERENCES custom_objects(workspace_id, object_key) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_custom_records_workspace_object ON custom_records(workspace_id, object_key, updated_at DESC);
