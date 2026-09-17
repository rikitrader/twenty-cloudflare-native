CREATE TABLE IF NOT EXISTS crm_tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  position REAL NOT NULL DEFAULT 0,
  title TEXT,
  body_v2_json TEXT,
  due_at TEXT,
  status TEXT NOT NULL DEFAULT 'TODO' CHECK (status IN ('TODO', 'DONE')),
  assignee_subject TEXT,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS crm_notes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  position REAL NOT NULL DEFAULT 0,
  title TEXT NOT NULL DEFAULT '',
  body_v2_json TEXT,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS crm_task_targets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES crm_tasks(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (workspace_id, task_id, target_type, target_id)
);

CREATE TABLE IF NOT EXISTS crm_note_targets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  note_id TEXT NOT NULL REFERENCES crm_notes(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (workspace_id, note_id, target_type, target_id)
);

CREATE INDEX IF NOT EXISTS idx_crm_tasks_workspace_status
  ON crm_tasks(workspace_id, status, deleted_at, due_at, position);
CREATE INDEX IF NOT EXISTS idx_crm_notes_workspace
  ON crm_notes(workspace_id, deleted_at, position, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_task_targets_target
  ON crm_task_targets(workspace_id, target_type, target_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_crm_note_targets_target
  ON crm_note_targets(workspace_id, target_type, target_id, deleted_at);
