-- Voice channel: deals by phone, call sessions, message channel

ALTER TABLE deals ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'telegram';
ALTER TABLE deals ADD COLUMN IF NOT EXISTS client_phone TEXT;
ALTER TABLE deals ALTER COLUMN tg_chat_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_deals_channel_phone ON deals(channel, client_phone)
  WHERE client_phone IS NOT NULL;

ALTER TABLE messages ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'telegram';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS call_session_id UUID;
ALTER TABLE messages ALTER COLUMN tg_chat_id DROP NOT NULL;

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
  DROP CONSTRAINT IF EXISTS messages_call_session_id_fkey;
ALTER TABLE messages
  ADD CONSTRAINT messages_call_session_id_fkey
  FOREIGN KEY (call_session_id) REFERENCES call_sessions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_messages_call_session ON messages(call_session_id, created_at);
