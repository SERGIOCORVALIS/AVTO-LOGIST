-- Client mail archive: identities, messages, threads, calc requests, facts.
-- Apply via pnpm db:migrate (schema_migrations).

ALTER TABLE clients ADD COLUMN IF NOT EXISTS primary_email TEXT;
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
    CHECK (role IN ('client', 'supplier', 'internal', 'other')),
  client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
  direction TEXT CHECK (direction IS NULL OR direction IN ('inbound', 'outbound')),
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
