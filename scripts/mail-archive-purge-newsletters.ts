/**
 * Detect newsletters and purge from DB + local EML (with audit log).
 * Usage: pnpm mail:archive-purge-newsletters [--dry-run]
 */
import { config } from "dotenv";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { looksLikeNewsletter } from "./mail-archive-rules";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
config({ path: resolve(ROOT, ".env") });
const { Pool } = createRequire(resolve(ROOT, "apps/api/package.json"))("pg");
const DRY = process.argv.includes("--dry-run");

async function main() {
  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ||
      "postgresql://alo:alo@localhost:5432/autologistics",
  });

  const candidates = await pool.query(`
    SELECT id, message_id, from_email, subject, body_text, mailbox_id, raw_path, role, client_id, metadata
    FROM mail_messages
    WHERE role IN ('newsletter', 'other')
       OR from_email ~* 'noreply|no-reply|newsletter|mailer-daemon|notify@'
       OR subject ~* 'unsubscribe|отписаться|рассылк|newsletter'
    ORDER BY sent_at DESC NULLS LAST
    LIMIT 20000
  `);

  const purged: Array<{
    id: string;
    message_id: string | null;
    from_email: string | null;
    subject: string | null;
    reason: string;
    mailbox_id: string;
    raw_path: string | null;
  }> = [];

  for (const row of candidates.rows) {
    if (row.role === "client" || row.role === "supplier") continue;

    // Protect if has business facts linked
    if (row.client_id) {
      const facts = await pool.query(
        `SELECT 1 FROM client_facts
         WHERE source_message_id = $1 AND fact_type IN ('invoice','contract')
         LIMIT 1`,
        [row.id]
      );
      const calc = await pool.query(
        `SELECT 1 FROM client_calc_requests WHERE source_message_id = $1 LIMIT 1`,
        [row.id]
      );
      if (facts.rows[0] || calc.rows[0]) continue;
    }

    const check = looksLikeNewsletter({
      fromEmail: row.from_email || "",
      subject: row.subject || "",
      body: row.body_text || "",
      headers: (row.metadata as { headers?: Record<string, string> })?.headers,
    });
    const reason =
      row.role === "newsletter"
        ? "role_newsletter"
        : check.yes
          ? check.reason
          : /noreply|no-reply|newsletter|mailer-daemon/i.test(row.from_email || "")
            ? "noreply_from"
            : "";
    if (!reason) continue;

    purged.push({
      id: row.id,
      message_id: row.message_id,
      from_email: row.from_email,
      subject: row.subject,
      reason,
      mailbox_id: row.mailbox_id,
      raw_path: row.raw_path,
    });
  }

  const day = new Date().toISOString().slice(0, 10);
  const reportDir = resolve(ROOT, "logs/mail");
  mkdirSync(reportDir, { recursive: true });
  const reportPath = join(reportDir, `newsletter-purge-${day}.md`);
  const reportLines = [
    "# Newsletter purge",
    "",
    `Date: ${day}`,
    DRY ? "*(dry-run — nothing deleted)*" : "**DELETED**",
    `Candidates: ${purged.length}`,
    "",
    ...purged.slice(0, 500).map(
      (p) =>
        `- [${p.reason}] ${p.mailbox_id} | ${p.from_email || "?"} | ${(p.subject || "").slice(0, 80)}`
    ),
    "",
  ];
  writeFileSync(reportPath, reportLines.join("\n"), "utf8");
  console.log(`[report] ${reportPath} candidates=${purged.length}`);

  if (!DRY) {
    for (const p of purged) {
      await pool.query(
        `INSERT INTO newsletter_purge_log (message_id, from_email, subject, reason, mailbox_id, raw_path)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [p.message_id, p.from_email, p.subject, p.reason, p.mailbox_id, p.raw_path]
      );

      const atts = await pool.query(
        `SELECT storage_key FROM mail_attachments WHERE mail_message_id = $1`,
        [p.id]
      );
      await pool.query(`DELETE FROM mail_messages WHERE id = $1`, [p.id]);

      if (p.raw_path) {
        const abs = resolve(ROOT, p.raw_path);
        if (existsSync(abs)) {
          try {
            unlinkSync(abs);
            const meta = abs.replace(/\.eml$/i, ".json");
            if (existsSync(meta)) unlinkSync(meta);
          } catch {
            /* ignore */
          }
        }
      }
      for (const a of atts.rows) {
        const still = await pool.query(
          `SELECT 1 FROM mail_attachments WHERE storage_key = $1 LIMIT 1`,
          [a.storage_key]
        );
        if (still.rows[0]) continue;
        const ap = resolve(ROOT, "data/mail-archive", a.storage_key);
        if (existsSync(ap)) {
          try {
            unlinkSync(ap);
          } catch {
            /* ignore */
          }
        }
      }
    }

    // Orphan clients from newsletters only
    const orphans = await pool.query(`
      SELECT c.id FROM clients c
      WHERE NOT EXISTS (SELECT 1 FROM mail_messages m WHERE m.client_id = c.id)
        AND NOT EXISTS (SELECT 1 FROM client_calc_requests r WHERE r.client_id = c.id)
        AND NOT EXISTS (SELECT 1 FROM deals d WHERE d.client_id = c.id)
        AND COALESCE(c.metadata->>'source','') LIKE 'mail:%'
    `);
    for (const o of orphans.rows) {
      await pool.query(
        `UPDATE clients SET metadata = metadata || '{"orphaned_newsletter":true}'::jsonb WHERE id = $1`,
        [o.id]
      );
      await pool.query(`DELETE FROM clients WHERE id = $1`, [o.id]);
    }
    console.log(`[purge] deleted messages=${purged.length} orphan_clients=${orphans.rows.length}`);
  }

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
