-- Rename telephony provider call id (Voximplant → generic SIP/provider)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'call_sessions'
      AND column_name = 'voximplant_call_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'call_sessions'
      AND column_name = 'provider_call_id'
  ) THEN
    ALTER TABLE call_sessions RENAME COLUMN voximplant_call_id TO provider_call_id;
  ELSIF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'call_sessions'
      AND column_name = 'provider_call_id'
  ) THEN
    ALTER TABLE call_sessions ADD COLUMN provider_call_id TEXT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_call_sessions_provider_call
  ON call_sessions(provider_call_id)
  WHERE provider_call_id IS NOT NULL;
