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
  ('canary_pct', '10'),
  ('min_gross_profit_rub', '3000'),
  ('ru_vat_pct', '22'),
  ('client_ru_sells_with_vat', 'true'),
  ('intl_freight_vat_pct', '0'),
  ('broker_cost_rub', '15000'),
  ('broker_client_price_rub', '20000'),
  ('certification_markup_pct', '5'),
  ('buyout_commission_pct', '5'),
  ('buyout_fx_markup_rub', '0.45'),
  ('prepay_preferred_pct', '100'),
  ('prepay_min_pct_under_1m', '50'),
  ('staged_payment_threshold_rub', '1000000'),
  ('rfq_target_min', '10'),
  ('rfq_target_max', '20'),
  ('importer_scheme', '"manual"'),
  ('customs_confirmed_autonomy_threshold', '500'),
  ('followup_default_hours', '[24, 72, 168]'),
  ('followup_urgent_hours', '2'),
  ('shipment_urgent_days', '14'),
  ('vip_volume_min', '5'),
  ('vip_volume_max', '50'),
  ('long_route_compare_km', '2100'),
  ('night_express_enabled', 'true'),
  ('academy_enabled', 'true'),
  ('academy_in_kp', 'true'),
  ('academy_in_rfq', 'true'),
  ('academy_in_prompts', 'true'),
  ('academy_in_voice', 'true'),
  ('comm_tone', '"commercial"'),
  ('always_ask_client', '["weight_kg","ready_date"]'),
  ('client_do_not_say', '["внутренние ставки поставщиков","маржа","себестоимость RFQ"]'),
  ('staff_coaching_rules', '["Один уточняющий вопрос за раз","Не выдумывать ставки","Клиенту — только белые схемы"]'),
  ('staff_coach_ttl_days', '30')
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

CREATE TABLE IF NOT EXISTS staff_users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('director', 'manager')),
  name TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_staff_users_role ON staff_users(role) WHERE active = TRUE;

CREATE TABLE IF NOT EXISTS staff_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor_id UUID,
  actor_email TEXT,
  actor_role TEXT,
  action TEXT NOT NULL,
  target_id UUID,
  target_email TEXT,
  summary TEXT NOT NULL,
  meta JSONB NOT NULL DEFAULT '{}',
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_staff_events_created ON staff_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_staff_events_actor ON staff_events(actor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS clients (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  channel TEXT,
  tg_chat_id BIGINT,
  phone TEXT,
  name TEXT,
  legal_name TEXT,
  inn TEXT,
  primary_email TEXT,
  abc JSONB NOT NULL DEFAULT '{}',
  vip BOOLEAN NOT NULL DEFAULT FALSE,
  personal_context JSONB NOT NULL DEFAULT '{}',
  preferred_comm TEXT,
  payment_discipline TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_clients_tg ON clients(tg_chat_id);
CREATE INDEX IF NOT EXISTS idx_clients_phone ON clients(phone);
CREATE INDEX IF NOT EXISTS idx_clients_primary_email ON clients (lower(primary_email));

CREATE TABLE IF NOT EXISTS client_identities (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('email', 'phone', 'tg_chat_id', 'inn')),
  value TEXT NOT NULL,
  value_norm TEXT NOT NULL,
  source TEXT,
  confidence NUMERIC(4,3) NOT NULL DEFAULT 1.0,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (kind, value_norm)
);
CREATE INDEX IF NOT EXISTS idx_client_identities_client ON client_identities(client_id);
CREATE INDEX IF NOT EXISTS idx_client_identities_value ON client_identities(value_norm);

CREATE TABLE IF NOT EXISTS mail_threads (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  thread_key TEXT NOT NULL UNIQUE,
  subject_norm TEXT,
  client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
  first_at TIMESTAMPTZ,
  last_at TIMESTAMPTZ,
  message_count INT NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mail_threads_client ON mail_threads(client_id);

CREATE TABLE IF NOT EXISTS mail_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  mailbox_id TEXT NOT NULL,
  folder TEXT NOT NULL DEFAULT 'INBOX',
  uid BIGINT,
  message_id TEXT,
  in_reply_to TEXT,
  references_hdr TEXT,
  thread_id UUID REFERENCES mail_threads(id) ON DELETE SET NULL,
  thread_key TEXT,
  from_raw TEXT,
  from_email TEXT,
  to_emails TEXT[] NOT NULL DEFAULT '{}',
  cc_emails TEXT[] NOT NULL DEFAULT '{}',
  subject TEXT,
  sent_at TIMESTAMPTZ,
  body_text TEXT,
  raw_path TEXT,
  role TEXT NOT NULL DEFAULT 'other'
    CHECK (role IN ('client', 'supplier', 'service_provider', 'internal', 'other', 'newsletter')),
  client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
  direction TEXT CHECK (direction IS NULL OR direction IN ('inbound', 'outbound')),
  content_hash TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (mailbox_id, folder, uid),
  UNIQUE (message_id)
);
CREATE INDEX IF NOT EXISTS idx_mail_messages_client ON mail_messages(client_id);
CREATE INDEX IF NOT EXISTS idx_mail_messages_from ON mail_messages(lower(from_email));
CREATE INDEX IF NOT EXISTS idx_mail_messages_thread ON mail_messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_mail_messages_role ON mail_messages(role);
CREATE INDEX IF NOT EXISTS idx_mail_messages_sent ON mail_messages(sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_mail_messages_content_hash ON mail_messages(content_hash);

CREATE TABLE IF NOT EXISTS mail_attachments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  mail_message_id UUID REFERENCES mail_messages(id) ON DELETE CASCADE,
  client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
  filename TEXT NOT NULL,
  content_type TEXT,
  bytes INT,
  sha256 TEXT NOT NULL UNIQUE,
  storage_key TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other'
    CHECK (kind IN ('kp', 'contracts', 'invoices', 'payments', 'customs', 'client', 'other')),
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mail_attachments_message ON mail_attachments(mail_message_id);
CREATE INDEX IF NOT EXISTS idx_mail_attachments_client ON mail_attachments(client_id);

CREATE TABLE IF NOT EXISTS service_providers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  category TEXT NOT NULL
    CHECK (category IN ('post', 'fuel', 'glonass', 'tracking', 'telecom', 'bank', 'it_saas', 'other_service')),
  primary_email TEXT UNIQUE,
  domains TEXT[] NOT NULL DEFAULT '{}',
  message_count INT NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_service_providers_category ON service_providers(category);

CREATE TABLE IF NOT EXISTS newsletter_purge_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  message_id TEXT,
  from_email TEXT,
  subject TEXT,
  reason TEXT NOT NULL,
  mailbox_id TEXT,
  raw_path TEXT,
  purged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS client_calc_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  source_message_id UUID REFERENCES mail_messages(id) ON DELETE SET NULL,
  thread_id UUID REFERENCES mail_threads(id) ON DELETE SET NULL,
  origin TEXT,
  destination TEXT,
  mode TEXT,
  cargo_desc TEXT,
  ready_date TEXT,
  amount NUMERIC(14,2),
  currency TEXT,
  requested_at TIMESTAMPTZ,
  raw JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_client_calc_client ON client_calc_requests(client_id);
CREATE INDEX IF NOT EXISTS idx_client_calc_mode ON client_calc_requests(mode);
CREATE INDEX IF NOT EXISTS idx_client_calc_requested ON client_calc_requests(requested_at DESC);

CREATE TABLE IF NOT EXISTS client_facts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  fact_type TEXT NOT NULL,
  value TEXT NOT NULL,
  source_message_id UUID REFERENCES mail_messages(id) ON DELETE SET NULL,
  confidence NUMERIC(4,3) NOT NULL DEFAULT 0.7,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_client_facts_client ON client_facts(client_id);
CREATE INDEX IF NOT EXISTS idx_client_facts_type ON client_facts(fact_type);

ALTER TABLE deals ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES clients(id) ON DELETE SET NULL;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS calculation_assumptions JSONB NOT NULL DEFAULT '[]';
ALTER TABLE deals ADD COLUMN IF NOT EXISTS quote_fidelity TEXT;

CREATE TABLE IF NOT EXISTS suppliers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  partner_id UUID REFERENCES partners(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  code TEXT UNIQUE,
  inn TEXT,
  modes TEXT[] NOT NULL DEFAULT '{}',
  corridors TEXT[] NOT NULL DEFAULT '{}',
  strong_lanes JSONB NOT NULL DEFAULT '[]',
  payment_terms JSONB NOT NULL DEFAULT '{}',
  contacts JSONB NOT NULL DEFAULT '{}',
  verification JSONB NOT NULL DEFAULT '{}',
  performance JSONB NOT NULL DEFAULT '{}',
  fraud_watch BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  left_market BOOLEAN NOT NULL DEFAULT FALSE,
  silent BOOLEAN NOT NULL DEFAULT FALSE,
  silent_at TIMESTAMPTZ,
  silent_note TEXT,
  last_rfq_at TIMESTAMPTZ,
  last_reply_at TIMESTAMPTZ,
  no_reply_streak INT NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_suppliers_active ON suppliers(active) WHERE active AND NOT left_market;
CREATE INDEX IF NOT EXISTS idx_suppliers_modes ON suppliers USING GIN (modes);
CREATE INDEX IF NOT EXISTS idx_suppliers_silent
  ON suppliers(silent) WHERE silent AND active AND NOT left_market;

ALTER TABLE partners ADD COLUMN IF NOT EXISTS modes TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE partners ADD COLUMN IF NOT EXISTS inn TEXT;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS vat_mode TEXT;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS verification JSONB NOT NULL DEFAULT '{}';
ALTER TABLE partners ADD COLUMN IF NOT EXISTS performance JSONB NOT NULL DEFAULT '{}';

ALTER TABLE quotes ADD COLUMN IF NOT EXISTS supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS raw_supplier_quote NUMERIC(14,2);
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS supplier_vat_mode TEXT;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS effective_supplier_cost NUMERIC(14,2);
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS is_benchmark BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS transport_mode TEXT;

CREATE TABLE IF NOT EXISTS rate_benchmarks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lane TEXT NOT NULL,
  transport_mode TEXT,
  unit TEXT NOT NULL DEFAULT 'rub',
  value NUMERIC(14,4) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'RUB',
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source TEXT,
  deal_id UUID REFERENCES deals(id) ON DELETE SET NULL,
  notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS cashflow_plans (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  amount_rub NUMERIC(14,2) NOT NULL,
  client_prepay_pct NUMERIC(6,2),
  supplier_prepay_pct NUMERIC(6,2),
  gap BOOLEAN NOT NULL DEFAULT FALSE,
  stages JSONB NOT NULL DEFAULT '[]',
  notes JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS execution_playbooks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  author TEXT,
  body JSONB NOT NULL DEFAULT '{}',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS follow_ups (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  due_at TIMESTAMPTZ NOT NULL,
  done BOOLEAN NOT NULL DEFAULT FALSE,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS supplier_questions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL,
  question TEXT NOT NULL,
  card_answer TEXT,
  client_answer TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS volume_lanes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lane TEXT NOT NULL,
  transport_mode TEXT,
  period_month DATE NOT NULL,
  won_qty NUMERIC(12,3) NOT NULL DEFAULT 0,
  potential_qty NUMERIC(12,3) NOT NULL DEFAULT 0,
  lost_on_price INT NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(lane, transport_mode, period_month)
);

CREATE TABLE IF NOT EXISTS director_reports (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hs_broker_feedback (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  deal_id UUID REFERENCES deals(id) ON DELETE SET NULL,
  ai_hs TEXT,
  broker_hs TEXT,
  match BOOLEAN,
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

