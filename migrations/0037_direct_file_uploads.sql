CREATE TABLE IF NOT EXISTS pending_file_uploads (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  expected_bytes INTEGER NOT NULL CHECK (expected_bytes >= 0 AND expected_bytes <= 26214400),
  file_folder TEXT NOT NULL,
  field_metadata_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'uploading', 'uploaded', 'expired', 'failed')),
  object_key TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  uploaded_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_pending_file_uploads_workspace_status
  ON pending_file_uploads(workspace_id, status, expires_at);
