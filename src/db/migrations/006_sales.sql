CREATE TABLE IF NOT EXISTS sales_companies (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sales_products (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES sales_companies(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, code)
);

CREATE TABLE IF NOT EXISTS sales_followup_codes (
  code TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS sales (
  id BIGSERIAL PRIMARY KEY,
  discord_interaction_id TEXT,
  discord_message_id TEXT UNIQUE,
  discord_guild_id TEXT,
  discord_channel_id TEXT,
  agent_discord_user_id TEXT NOT NULL,
  agent_display_name TEXT NOT NULL,
  company_id BIGINT NOT NULL REFERENCES sales_companies(id),
  product_id BIGINT NOT NULL REFERENCES sales_products(id),
  client_name TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  billing_period TEXT NOT NULL DEFAULT 'month' CHECK (billing_period IN ('once', 'month', 'year')),
  signature_status TEXT NOT NULL CHECK (signature_status IN ('IMM', 'UW', 'DATE')),
  signature_date DATE,
  followup_code TEXT REFERENCES sales_followup_codes(code),
  raw_text TEXT,
  notes TEXT,
  sold_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sales_signature_date_check CHECK (
    (signature_status = 'DATE' AND signature_date IS NOT NULL)
    OR
    (signature_status <> 'DATE' AND signature_date IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS sales_sold_at_idx ON sales(sold_at DESC);
CREATE INDEX IF NOT EXISTS sales_agent_sold_at_idx ON sales(agent_discord_user_id, sold_at DESC);
CREATE INDEX IF NOT EXISTS sales_company_product_idx ON sales(company_id, product_id);
CREATE INDEX IF NOT EXISTS sales_discord_message_id_idx ON sales(discord_message_id) WHERE discord_message_id IS NOT NULL;

INSERT INTO sales_followup_codes (code, label) VALUES
  ('IMM', 'Firmado en el momento'),
  ('UW', 'Underwriting')
ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label, active = TRUE;

INSERT INTO sales_companies (code, name) VALUES
  ('AME', 'AME'),
  ('NLG', 'NLG'),
  ('ETHOS', 'ETHOS')
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, active = TRUE;

INSERT INTO sales_products (company_id, code, name)
SELECT c.id, v.code, v.name
FROM sales_companies c
JOIN (VALUES
  ('IUL', 'IUL'),
  ('EAG', 'EAG'),
  ('WL', 'WL')
) AS v(code, name) ON TRUE
WHERE c.code IN ('AME', 'NLG', 'ETHOS')
ON CONFLICT (company_id, code) DO UPDATE SET name = EXCLUDED.name, active = TRUE;
