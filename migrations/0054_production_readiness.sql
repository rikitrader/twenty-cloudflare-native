CREATE TABLE IF NOT EXISTS operational_continuity_samples (
  id TEXT PRIMARY KEY,
  sampled_at TEXT NOT NULL UNIQUE,
  worker_version TEXT,
  crm_d1_ok INTEGER NOT NULL CHECK (crm_d1_ok IN (0,1)),
  ops_d1_ok INTEGER NOT NULL CHECK (ops_d1_ok IN (0,1)),
  new_quarantined_jobs INTEGER NOT NULL DEFAULT 0,
  stale_outbox_events INTEGER NOT NULL DEFAULT 0,
  providers_json TEXT NOT NULL,
  passed INTEGER NOT NULL CHECK (passed IN (0,1)),
  detail_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_continuity_samples_time
  ON operational_continuity_samples(sampled_at DESC);

CREATE TABLE IF NOT EXISTS provider_oauth_states (
  state_hash TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_subject TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('google','microsoft')),
  encrypted_verifier TEXT NOT NULL,
  verifier_iv TEXT NOT NULL,
  return_path TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_provider_oauth_states_expiry
  ON provider_oauth_states(expires_at);

CREATE TABLE IF NOT EXISTS integration_credentials (
  account_id TEXT PRIMARY KEY REFERENCES integration_accounts(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google','microsoft')),
  encrypted_tokens TEXT NOT NULL,
  token_iv TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  token_expires_at TEXT,
  refresh_claimed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_integration_credentials_workspace
  ON integration_credentials(workspace_id, provider);

CREATE TABLE IF NOT EXISTS integration_sync_state (
  account_id TEXT PRIMARY KEY REFERENCES integration_accounts(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  calendar_cursor TEXT,
  messaging_cursor TEXT,
  last_started_at TEXT,
  last_completed_at TEXT,
  last_error_code TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS integration_message_folders (
  account_id TEXT NOT NULL REFERENCES integration_accounts(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider_folder_id TEXT NOT NULL,
  name TEXT NOT NULL,
  folder_type TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(account_id, provider_folder_id)
);

CREATE INDEX IF NOT EXISTS idx_integration_folders_workspace
  ON integration_message_folders(workspace_id, account_id);
