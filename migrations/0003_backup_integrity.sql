-- Cryptographic backup provenance for production recovery drills.
ALTER TABLE backups ADD COLUMN manifest_key TEXT;
ALTER TABLE backups ADD COLUMN sha256 TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_backups_r2_key ON backups(r2_key);
