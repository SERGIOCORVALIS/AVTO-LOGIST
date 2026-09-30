-- Quality tracking for supplier RFQ responsiveness
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS no_reply_streak INT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_suppliers_rfq_stale
  ON suppliers(last_rfq_at)
  WHERE active AND NOT left_market AND NOT silent AND last_rfq_at IS NOT NULL;
