CREATE TABLE IF NOT EXISTS custom_roles (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  description TEXT,
  icon TEXT,
  can_update_all_settings INTEGER NOT NULL DEFAULT 0 CHECK (can_update_all_settings IN (0,1)),
  can_access_all_tools INTEGER NOT NULL DEFAULT 0 CHECK (can_access_all_tools IN (0,1)),
  can_read_all_object_records INTEGER NOT NULL DEFAULT 0 CHECK (can_read_all_object_records IN (0,1)),
  can_update_all_object_records INTEGER NOT NULL DEFAULT 0 CHECK (can_update_all_object_records IN (0,1)),
  can_soft_delete_all_object_records INTEGER NOT NULL DEFAULT 0 CHECK (can_soft_delete_all_object_records IN (0,1)),
  can_destroy_all_object_records INTEGER NOT NULL DEFAULT 0 CHECK (can_destroy_all_object_records IN (0,1)),
  can_be_assigned_to_users INTEGER NOT NULL DEFAULT 1 CHECK (can_be_assigned_to_users IN (0,1)),
  can_be_assigned_to_agents INTEGER NOT NULL DEFAULT 0 CHECK (can_be_assigned_to_agents IN (0,1)),
  can_be_assigned_to_api_keys INTEGER NOT NULL DEFAULT 0 CHECK (can_be_assigned_to_api_keys IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, label)
);

CREATE TABLE IF NOT EXISTS role_assignments (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  identity_subject TEXT NOT NULL,
  role_id TEXT NOT NULL REFERENCES custom_roles(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id, identity_subject)
);

CREATE TABLE IF NOT EXISTS object_permissions (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES custom_roles(id) ON DELETE CASCADE,
  object_metadata_id TEXT NOT NULL,
  can_read_object_records INTEGER,
  can_update_object_records INTEGER,
  can_soft_delete_object_records INTEGER,
  can_destroy_object_records INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id, role_id, object_metadata_id)
);

CREATE TABLE IF NOT EXISTS field_permissions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES custom_roles(id) ON DELETE CASCADE,
  object_metadata_id TEXT NOT NULL,
  field_metadata_id TEXT NOT NULL,
  can_read_field_value INTEGER,
  can_update_field_value INTEGER,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, role_id, object_metadata_id, field_metadata_id)
);

CREATE TABLE IF NOT EXISTS row_permission_groups (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES custom_roles(id) ON DELETE CASCADE,
  object_metadata_id TEXT NOT NULL,
  parent_group_id TEXT,
  logical_operator TEXT NOT NULL CHECK (logical_operator IN ('AND','OR')),
  position INTEGER,
  FOREIGN KEY(parent_group_id) REFERENCES row_permission_groups(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS row_permission_predicates (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES custom_roles(id) ON DELETE CASCADE,
  object_metadata_id TEXT NOT NULL,
  field_metadata_id TEXT NOT NULL,
  operand TEXT NOT NULL,
  value_json TEXT,
  sub_field_name TEXT,
  workspace_member_field_metadata_id TEXT,
  workspace_member_sub_field_name TEXT,
  group_id TEXT,
  position INTEGER,
  FOREIGN KEY(group_id) REFERENCES row_permission_groups(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_role_assignments_role ON role_assignments(workspace_id, role_id);
CREATE INDEX IF NOT EXISTS idx_object_permissions_role ON object_permissions(workspace_id, role_id);
CREATE INDEX IF NOT EXISTS idx_field_permissions_role ON field_permissions(workspace_id, role_id);
CREATE INDEX IF NOT EXISTS idx_row_permission_predicates_role ON row_permission_predicates(workspace_id, role_id, object_metadata_id);

