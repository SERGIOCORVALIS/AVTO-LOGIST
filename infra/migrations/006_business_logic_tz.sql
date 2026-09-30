-- TRANSINVEST TZ v1: supplier/client memory, quotes as history, cashflow,
-- assumptions, execution playbooks, follow-up, ABC, volume intelligence.
-- Apply on existing DBs (init.sql only runs on a fresh postgres volume).

INSERT INTO policy_config (key, value) VALUES
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
  ('academy_in_voice', 'true')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS clients (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  channel TEXT,
  tg_chat_id BIGINT,
  phone TEXT,
  name TEXT,
  legal_name TEXT,
  inn TEXT,
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
CREATE INDEX IF NOT EXISTS idx_clients_inn ON clients(inn);

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
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_suppliers_active ON suppliers(active) WHERE active AND NOT left_market;
CREATE INDEX IF NOT EXISTS idx_suppliers_modes ON suppliers USING GIN (modes);

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
CREATE INDEX IF NOT EXISTS idx_rate_benchmarks_lane ON rate_benchmarks(lane, transport_mode, captured_at DESC);

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
CREATE INDEX IF NOT EXISTS idx_follow_ups_due ON follow_ups(due_at) WHERE done = FALSE;

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
