import type { FastifyInstance } from "fastify";
import { createReadStream, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { z } from "zod";
import { pool } from "../db";

const REPO_ROOT = resolve(__dirname, "../../../..");

export function registerClientRoutes(app: FastifyInstance) {
  app.get("/clients/archive/summary", async () => {
    const [totals, mailboxes, modes, facts, services] = await Promise.all([
      pool.query(`
        SELECT
          (SELECT COUNT(*)::int FROM clients) AS clients,
          (SELECT COUNT(*)::int FROM mail_messages) AS messages,
          (SELECT COUNT(*)::int FROM mail_threads) AS threads,
          (SELECT COUNT(*)::int FROM client_calc_requests) AS calcs,
          (SELECT COUNT(*)::int FROM deals WHERE client_id IS NOT NULL) AS deals_linked,
          (SELECT COUNT(*)::int FROM mail_attachments) AS attachments,
          (SELECT COUNT(*)::int FROM service_providers) AS service_providers
      `),
      pool.query(`
        SELECT mailbox_id, COUNT(*)::int AS messages,
               COUNT(DISTINCT client_id)::int AS clients,
               MIN(sent_at) AS first_at, MAX(sent_at) AS last_at
        FROM mail_messages
        GROUP BY mailbox_id
        ORDER BY messages DESC
      `),
      pool.query(`
        SELECT mode, COUNT(*)::int AS n
        FROM client_calc_requests
        WHERE mode IS NOT NULL AND mode <> ''
        GROUP BY mode
        ORDER BY n DESC
        LIMIT 12
      `),
      pool.query(`
        SELECT fact_type, COUNT(*)::int AS n
        FROM client_facts
        GROUP BY fact_type
        ORDER BY n DESC
      `),
      pool.query(`
        SELECT id, name, category, primary_email, message_count
        FROM service_providers
        ORDER BY message_count DESC
        LIMIT 50
      `),
    ]);
    return {
      totals: totals.rows[0],
      mailboxes: mailboxes.rows,
      modes: modes.rows,
      facts: facts.rows,
      service_providers: services.rows,
    };
  });

  app.get("/clients/archive/export.xlsx", async (_req, reply) => {
    const day = new Date().toISOString().slice(0, 10);
    const preferred = resolve(
      REPO_ROOT,
      "data/exports",
      `clients-archive-${day}.xlsx`
    );
    let path = preferred;
    if (!existsSync(path)) {
      // fall back to any latest export
      const dir = resolve(REPO_ROOT, "data/exports");
      const { readdirSync } = await import("node:fs");
      try {
        const files = readdirSync(dir)
          .filter((f) => f.endsWith(".xlsx"))
          .sort()
          .reverse();
        if (files[0]) path = join(dir, files[0]);
      } catch {
        /* empty */
      }
    }
    if (!existsSync(path)) {
      return reply.code(404).send({
        error: "export_not_found",
        hint: "Run: pnpm mail:archive-excel",
      });
    }
    reply.header(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    reply.header(
      "Content-Disposition",
      `attachment; filename="clients-archive.xlsx"`
    );
    return reply.send(createReadStream(path));
  });

  app.get<{ Params: { id: string } }>(
    "/clients/attachments/:id/file",
    async (req, reply) => {
      const r = await pool.query(
        `SELECT * FROM mail_attachments WHERE id = $1`,
        [req.params.id]
      );
      const att = r.rows[0];
      if (!att) return reply.code(404).send({ error: "not_found" });
      const abs = resolve(
        REPO_ROOT,
        "data/mail-archive",
        att.storage_key
      );
      if (!existsSync(abs)) {
        return reply.code(404).send({ error: "file_missing" });
      }
      reply.header(
        "Content-Type",
        att.content_type || "application/octet-stream"
      );
      reply.header(
        "Content-Disposition",
        `attachment; filename="${encodeURIComponent(att.filename)}"`
      );
      return reply.send(createReadStream(abs));
    }
  );

  app.get("/clients", async (req) => {
    const q = z
      .object({
        q: z.string().optional(),
        vip: z.enum(["true", "false"]).optional(),
        has_calcs: z.enum(["true", "false"]).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional().default(50),
        offset: z.coerce.number().int().min(0).optional().default(0),
      })
      .parse(req.query);

    const params: unknown[] = [];
    const where: string[] = [];
    if (q.q?.trim()) {
      params.push(`%${q.q.trim()}%`);
      const i = params.length;
      where.push(
        `(c.name ILIKE $${i} OR c.legal_name ILIKE $${i} OR c.primary_email ILIKE $${i} OR c.phone ILIKE $${i} OR c.inn ILIKE $${i})`
      );
    }
    if (q.vip === "true") where.push("c.vip = TRUE");
    if (q.vip === "false") where.push("c.vip = FALSE");
    if (q.has_calcs === "true") {
      where.push(
        "EXISTS (SELECT 1 FROM client_calc_requests r WHERE r.client_id = c.id)"
      );
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    params.push(q.limit, q.offset);

    const r = await pool.query(
      `
      SELECT c.id, c.name, c.legal_name, c.primary_email, c.phone, c.inn,
             c.vip, c.abc, c.personal_context, c.preferred_comm,
             c.created_at, c.updated_at,
             (SELECT COUNT(*)::int FROM client_calc_requests r WHERE r.client_id = c.id) AS calc_count,
             (SELECT COUNT(*)::int FROM client_identities i WHERE i.client_id = c.id) AS identity_count,
             (SELECT COUNT(*)::int FROM deals d WHERE d.client_id = c.id) AS deal_count,
             (SELECT COUNT(*)::int FROM client_facts f WHERE f.client_id = c.id AND f.fact_type = 'invoice') AS invoice_count,
             (SELECT COUNT(*)::int FROM client_facts f WHERE f.client_id = c.id AND f.fact_type = 'contract') AS contract_count,
             (SELECT COUNT(*)::int FROM mail_attachments a WHERE a.client_id = c.id) AS attachment_count,
             (SELECT COUNT(*)::int FROM mail_attachments a WHERE a.client_id = c.id AND a.kind = 'contracts') AS contract_file_count,
             (SELECT COUNT(*)::int FROM mail_attachments a WHERE a.client_id = c.id AND a.kind IN ('invoices', 'payments')) AS invoice_file_count
      FROM clients c
      ${whereSql}
      ORDER BY c.updated_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
      `,
      params
    );
    const countParams = params.slice(0, -2);
    const countSql = where.length
      ? `SELECT COUNT(*)::int AS n FROM clients c ${whereSql}`
      : `SELECT COUNT(*)::int AS n FROM clients`;
    const total = await pool.query(countSql, countParams);
    return {
      items: r.rows,
      limit: q.limit,
      offset: q.offset,
      total: total.rows[0]?.n ?? r.rows.length,
    };
  });

  app.get<{ Params: { id: string } }>("/clients/:id", async (req, reply) => {
    const id = req.params.id;
    const client = await pool.query(`SELECT * FROM clients WHERE id = $1`, [id]);
    if (!client.rows[0]) return reply.code(404).send({ error: "not_found" });

    const [identities, calcs, facts, threads, attachments] = await Promise.all([
      pool.query(
        `SELECT id, kind, value, value_norm, source, confidence, created_at
         FROM client_identities WHERE client_id = $1 ORDER BY kind, value`,
        [id]
      ),
      pool.query(
        `SELECT id, origin, destination, mode, cargo_desc, ready_date,
                amount, currency, requested_at, source_message_id, raw
         FROM client_calc_requests
         WHERE client_id = $1
         ORDER BY requested_at DESC NULLS LAST
         LIMIT 100`,
        [id]
      ),
      pool.query(
        `SELECT id, fact_type, value, confidence, source_message_id, created_at
         FROM client_facts WHERE client_id = $1
         ORDER BY created_at DESC LIMIT 100`,
        [id]
      ),
      pool.query(
        `SELECT id, thread_key, subject_norm, first_at, last_at, message_count
         FROM mail_threads WHERE client_id = $1
         ORDER BY last_at DESC NULLS LAST LIMIT 50`,
        [id]
      ),
      pool.query(
        `SELECT a.id, a.filename, a.content_type, a.bytes, a.kind, a.sha256,
                a.storage_key, a.created_at, a.mail_message_id,
                m.subject AS mail_subject, m.sent_at AS mail_sent_at,
                m.mailbox_id, m.folder
         FROM mail_attachments a
         LEFT JOIN mail_messages m ON m.id = a.mail_message_id
         WHERE a.client_id = $1 OR m.client_id = $1
         ORDER BY a.created_at DESC
         LIMIT 500`,
        [id]
      ),
    ]);

    // Stable sort for UI: contracts → payments → invoices → kp → rest
    const kindRank: Record<string, number> = {
      contracts: 0,
      payments: 1,
      invoices: 2,
      kp: 3,
      customs: 4,
      client: 5,
      other: 6,
    };
    const attachmentRows = [...attachments.rows].sort((a, b) => {
      const ra = kindRank[a.kind] ?? 9;
      const rb = kindRank[b.kind] ?? 9;
      if (ra !== rb) return ra - rb;
      const ta = a.mail_sent_at || a.created_at;
      const tb = b.mail_sent_at || b.created_at;
      return String(tb).localeCompare(String(ta));
    });

    const deals = await pool.query(
      `
      SELECT id, status, channel, client_name, client_phone, route, cargo,
             amount_rub, margin_pct, created_at, updated_at
      FROM deals
      WHERE client_id = $1
      ORDER BY updated_at DESC
      LIMIT 30
      `,
      [id]
    );

    const recentMail = await pool.query(
      `
      SELECT id, mailbox_id, folder, subject, from_email, sent_at, role, direction,
             LEFT(body_text, 400) AS preview
      FROM mail_messages
      WHERE client_id = $1
      ORDER BY sent_at DESC NULLS LAST
      LIMIT 30
      `,
      [id]
    );

    return {
      client: client.rows[0],
      identities: identities.rows,
      calc_requests: calcs.rows,
      facts: facts.rows,
      threads: threads.rows,
      deals: deals.rows,
      recent_mail: recentMail.rows,
      attachments: attachmentRows,
      docs_summary: {
        contracts: attachmentRows.filter((a) => a.kind === "contracts").length,
        invoices: attachmentRows.filter((a) => a.kind === "invoices").length,
        payments: attachmentRows.filter((a) => a.kind === "payments").length,
        kp: attachmentRows.filter((a) => a.kind === "kp").length,
        other: attachmentRows.filter(
          (a) => !["contracts", "invoices", "payments", "kp"].includes(a.kind)
        ).length,
        total: attachmentRows.length,
      },
    };
  });
}
