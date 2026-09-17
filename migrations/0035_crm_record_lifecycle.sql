-- Preserve Twenty's trash/restore behavior instead of deleting records on Delete.
ALTER TABLE contacts ADD COLUMN deleted_at TEXT;
ALTER TABLE companies ADD COLUMN deleted_at TEXT;
ALTER TABLE opportunities ADD COLUMN deleted_at TEXT;
ALTER TABLE activities ADD COLUMN deleted_at TEXT;
ALTER TABLE activities ADD COLUMN custom_fields_json TEXT NOT NULL DEFAULT '{}';
CREATE INDEX idx_contacts_lifecycle ON contacts(workspace_id, deleted_at, updated_at);
CREATE INDEX idx_companies_lifecycle ON companies(workspace_id, deleted_at, updated_at);
CREATE INDEX idx_opportunities_lifecycle ON opportunities(workspace_id, deleted_at, updated_at);
CREATE INDEX idx_activities_lifecycle ON activities(workspace_id, deleted_at, updated_at);
