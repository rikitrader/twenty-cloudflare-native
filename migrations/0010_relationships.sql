CREATE TABLE IF NOT EXISTS record_relationships (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  relation_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, source_type, source_id, target_type, target_id, relation_key)
);
CREATE INDEX IF NOT EXISTS idx_relationship_source ON record_relationships(workspace_id, source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_relationship_target ON record_relationships(workspace_id, target_type, target_id);
