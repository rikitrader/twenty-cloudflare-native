ALTER TABLE contacts ADD COLUMN owner_subject TEXT;
ALTER TABLE companies ADD COLUMN owner_subject TEXT;
ALTER TABLE opportunities ADD COLUMN owner_subject TEXT;
ALTER TABLE activities ADD COLUMN owner_subject TEXT;
CREATE INDEX IF NOT EXISTS idx_contacts_owner ON contacts(workspace_id, owner_subject);
CREATE INDEX IF NOT EXISTS idx_companies_owner ON companies(workspace_id, owner_subject);
CREATE INDEX IF NOT EXISTS idx_opportunities_owner ON opportunities(workspace_id, owner_subject);
CREATE INDEX IF NOT EXISTS idx_activities_owner ON activities(workspace_id, owner_subject);
