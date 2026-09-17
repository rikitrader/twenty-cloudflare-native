-- Expand metadata storage beyond the four standard CRM objects. The rebuild is
-- additive for existing rows and removes only the obsolete object-type CHECK.
CREATE TABLE custom_fields_v2 (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  object_type TEXT NOT NULL,
  field_key TEXT NOT NULL,
  label TEXT NOT NULL,
  field_type TEXT NOT NULL CHECK (field_type IN (
    'text', 'number', 'boolean', 'date', 'date_time', 'select',
    'multi_select', 'currency', 'address', 'rich_text', 'actor', 'array',
    'relation', 'uuid'
  )),
  options_json TEXT,
  settings_json TEXT,
  is_nullable INTEGER NOT NULL DEFAULT 1 CHECK (is_nullable IN (0, 1)),
  is_unique INTEGER NOT NULL DEFAULT 0 CHECK (is_unique IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, object_type, field_key)
);
INSERT INTO custom_fields_v2 (id,workspace_id,object_type,field_key,label,field_type,options_json,created_at)
  SELECT id,workspace_id,object_type,field_key,label,field_type,options_json,created_at FROM custom_fields;
DROP TABLE custom_fields;
ALTER TABLE custom_fields_v2 RENAME TO custom_fields;
CREATE INDEX IF NOT EXISTS idx_custom_fields_workspace_object
  ON custom_fields(workspace_id, object_type, created_at, id);
ALTER TABLE custom_records ADD COLUMN deleted_at TEXT;
CREATE INDEX IF NOT EXISTS idx_custom_records_active
  ON custom_records(workspace_id, object_key, deleted_at, updated_at DESC);
