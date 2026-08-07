CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Deal lifecycle
CREATE TYPE deal_status AS ENUM (
  'intake',
  'sizing',
  'customs',
  'quoting',
  'pricing',
  'negotiation',
  'contract',
  'execution',
  'awaiting_manager',
  'closed_won',
  'closed_lost',
  'cancelled'
);

CREATE TABLE IF NOT EXISTS policy_config (
  id SERIAL PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO policy_config (key, value) VALUES
  ('target_margin_pct', '18'),
  ('floor_margin_pct', '10'),
  ('max_discount_pct', '8'),
  ('escalate_amount_rub', '500000'),
  ('first_reply_sla_sec', '120'),
  ('quote_sla_hours', '2'),
  ('learning_enabled', 'true'),
  ('canary_pct', '10')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS deals (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  channel TEXT NOT NULL DEFAULT 'telegram',
  tg_chat_id BIGINT,
  tg_user_id BIGINT,
  client_phone TEXT,
  client_name TEXT,
  status deal_status NOT NULL DEFAULT 'intake',
  previous_status deal_status,
  cargo JSONB NOT NULL DEFAULT '{}',
  route JSONB NOT NULL DEFAULT '{}',
  dims_source TEXT,
  hs_codes JSONB NOT NULL DEFAULT '[]',
  cost_breakdown JSONB NOT NULL DEFAULT '{}',
  offer JSONB NOT NULL DEFAULT '{}',
  margin_pct NUMERIC(8,2),
  currency TEXT NOT NULL DEFAULT 'RUB',
  amount_rub NUMERIC(14,2),
  risks JSONB NOT NULL DEFAULT '[]',
  next_actions JSONB NOT NULL DEFAULT '[]',
  takeover BOOLEAN NOT NULL DEFAULT FALSE,
  paused BOOLEAN NOT NULL DEFAULT FALSE,
  escalate BOOLEAN NOT NULL DEFAULT FALSE,
  playbook_version TEXT,
  confidence NUMERIC(4,3),
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_deals_tg_chat ON deals(tg_chat_id);
CREATE INDEX IF NOT EXISTS idx_deals_channel_phone ON deals(channel, client_phone)
  WHERE client_phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_deals_status ON deals(status);
CREATE INDEX IF NOT EXISTS idx_deals_updated ON deals(updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  deal_id UUID REFERENCES deals(id) ON DELETE CASCADE,
  channel TEXT NOT NULL DEFAULT 'telegram',
  tg_chat_id BIGINT,
  tg_message_id BIGINT,
  call_session_id UUID,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound', 'system')),
  sender TEXT NOT NULL,
  text TEXT NOT NULL,
  raw JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_deal ON messages(deal_id, created_at);

CREATE TABLE IF NOT EXISTS call_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  deal_id UUID REFERENCES deals(id) ON DELETE SET NULL,
  provider_call_id TEXT,
  phone TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'inbound' CHECK (direction IN ('inbound', 'outbound')),
  status TEXT NOT NULL DEFAULT 'ringing' CHECK (
    status IN ('ringing', 'active', 'completed', 'transferred', 'failed')
  ),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  recording_url TEXT,
  transcript JSONB NOT NULL DEFAULT '[]',
  metadata JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_call_sessions_deal ON call_sessions(deal_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_sessions_phone ON call_sessions(phone, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_sessions_status ON call_sessions(status)
  WHERE status IN ('ringing', 'active');

ALTER TABLE messages
  ADD CONSTRAINT messages_call_session_id_fkey
  FOREIGN KEY (call_session_id) REFERENCES call_sessions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_messages_call_session ON messages(call_session_id, created_at);

CREATE TABLE IF NOT EXISTS cargo_estimates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  length_cm NUMERIC(10,2),
  width_cm NUMERIC(10,2),
  height_cm NUMERIC(10,2),
  weight_kg NUMERIC(12,3),
  volumetric_weight_kg NUMERIC(12,3),
  chargeable_weight_kg NUMERIC(12,3),
  source TEXT NOT NULL,
  confidence NUMERIC(4,3) NOT NULL DEFAULT 0.5,
  error_band_pct NUMERIC(6,2) NOT NULL DEFAULT 15,
  calibration_applied JSONB NOT NULL DEFAULT '{}',
  details JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS partners (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  code TEXT UNIQUE,
  api_base_url TEXT,
  score NUMERIC(6,3) NOT NULL DEFAULT 0.5,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS partner_contacts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  partner_id UUID REFERENCES partners(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  domain TEXT,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  first_email_approved BOOLEAN NOT NULL DEFAULT FALSE,
  source_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(email)
);

CREATE TABLE IF NOT EXISTS quotes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  partner_id UUID REFERENCES partners(id),
  source TEXT NOT NULL,
  route_summary TEXT,
  price NUMERIC(14,2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'RUB',
  eta_days_min INT,
  eta_days_max INT,
  hidden_fees JSONB NOT NULL DEFAULT '[]',
  reliability_score NUMERIC(4,3),
  valid_until TIMESTAMPTZ,
  raw JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quotes_deal ON quotes(deal_id);

CREATE TABLE IF NOT EXISTS contracts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  draft_md TEXT NOT NULL,
  client_summary TEXT,
  risk_matrix JSONB NOT NULL DEFAULT '[]',
  legal_json JSONB NOT NULL DEFAULT '{}',
  must_approve BOOLEAN NOT NULL DEFAULT FALSE,
  approved BOOLEAN,
  approved_by TEXT,
  sent_to_client BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS escalations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  summary TEXT NOT NULL,
  numbers JSONB NOT NULL DEFAULT '{}',
  risks JSONB NOT NULL DEFAULT '[]',
  recommendation TEXT,
  needed_decision TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'resolved')),
  manager_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS calendar_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  deal_id UUID REFERENCES deals(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  due_at TIMESTAMPTZ NOT NULL,
  done BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS learning_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  deal_id UUID REFERENCES deals(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS playbook_versions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  body JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_approve', 'canary', 'active', 'rejected', 'retired')),
  canary_pct INT NOT NULL DEFAULT 10,
  metrics JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(name, version)
);

CREATE TABLE IF NOT EXISTS calibration_coeffs (
  category TEXT PRIMARY KEY,
  volume_factor NUMERIC(8,4) NOT NULL DEFAULT 1.0,
  weight_factor NUMERIC(8,4) NOT NULL DEFAULT 1.0,
  sample_count INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS embeddings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  deal_id UUID REFERENCES deals(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding vector(1536),
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_embeddings_deal ON embeddings(deal_id);

CREATE TABLE IF NOT EXISTS hs_duty_rates (
  hs_code TEXT PRIMARY KEY,
  duty_pct NUMERIC(8,4) NOT NULL,
  vat_pct NUMERIC(8,4) NOT NULL DEFAULT 20,
  excise_note TEXT,
  source TEXT NOT NULL DEFAULT 'seed',
  effective_from DATE,
  raw JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hs_duty_updated ON hs_duty_rates(updated_at DESC);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS dead_letter_jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  queue TEXT NOT NULL,
  job_id TEXT,
  payload JSONB NOT NULL,
  error TEXT,
  attempts INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed demo partners
INSERT INTO partners (name, code, api_base_url, score) VALUES
  ('Demo Express CN', 'demo_express', 'mock://demo-express', 0.7),
  ('Silk Road Logistics', 'silk_road', 'mock://silk-road', 0.65),
  ('EastGate Freight', 'eastgate', NULL, 0.55)
ON CONFLICT (code) DO NOTHING;

-- Optional: approve contacts via PARTNER_QUOTE_EMAILS or Management Bot before first send.
-- Example seed (disabled by default — set emails in .env PARTNER_QUOTE_EMAILS instead):
-- INSERT INTO partner_contacts (partner_id, email, domain, verified, first_email_approved)
-- SELECT id, 'rates@example.com', 'example.com', TRUE, TRUE FROM partners WHERE code = 'demo_express'
-- ON CONFLICT (email) DO NOTHING;
INSERT INTO playbook_versions (name, version, body, status, canary_pct)
VALUES (
  'default',
  'v1',
  '{"tone":"commercial","discount_steps":[0,3,5],"ask_max_questions":3}'::jsonb,
  'active',
  10
)
ON CONFLICT (name, version) DO NOTHING;

