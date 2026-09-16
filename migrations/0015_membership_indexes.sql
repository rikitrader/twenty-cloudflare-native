CREATE INDEX IF NOT EXISTS idx_workspace_members_identity
  ON workspace_members(identity_subject, status);
CREATE INDEX IF NOT EXISTS idx_workspace_members_workspace_status
  ON workspace_members(workspace_id, status, role);
