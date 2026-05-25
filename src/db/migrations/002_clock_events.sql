CREATE TABLE IF NOT EXISTS clock_events (
  id              BIGSERIAL PRIMARY KEY,
  discord_user_id TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  action          TEXT NOT NULL CHECK (action IN ('CLOCKIN', 'CLOCKOUT')),
  event_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sheets_synced   BOOLEAN NOT NULL DEFAULT FALSE,
  sheets_error    TEXT
);

CREATE INDEX IF NOT EXISTS clock_events_user_time_idx
  ON clock_events(discord_user_id, event_at DESC);

CREATE INDEX IF NOT EXISTS clock_events_sheets_pending_idx
  ON clock_events(id) WHERE sheets_synced = FALSE;
