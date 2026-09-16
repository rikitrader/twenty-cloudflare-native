CREATE TABLE IF NOT EXISTS approved_access_domains (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, domain)
);
CREATE TABLE IF NOT EXISTS sso_identity_providers (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider_type TEXT NOT NULL CHECK (provider_type IN ('saml', 'oidc')),
  name TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_access_domains_workspace ON approved_access_domains(workspace_id);
CREATE INDEX IF NOT EXISTS idx_sso_providers_workspace ON sso_identity_providers(workspace_id, updated_at DESC);
