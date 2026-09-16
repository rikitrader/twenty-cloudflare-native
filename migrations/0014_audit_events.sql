-- Immutable, tenant-scoped audit trail for native CRM mutations.
CREATE TABLE IF NOT EXISTS crm_audit_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  actor_subject TEXT NOT NULL,
  action TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT,
  request_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_crm_audit_workspace_created
  ON crm_audit_events(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_audit_request
  ON crm_audit_events(request_id);
