ALTER TABLE native_api_keys ADD COLUMN role TEXT NOT NULL DEFAULT 'member'
  CHECK (role IN ('admin', 'member'));

CREATE INDEX IF NOT EXISTS idx_native_api_keys_active_token
  ON native_api_keys(token_hash)
  WHERE revoked_at IS NULL;
