-- Supplier response status for cabinet RFQ control
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS silent BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS silent_at TIMESTAMPTZ;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS silent_note TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS last_rfq_at TIMESTAMPTZ;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS last_reply_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_suppliers_silent 
  ON suppliers(silent) WHERE silent AND active AND NOT left_market;

CREATE INDEX IF NOT EXISTS idx_suppliers_left
  ON suppliers(left_market) WHERE left_market;
