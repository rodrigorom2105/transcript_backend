CREATE TABLE IF NOT EXISTS copilot_gpt_request_logs (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  suggestion_id BIGINT REFERENCES copilot_suggestions(id) ON DELETE SET NULL,
  provider TEXT NOT NULL CHECK (provider IN ('gpt_api', 'openclaw', 'playbook')),
  model TEXT,
  trigger_type TEXT NOT NULL,
  stage TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  user_prompt TEXT NOT NULL,
  transcript_excerpt TEXT NOT NULL,
  response_text TEXT,
  error TEXT,
  latency_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS copilot_gpt_request_logs_session_idx
  ON copilot_gpt_request_logs(session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS copilot_gpt_request_logs_suggestion_idx
  ON copilot_gpt_request_logs(suggestion_id);

CREATE INDEX IF NOT EXISTS copilot_gpt_request_logs_created_at_idx
  ON copilot_gpt_request_logs(created_at DESC);
