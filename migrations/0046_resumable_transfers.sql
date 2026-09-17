ALTER TABLE migration_runs RENAME TO migration_runs_legacy;
CREATE TABLE migration_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed','cancelled')),
  cursor TEXT,
  processed INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  total INTEGER,
  mapping_json TEXT NOT NULL DEFAULT '{}',
  error_object_key TEXT,
  error TEXT,
  cancelled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO migration_runs (id,workspace_id,status,cursor,processed,failed,error,created_at,updated_at)
SELECT id,workspace_id,status,cursor,processed,failed,error,created_at,updated_at FROM migration_runs_legacy;
DROP TABLE migration_runs_legacy;
CREATE INDEX idx_migration_runs_workspace ON migration_runs(workspace_id,updated_at DESC);

ALTER TABLE crm_exports RENAME TO crm_exports_legacy;
CREATE TABLE crm_exports (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL UNIQUE,
  object_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','complete','failed','cancelled')),
  object_key TEXT,
  bytes INTEGER,
  error TEXT,
  cancelled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO crm_exports (id,workspace_id,workflow_id,object_type,status,object_key,bytes,error,created_at,updated_at)
SELECT id,workspace_id,workflow_id,object_type,status,object_key,bytes,error,created_at,updated_at FROM crm_exports_legacy;
DROP TABLE crm_exports_legacy;
CREATE INDEX idx_crm_exports_workspace_created ON crm_exports(workspace_id,created_at DESC);

