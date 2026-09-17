CREATE TABLE IF NOT EXISTS native_workflow_versions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES native_workflows(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('DRAFT','ACTIVE','DEACTIVATED','ARCHIVED')),
  trigger_json TEXT,
  steps_json TEXT NOT NULL DEFAULT '[]',
  edges_json TEXT NOT NULL DEFAULT '[]',
  snapshot_hash TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  UNIQUE(workflow_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_one_draft ON native_workflow_versions(workflow_id) WHERE status='DRAFT';
CREATE INDEX IF NOT EXISTS idx_workflow_versions_workspace ON native_workflow_versions(workspace_id, workflow_id, version DESC);

