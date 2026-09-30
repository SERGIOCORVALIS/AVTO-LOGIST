-- Mail attachments, content hash, service providers, newsletter purge support.
-- Apply via pnpm db:migrate.

-- Allow service_provider role on mail messages
ALTER TABLE mail_messages DROP CONSTRAINT IF EXISTS mail_messages_role_check;
ALTER TABLE mail_messages ADD CONSTRAINT mail_messages_role_check
  CHECK (role IN ('client', 'supplier', 'service_provider', 'internal', 'other', 'newsletter'));

ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS content_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_mail_messages_content_hash ON mail_messages(content_hash);

CREATE TABLE IF NOT EXISTS mail_attachments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  mail_message_id UUID REFERENCES mail_messages(id) ON DELETE CASCADE,
  client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
  filename TEXT NOT NULL,
  content_type TEXT,
  bytes INT,
  sha256 TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other'
    CHECK (kind IN ('kp', 'contracts', 'invoices', 'payments', 'customs', 'client', 'other')),
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (sha256)
);
CREATE INDEX IF NOT EXISTS idx_mail_attachments_message ON mail_attachments(mail_message_id);
CREATE INDEX IF NOT EXISTS idx_mail_attachments_client ON mail_attachments(client_id);
CREATE INDEX IF NOT EXISTS idx_mail_attachments_kind ON mail_attachments(kind);

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
CREATE INDEX IF NOT EXISTS idx_newsletter_purge_at ON newsletter_purge_log(purged_at DESC);
