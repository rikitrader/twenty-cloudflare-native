CREATE TABLE IF NOT EXISTS role_permission_flags (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES custom_roles(id) ON DELETE CASCADE,
  flag TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(workspace_id, role_id, flag)
);

CREATE TABLE IF NOT EXISTS agent_role_assignments (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES native_automation_resources(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES custom_roles(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_role_permission_flags_role ON role_permission_flags(workspace_id, role_id);
CREATE INDEX IF NOT EXISTS idx_agent_role_assignments_role ON agent_role_assignments(workspace_id, role_id);
