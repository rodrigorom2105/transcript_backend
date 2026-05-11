CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  discord_user_id TEXT PRIMARY KEY,
  username        TEXT NOT NULL,
  avatar          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discord_user_id TEXT NOT NULL REFERENCES users(discord_user_id),
  agent_name      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS sessions_discord_user_id_idx ON sessions(discord_user_id);
CREATE INDEX IF NOT EXISTS sessions_status_idx ON sessions(status);

CREATE TABLE IF NOT EXISTS transcript_turns (
  id          BIGSERIAL PRIMARY KEY,
  session_id  UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  speaker     TEXT NOT NULL CHECK (speaker IN ('agente', 'cliente')),
  channel     SMALLINT NOT NULL CHECK (channel IN (0, 1)),
  text        TEXT NOT NULL,
  ts          BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS transcript_turns_session_id_idx ON transcript_turns(session_id);

CREATE TABLE IF NOT EXISTS questions (
  id           BIGSERIAL PRIMARY KEY,
  session_id   UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  question     TEXT NOT NULL,
  answer       TEXT NOT NULL,
  asked_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
