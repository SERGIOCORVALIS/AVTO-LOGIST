import type { Pool } from "pg";

function streakThreshold(): number {
  const n = Number(process.env.SUPPLIER_SILENT_AFTER_STREAK || 3);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3;
}

function staleHours(): number {
  const n = Number(process.env.SUPPLIER_SILENT_AFTER_HOURS || 72);
  return Number.isFinite(n) && n > 0 ? n : 72;
}

/** After outbound RFQ email — bump streak and last_rfq_at. */
export async function markSupplierRfqSent(pool: Pool, email: string | undefined) {
  const to = (email || "").trim().toLowerCase();
  if (!to || !to.includes("@")) return;
  await pool.query(
    `
    UPDATE suppliers s SET
      last_rfq_at = NOW(),
      no_reply_streak = COALESCE(s.no_reply_streak, 0) + 1,
      performance = COALESCE(s.performance, '{}'::jsonb) || jsonb_build_object(
        'last_rfq_email', $1::text,
        'no_reply_streak', COALESCE(s.no_reply_streak, 0) + 1
      ),
      updated_at = NOW()
    FROM partner_contacts pc
    WHERE pc.partner_id = s.partner_id
      AND lower(pc.email) = $1
      AND s.active = TRUE
      AND s.left_market = FALSE
    `,
    [to]
  );
}

/** Inbound quote/reply from supplier — reset streak, clear auto-silent. */
export async function markSupplierReplied(pool: Pool, email: string | undefined) {
  const from = (email || "").trim().toLowerCase();
  if (!from || !from.includes("@")) return;
  // extract bare email if "Name <a@b.c>"
  const m = from.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  const addr = (m?.[0] || from).toLowerCase();
  await pool.query(
    `
    UPDATE suppliers s SET
      last_reply_at = NOW(),
      no_reply_streak = 0,
      silent = CASE
        WHEN s.silent AND COALESCE(s.silent_note, '') LIKE 'auto:%' THEN FALSE
        ELSE s.silent
      END,
      silent_at = CASE
        WHEN s.silent AND COALESCE(s.silent_note, '') LIKE 'auto:%' THEN NULL
        ELSE s.silent_at
      END,
      silent_note = CASE
        WHEN s.silent AND COALESCE(s.silent_note, '') LIKE 'auto:%' THEN NULL
        ELSE s.silent_note
      END,
      performance = COALESCE(s.performance, '{}'::jsonb) || jsonb_build_object(
        'last_reply_email', $1::text,
        'no_reply_streak', 0
      ),
      updated_at = NOW()
    FROM partner_contacts pc
    WHERE pc.partner_id = s.partner_id
      AND lower(pc.email) = $1
    `,
    [addr]
  );
}

/**
 * Auto-flag silent suppliers:
 * - no_reply_streak >= SUPPLIER_SILENT_AFTER_STREAK (default 3), or
 * - last RFQ older than SUPPLIER_SILENT_AFTER_HOURS (default 72) without a later reply.
 */
export async function autoMarkSilentSuppliers(pool: Pool): Promise<number> {
  for (const ddl of [
    `ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS no_reply_streak INT NOT NULL DEFAULT 0`,
    `ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS silent BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS silent_at TIMESTAMPTZ`,
    `ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS silent_note TEXT`,
    `ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS last_rfq_at TIMESTAMPTZ`,
    `ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS last_reply_at TIMESTAMPTZ`,
  ]) {
    await pool.query(ddl);
  }

  const streak = streakThreshold();
  const hours = staleHours();
  const r = await pool.query(
    `
    UPDATE suppliers SET
      silent = TRUE,
      silent_at = NOW(),
      silent_note = CASE
        WHEN COALESCE(no_reply_streak, 0) >= $1
          THEN 'auto: нет ответа после ' || COALESCE(no_reply_streak, 0)::text || ' RFQ'
        ELSE 'auto: нет ответа > ' || $2::text || ' ч после последнего RFQ'
      END,
      updated_at = NOW()
    WHERE active = TRUE
      AND left_market = FALSE
      AND silent = FALSE
      AND last_rfq_at IS NOT NULL
      AND (
        COALESCE(no_reply_streak, 0) >= $1
        OR (
          last_rfq_at < NOW() - ($2::text || ' hours')::interval
          AND (last_reply_at IS NULL OR last_reply_at < last_rfq_at)
        )
      )
    RETURNING id
    `,
    [streak, hours]
  );
  return r.rowCount ?? 0;
}
