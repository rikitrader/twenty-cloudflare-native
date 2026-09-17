ALTER TABLE events ADD COLUMN event_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_event_id ON events(event_id) WHERE event_id IS NOT NULL;

