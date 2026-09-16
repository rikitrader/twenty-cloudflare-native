ALTER TABLE contacts ADD COLUMN custom_fields_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE companies ADD COLUMN custom_fields_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE opportunities ADD COLUMN custom_fields_json TEXT NOT NULL DEFAULT '{}';
