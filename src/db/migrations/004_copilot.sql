CREATE TABLE IF NOT EXISTS copilot_suggestions (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  trigger_type TEXT NOT NULL,
  stage TEXT NOT NULL,
  matched_keywords TEXT[] NOT NULL DEFAULT '{}',
  transcript_excerpt TEXT NOT NULL,
  suggestion TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('gpt_api', 'openclaw', 'playbook')),
  accepted BOOLEAN,
  shown_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS copilot_suggestions_session_idx
  ON copilot_suggestions(session_id, shown_at DESC);

CREATE TABLE IF NOT EXISTS objection_playbook (
  id BIGSERIAL PRIMARY KEY,
  category TEXT NOT NULL,
  objection_pattern TEXT NOT NULL,
  recommended_response TEXT NOT NULL,
  tags TEXT[] NOT NULL DEFAULT '{}',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS objection_playbook_active_idx
  ON objection_playbook(active);

CREATE INDEX IF NOT EXISTS objection_playbook_category_idx
  ON objection_playbook(category);

INSERT INTO objection_playbook (category, objection_pattern, recommended_response, tags)
VALUES
  (
    'precio',
    'no tengo dinero | está caro | muy caro | no tengo presupuesto',
    'Entiendo completamente. Justo por eso lo importante es ajustar el plan a algo cómodo para usted; no se trata de forzar una cantidad, sino de empezar con una protección que sí pueda sostener.',
    ARRAY['precio', 'presupuesto']
  ),
  (
    'pensarlo',
    'lo voy a pensar | déjeme pensarlo',
    'Claro, es una decisión importante. Para que pueda pensarlo bien, ¿qué parte le gustaría que dejemos más clara ahora: el costo, los beneficios o cómo funciona el valor en efectivo?',
    ARRAY['seguimiento']
  ),
  (
    'informacion',
    'mándeme información | le mando información',
    'Con gusto se la puedo enviar. Antes de hacerlo, para mandarle algo que realmente le sirva, ¿su prioridad es protección familiar, ahorro a largo plazo o retiro?',
    ARRAY['informacion']
  )
ON CONFLICT DO NOTHING;
