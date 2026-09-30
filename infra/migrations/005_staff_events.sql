-- Cabinet manager audit journal + last login on staff_users.
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

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
