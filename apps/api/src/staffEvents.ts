import type { FastifyRequest } from "fastify";
import { pool } from "./db";
import type { RequestStaff } from "./auth";

export async function ensureStaffEventsSchema(): Promise<void> {
  await pool.query(`
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
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_staff_events_created ON staff_events(created_at DESC)`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_staff_events_actor ON staff_events(actor_id, created_at DESC)`
  );
  await pool.query(
    `ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ`
  );
}

export async function logStaffEvent(opts: {
  req?: FastifyRequest;
  actor?: RequestStaff | null;
  action: string;
  summary: string;
  target_id?: string | null;
  target_email?: string | null;
  meta?: Record<string, unknown>;
}): Promise<void> {
  const ip =
    (typeof opts.req?.headers["x-forwarded-for"] === "string"
      ? opts.req.headers["x-forwarded-for"].split(",")[0]?.trim()
      : "") ||
    opts.req?.ip ||
    null;
  try {
    await pool.query(
      `INSERT INTO staff_events
         (actor_id, actor_email, actor_role, action, target_id, target_email, summary, meta, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
      [
        opts.actor?.id ?? null,
        opts.actor?.email ?? null,
        opts.actor?.role ?? null,
        opts.action,
        opts.target_id ?? null,
        opts.target_email ?? null,
        opts.summary,
        JSON.stringify(opts.meta ?? {}),
        ip,
      ]
    );
  } catch (err) {
    opts.req?.log?.error({ err }, "staff_event_log_failed");
  }
}
