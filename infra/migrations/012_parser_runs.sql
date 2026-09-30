-- Parser schedule settings and run history (KazATO / BAMAP associations).
CREATE TABLE IF NOT EXISTS parser_settings (
  id TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  cron TEXT NOT NULL DEFAULT '0 6 * * 1',
  enrich_emails BOOLEAN NOT NULL DEFAULT TRUE,
  auto_seed BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO parser_settings (id, enabled, cron, enrich_emails, auto_seed)
VALUES ('associations_cis', TRUE, '0 6 * * 1', TRUE, TRUE)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS parser_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  parser_id TEXT NOT NULL DEFAULT 'associations_cis',
  status TEXT NOT NULL DEFAULT 'queued',
  triggered_by TEXT NOT NULL DEFAULT 'schedule',
  triggered_by_staff_id UUID,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  stats JSONB NOT NULL DEFAULT '{}',
  error TEXT,
  log_path TEXT
);

CREATE INDEX IF NOT EXISTS idx_parser_runs_started ON parser_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_parser_runs_parser_status ON parser_runs(parser_id, status, started_at DESC);
