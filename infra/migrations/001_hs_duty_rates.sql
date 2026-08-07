-- Apply on existing DBs (init.sql only runs on fresh postgres volume)
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
