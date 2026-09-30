import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db";
import { requireDirector } from "../auth";

const MODES = [
  "ltl_groupage",
  "ftl_truck",
  "road_train",
  "night_express",
  "container",
  "rail",
  "sea",
  "air",
] as const;

const CORRIDORS = ["ru_domestic", "cn_import", "international"] as const;

function slugify(name: string): string {
  const map: Record<string, string> = {
    а: "a",
    б: "b",
    в: "v",
    г: "g",
    д: "d",
    е: "e",
    ё: "e",
    ж: "zh",
    з: "z",
    и: "i",
    й: "y",
    к: "k",
    л: "l",
    м: "m",
    н: "n",
    о: "o",
    п: "p",
    р: "r",
    с: "s",
    т: "t",
    у: "u",
    ф: "f",
    х: "h",
    ц: "ts",
    ч: "ch",
    ш: "sh",
    щ: "sch",
    ъ: "",
    ы: "y",
    ь: "",
    э: "e",
    ю: "yu",
    я: "ya",
  };
  let s = name.trim().toLowerCase();
  s = [...s].map((ch) => map[ch] ?? ch).join("");
  s = s.replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 48);
  return s || "supplier";
}

function parseEmails(raw: unknown): string[] {
  const text = Array.isArray(raw)
    ? raw.join("\n")
    : typeof raw === "string"
      ? raw
      : "";
  const found = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  return [...new Set(found.map((e) => e.trim().toLowerCase()))];
}

async function uniqueCode(base: string): Promise<string> {
  let code = base;
  let n = 2;
  for (;;) {
    const r = await pool.query(`SELECT 1 FROM partners WHERE code = $1`, [code]);
    if (!r.rows[0]) return code;
    code = `${base}_${n}`;
    n += 1;
  }
}

const partnerSelect = `
  SELECT p.id, p.name, p.code, p.api_base_url, p.score, p.active, p.metadata,
         p.modes, p.created_at,
         s.id AS supplier_id,
         s.active AS supplier_active,
         s.left_market,
         s.silent,
         s.silent_at,
         s.silent_note,
         s.last_rfq_at,
         s.last_reply_at,
         COALESCE(s.no_reply_streak, 0) AS no_reply_streak,
         s.corridors AS supplier_corridors,
         s.modes AS supplier_modes,
         s.contacts AS supplier_contacts,
         s.performance,
         COALESCE(
           (SELECT json_agg(pc.email ORDER BY pc.email)
            FROM partner_contacts pc
            WHERE pc.partner_id = p.id),
           '[]'::json
         ) AS emails,
         CASE
           WHEN COALESCE(s.left_market, FALSE) THEN 'left'
           WHEN COALESCE(s.silent, FALSE) THEN 'silent'
           WHEN p.active = FALSE OR COALESCE(s.active, TRUE) = FALSE THEN 'paused'
           ELSE 'active'
         END AS status
  FROM partners p
  LEFT JOIN suppliers s ON s.partner_id = p.id
`;

async function ensureSilentColumns(): Promise<void> {
  for (const ddl of [
    `ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS silent BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS silent_at TIMESTAMPTZ`,
    `ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS silent_note TEXT`,
    `ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS last_rfq_at TIMESTAMPTZ`,
    `ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS last_reply_at TIMESTAMPTZ`,
    `ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS no_reply_streak INT NOT NULL DEFAULT 0`,
  ]) {
    await pool.query(ddl);
  }
}

export function registerPartnerRoutes(app: FastifyInstance) {
  app.addHook("onReady", async () => {
    try {
      await ensureSilentColumns();
    } catch (err) {
      app.log.warn({ err }, "supplier_silent_columns_ensure_failed");
    }
  });

  app.get("/partners", async (req, reply) => {
    if (!requireDirector(req, reply)) return;
    const q = z
      .object({
        status: z
          .enum(["active", "silent", "left", "paused", "all"])
          .optional()
          .default("active"),
        q: z.string().optional(),
      })
      .parse(req.query);

    const params: unknown[] = [];
    const where: string[] = [];

    if (q.status === "active") {
      where.push(
        `p.active = TRUE AND COALESCE(s.active, TRUE) = TRUE AND COALESCE(s.left_market, FALSE) = FALSE AND COALESCE(s.silent, FALSE) = FALSE`
      );
    } else if (q.status === "silent") {
      where.push(`COALESCE(s.silent, FALSE) = TRUE AND COALESCE(s.left_market, FALSE) = FALSE`);
    } else if (q.status === "left") {
      where.push(`COALESCE(s.left_market, FALSE) = TRUE`);
    } else if (q.status === "paused") {
      where.push(
        `(p.active = FALSE OR COALESCE(s.active, TRUE) = FALSE) AND COALESCE(s.left_market, FALSE) = FALSE AND COALESCE(s.silent, FALSE) = FALSE`
      );
    }

    if (q.q?.trim()) {
      params.push(`%${q.q.trim()}%`);
      where.push(
        `(p.name ILIKE $${params.length} OR p.code ILIKE $${params.length} OR EXISTS (
           SELECT 1 FROM partner_contacts pc WHERE pc.partner_id = p.id AND pc.email ILIKE $${params.length}
         ))`
      );
    }

    const sql = `${partnerSelect}
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY
        CASE WHEN COALESCE(s.silent, FALSE) THEN 0 ELSE 1 END,
        p.score DESC,
        p.name ASC`;

    const r = await pool.query(sql, params);
    const counts = await pool.query(`
      SELECT
        COUNT(*) FILTER (
          WHERE p.active AND COALESCE(s.active, TRUE) AND NOT COALESCE(s.left_market, FALSE) AND NOT COALESCE(s.silent, FALSE)
        )::int AS active,
        COUNT(*) FILTER (
          WHERE COALESCE(s.silent, FALSE) AND NOT COALESCE(s.left_market, FALSE)
        )::int AS silent,
        COUNT(*) FILTER (WHERE COALESCE(s.left_market, FALSE))::int AS left,
        COUNT(*) FILTER (
          WHERE (NOT p.active OR NOT COALESCE(s.active, TRUE))
            AND NOT COALESCE(s.left_market, FALSE)
            AND NOT COALESCE(s.silent, FALSE)
        )::int AS paused,
        COUNT(*)::int AS total
      FROM partners p
      LEFT JOIN suppliers s ON s.partner_id = p.id
    `);

    return {
      items: r.rows,
      counts: {
        active: counts.rows[0]?.active ?? 0,
        silent: counts.rows[0]?.silent ?? 0,
        left: counts.rows[0]?.left ?? 0,
        paused: counts.rows[0]?.paused ?? 0,
        all: counts.rows[0]?.total ?? 0,
      },
    };
  });

  app.post("/partners", async (req, reply) => {
    if (!requireDirector(req, reply)) return;
    const body = z
      .object({
        name: z.string().min(2).max(200),
        emails: z.union([z.string(), z.array(z.string())]).optional(),
        modes: z.array(z.enum(MODES)).optional().default([]),
        corridors: z.array(z.enum(CORRIDORS)).optional().default(["international"]),
        phones: z.array(z.string()).optional().default([]),
        notes: z.string().max(2000).optional(),
        code: z.string().max(64).optional(),
      })
      .parse(req.body);

    const emails = parseEmails(body.emails);
    if (!emails.length) {
      return reply.code(400).send({
        error: "email_required",
        message: "Укажите хотя бы один email для RFQ",
      });
    }

    const base = slugify(body.code || body.name);
    const code = await uniqueCode(base);
    const meta = {
      source: "cabinet",
      notes: body.notes ? [body.notes] : [],
      phones: body.phones,
      created_by: req.staff?.email || null,
    };

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const partner = await client.query(
        `INSERT INTO partners (name, code, modes, score, active, metadata)
         VALUES ($1, $2, $3, 0.55, TRUE, $4::jsonb)
         RETURNING id, name, code`,
        [body.name.trim(), code, body.modes, JSON.stringify(meta)]
      );
      const partnerId = partner.rows[0].id as string;

      await client.query(
        `INSERT INTO suppliers (
           partner_id, name, code, modes, corridors, contacts,
           verification, active, left_market, silent, metadata
         ) VALUES (
           $1, $2, $3, $4, $5, $6::jsonb,
           '{"source":"cabinet","verified":true}'::jsonb,
           TRUE, FALSE, FALSE, $7::jsonb
         )`,
        [
          partnerId,
          body.name.trim(),
          code,
          body.modes,
          body.corridors,
          JSON.stringify({
            phones: body.phones,
            emails,
            people: [],
          }),
          JSON.stringify(meta),
        ]
      );

      for (const email of emails) {
        const domain = email.split("@")[1] || null;
        await client.query(
          `INSERT INTO partner_contacts (
             partner_id, email, domain, verified, first_email_approved, source_url
           ) VALUES ($1, $2, $3, TRUE, TRUE, 'cabinet')
           ON CONFLICT (email) DO UPDATE SET
             partner_id = EXCLUDED.partner_id,
             verified = TRUE,
             first_email_approved = TRUE`,
          [partnerId, email, domain]
        );
      }

      await client.query("COMMIT");
      const full = await pool.query(`${partnerSelect} WHERE p.id = $1`, [partnerId]);
      return reply.code(201).send(full.rows[0]);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });

  app.patch<{ Params: { id: string } }>("/partners/:id", async (req, reply) => {
    if (!requireDirector(req, reply)) return;
    const body = z
      .object({
        name: z.string().min(2).max(200).optional(),
        emails: z.union([z.string(), z.array(z.string())]).optional(),
        modes: z.array(z.enum(MODES)).optional(),
        corridors: z.array(z.enum(CORRIDORS)).optional(),
        notes: z.string().max(2000).optional(),
      })
      .parse(req.body);

    const existing = await pool.query(`SELECT id, name FROM partners WHERE id = $1`, [
      req.params.id,
    ]);
    if (!existing.rows[0]) return reply.code(404).send({ error: "not_found" });

    if (body.name) {
      await pool.query(
        `UPDATE partners SET name = $1 WHERE id = $2`,
        [body.name.trim(), req.params.id]
      );
      await pool.query(
        `UPDATE suppliers SET name = $1, updated_at = NOW() WHERE partner_id = $2`,
        [body.name.trim(), req.params.id]
      );
    }
    if (body.modes) {
      await pool.query(`UPDATE partners SET modes = $1 WHERE id = $2`, [
        body.modes,
        req.params.id,
      ]);
      await pool.query(
        `UPDATE suppliers SET modes = $1, updated_at = NOW() WHERE partner_id = $2`,
        [body.modes, req.params.id]
      );
    }
    if (body.corridors) {
      await pool.query(
        `UPDATE suppliers SET corridors = $1, updated_at = NOW() WHERE partner_id = $2`,
        [body.corridors, req.params.id]
      );
    }
    if (body.notes !== undefined) {
      await pool.query(
        `UPDATE partners SET metadata = metadata || $1::jsonb WHERE id = $2`,
        [JSON.stringify({ notes: body.notes ? [body.notes] : [] }), req.params.id]
      );
    }
    if (body.emails !== undefined) {
      const emails = parseEmails(body.emails);
      for (const email of emails) {
        const domain = email.split("@")[1] || null;
        await pool.query(
          `INSERT INTO partner_contacts (
             partner_id, email, domain, verified, first_email_approved, source_url
           ) VALUES ($1, $2, $3, TRUE, TRUE, 'cabinet')
           ON CONFLICT (email) DO UPDATE SET
             partner_id = EXCLUDED.partner_id,
             verified = TRUE,
             first_email_approved = TRUE`,
          [req.params.id, email, domain]
        );
      }
    }

    const full = await pool.query(`${partnerSelect} WHERE p.id = $1`, [req.params.id]);
    return full.rows[0];
  });

  /** Не отвечает на RFQ — исключаем из рассылки, но оставляем в базе */
  app.post<{ Params: { id: string } }>(
    "/partners/:id/silent",
    async (req, reply) => {
      if (!requireDirector(req, reply)) return;
      const body = z
        .object({ note: z.string().max(500).optional() })
        .parse(req.body ?? {});
      const r = await pool.query(
        `UPDATE suppliers SET
           silent = TRUE,
           silent_at = NOW(),
           silent_note = COALESCE($2, silent_note),
           updated_at = NOW()
         WHERE partner_id = $1
         RETURNING id`,
        [req.params.id, body.note || null]
      );
      if (!r.rows[0]) {
        // create supplier row if only partner exists
        const p = await pool.query(`SELECT id, name, code, modes FROM partners WHERE id = $1`, [
          req.params.id,
        ]);
        if (!p.rows[0]) return reply.code(404).send({ error: "not_found" });
        await pool.query(
          `INSERT INTO suppliers (
             partner_id, name, code, modes, silent, silent_at, silent_note, active
           ) VALUES ($1, $2, $3, $4, TRUE, NOW(), $5, TRUE)`,
          [
            p.rows[0].id,
            p.rows[0].name,
            p.rows[0].code,
            p.rows[0].modes || [],
            body.note || null,
          ]
        );
      }
      const full = await pool.query(`${partnerSelect} WHERE p.id = $1`, [req.params.id]);
      return full.rows[0];
    }
  );

  /** Вернуть в RFQ (сняли «не отвечает» / ушёл с рынка / паузу) */
  app.post<{ Params: { id: string } }>(
    "/partners/:id/reactivate",
    async (req, reply) => {
      if (!requireDirector(req, reply)) return;
      await pool.query(`UPDATE partners SET active = TRUE WHERE id = $1`, [
        req.params.id,
      ]);
      const r = await pool.query(
        `UPDATE suppliers SET
           active = TRUE,
           left_market = FALSE,
           silent = FALSE,
           silent_at = NULL,
           silent_note = NULL,
           updated_at = NOW()
         WHERE partner_id = $1
         RETURNING id`,
        [req.params.id]
      );
      if (!r.rows[0]) {
        const p = await pool.query(`SELECT 1 FROM partners WHERE id = $1`, [
          req.params.id,
        ]);
        if (!p.rows[0]) return reply.code(404).send({ error: "not_found" });
      }
      const full = await pool.query(`${partnerSelect} WHERE p.id = $1`, [req.params.id]);
      return full.rows[0];
    }
  );

  /** Ушёл с рынка — не слать RFQ */
  app.post<{ Params: { id: string } }>(
    "/partners/:id/left-market",
    async (req, reply) => {
      if (!requireDirector(req, reply)) return;
      const body = z
        .object({ note: z.string().max(500).optional() })
        .parse(req.body ?? {});
      const r = await pool.query(
        `UPDATE suppliers SET
           left_market = TRUE,
           silent = FALSE,
           silent_note = COALESCE($2, silent_note),
           updated_at = NOW()
         WHERE partner_id = $1
         RETURNING id`,
        [req.params.id, body.note || null]
      );
      if (!r.rows[0]) return reply.code(404).send({ error: "not_found" });
      const full = await pool.query(`${partnerSelect} WHERE p.id = $1`, [req.params.id]);
      return full.rows[0];
    }
  );

  /** Пауза без удаления */
  app.post<{ Params: { id: string } }>(
    "/partners/:id/pause",
    async (req, reply) => {
      if (!requireDirector(req, reply)) return;
      await pool.query(`UPDATE partners SET active = FALSE WHERE id = $1`, [
        req.params.id,
      ]);
      await pool.query(
        `UPDATE suppliers SET active = FALSE, updated_at = NOW() WHERE partner_id = $1`,
        [req.params.id]
      );
      const full = await pool.query(`${partnerSelect} WHERE p.id = $1`, [req.params.id]);
      if (!full.rows[0]) return reply.code(404).send({ error: "not_found" });
      return full.rows[0];
    }
  );
}
