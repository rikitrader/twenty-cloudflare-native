CREATE TABLE IF NOT EXISTS installed_apps (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'installed' CHECK (status IN ('installed', 'stopped', 'uninstalled')),
  config_json TEXT NOT NULL DEFAULT '{}',
  installed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_installed_apps_workspace ON installed_apps(workspace_id, updated_at DESC);
