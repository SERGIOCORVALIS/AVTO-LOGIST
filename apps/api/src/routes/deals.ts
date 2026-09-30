import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db";
import { logStaffEvent } from "../staffEvents";
import { enqueueOutboundTg } from "../queues";

const createDealSchema = z.object({
  tg_chat_id: z.number().optional(),
  tg_user_id: z.number().optional(),
  client_name: z.string().optional(),
  cargo: z.record(z.unknown()).optional(),
  route: z.record(z.unknown()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

function dealSearchVariants(q: string): string[] {
  const out = new Set<string>([q]);
  const pairs: Array<[RegExp, string]> = [
    [/александра/i, "Aleksandra"],
    [/aleksandra|alexandra/i, "Александра"],
    [/александр(?!а)/i, "Aleksandr"],
    [/aleksandr(?!a)|alexander/i, "Александр"],
  ];
  for (const [re, repl] of pairs) {
    if (re.test(q)) out.add(q.replace(re, repl));
  }
  return [...out].filter(Boolean);
}

export function registerDealRoutes(app: FastifyInstance) {
  app.get("/deals", async (req) => {
    const q = req.query as { status?: string; limit?: string; q?: string; search?: string };
    const limit = Math.min(Number(q.limit || 50), 200);
    const search = String(q.q || q.search || "").trim();
    if (search) {
      const variants = dealSearchVariants(search);
      const likes = variants.map((v) => `%${v}%`);
      // Expand OR across transliteration variants + consignee / org labels.
      const clauses: string[] = [];
      const params: unknown[] = [];
      for (const like of likes) {
        params.push(like);
        const i = params.length;
        clauses.push(`(
          client_name ILIKE $${i}
          OR cargo->>'name' ILIKE $${i}
          OR route->>'origin_city' ILIKE $${i}
          OR route->>'destination_city' ILIKE $${i}
          OR metadata->>'consignee' ILIKE $${i}
          OR metadata->>'client_org' ILIKE $${i}
          OR metadata->>'shipment_label' ILIKE $${i}
          OR id::text ILIKE $${i}
        )`);
      }
      params.push(limit);
      const r = await pool.query(
        `SELECT * FROM deals
         WHERE ${clauses.join(" OR ")}
         ORDER BY updated_at DESC LIMIT $${params.length}`,
        params
      );
      return r.rows;
    }
    if (q.status) {
      const r = await pool.query(
        `SELECT * FROM deals WHERE status = $1 ORDER BY updated_at DESC LIMIT $2`,
        [q.status, limit]
      );
      return r.rows;
    }
    const r = await pool.query(
      `SELECT * FROM deals ORDER BY updated_at DESC LIMIT $1`,
      [limit]
    );
    return r.rows;
  });

  app.get("/deals/open/telegram", async () => {
    const r = await pool.query(
      `SELECT
         d.id,
         d.tg_chat_id,
         d.client_name,
         d.status,
         d.paused,
         d.takeover,
         lm.direction AS last_direction,
         lm.tg_message_id AS last_tg_message_id,
         lm.created_at AS last_message_at,
         CASE WHEN lm.direction = 'inbound' THEN lm.text ELSE NULL END AS last_inbound_text,
         CASE
           WHEN lm.direction = 'inbound'
             AND NOT EXISTS (
               SELECT 1 FROM messages o
               WHERE o.deal_id = d.id
                 AND o.direction = 'outbound'
                 AND o.created_at > lm.created_at
             )
           THEN TRUE
           ELSE FALSE
         END AS needs_reply
       FROM deals d
       LEFT JOIN LATERAL (
         SELECT direction, tg_message_id, text, created_at
         FROM messages
         WHERE deal_id = d.id
         ORDER BY created_at DESC
         LIMIT 1
       ) lm ON TRUE
       WHERE d.channel = 'telegram'
         AND d.tg_chat_id IS NOT NULL
         AND d.status NOT IN ('closed_won','closed_lost','cancelled')
       ORDER BY d.updated_at DESC
       LIMIT 200`
    );
    return r.rows;
  });

  app.get("/messages/telegram/exists", async (req) => {
    const q = req.query as { chat_id?: string; tg_message_id?: string };
    const chatId = Number(q.chat_id);
    const msgId = Number(q.tg_message_id);
    if (!Number.isFinite(chatId) || !Number.isFinite(msgId)) {
      return { exists: false };
    }
    const r = await pool.query(
      `SELECT 1
       FROM messages m
       JOIN deals d ON d.id = m.deal_id
       WHERE d.tg_chat_id = $1
         AND m.tg_message_id = $2
         AND m.direction = 'inbound'
       LIMIT 1`,
      [chatId, msgId]
    );
    return { exists: r.rows.length > 0 };
  });

  app.get<{ Params: { id: string } }>("/deals/:id", async (req, reply) => {
    const r = await pool.query(`SELECT * FROM deals WHERE id = $1`, [
      req.params.id,
    ]);
    if (!r.rows[0]) return reply.code(404).send({ error: "not_found" });
    return r.rows[0];
  });

  app.get<{ Params: { chatId: string } }>(
    "/deals/by-chat/:chatId",
    async (req, reply) => {
      const r = await pool.query(
        `SELECT * FROM deals WHERE tg_chat_id = $1 AND status NOT IN ('closed_won','closed_lost','cancelled')
         ORDER BY updated_at DESC LIMIT 1`,
        [Number(req.params.chatId)]
      );
      if (!r.rows[0]) return reply.code(404).send({ error: "not_found" });
      return r.rows[0];
    }
  );

  app.post("/deals", async (req, reply) => {
    const body = createDealSchema.parse(req.body);
    const r = await pool.query(
      `INSERT INTO deals (tg_chat_id, tg_user_id, client_name, cargo, route, metadata)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [
        body.tg_chat_id ?? null,
        body.tg_user_id ?? null,
        body.client_name ?? null,
        JSON.stringify(body.cargo ?? {}),
        JSON.stringify(body.route ?? {}),
        JSON.stringify(body.metadata ?? {}),
      ]
    );
    return reply.code(201).send(r.rows[0]);
  });

  app.patch<{ Params: { id: string } }>("/deals/:id", async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    const allowed = [
      "status",
      "previous_status",
      "cargo",
      "route",
      "dims_source",
      "hs_codes",
      "cost_breakdown",
      "offer",
      "margin_pct",
      "amount_rub",
      "risks",
      "next_actions",
      "takeover",
      "paused",
      "escalate",
      "playbook_version",
      "confidence",
      "metadata",
      "client_name",
    ];
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    for (const key of allowed) {
      if (body[key] === undefined) continue;
      const jsonKeys = [
        "cargo",
        "route",
        "hs_codes",
        "cost_breakdown",
        "offer",
        "risks",
        "next_actions",
        "metadata",
      ];
      sets.push(`${key} = $${i}`);
      vals.push(
        jsonKeys.includes(key) ? JSON.stringify(body[key]) : body[key]
      );
      i++;
    }
    if (!sets.length) return reply.code(400).send({ error: "empty_patch" });
    sets.push(`updated_at = NOW()`);
    vals.push(req.params.id);
    const r = await pool.query(
      `UPDATE deals SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
      vals
    );
    if (!r.rows[0]) return reply.code(404).send({ error: "not_found" });
    if (req.staff?.id) {
      const bits: string[] = [];
      if (body.paused === true) bits.push("пауза AI");
      if (body.paused === false) bits.push("снял паузу");
      if (body.takeover === true) bits.push("takeover");
      if (body.takeover === false) bits.push("вернул робота");
      if (typeof body.status === "string") bits.push(`статус → ${body.status}`);
      await logStaffEvent({
        req,
        actor: req.staff,
        action: "deal_patch",
        summary: `${req.staff.name || req.staff.email} изменил сделку ${req.params.id.slice(0, 8)}${
          bits.length ? ": " + bits.join(", ") : ""
        }`,
        target_id: req.params.id,
        meta: { keys: Object.keys(body) },
      });
    }
    return r.rows[0];
  });

  /** Release held KP to client (pilot) or advance to contract if already priced. */
  app.post<{ Params: { id: string } }>("/deals/:id/approve-kp", async (req, reply) => {
    const r = await pool.query(`SELECT * FROM deals WHERE id = $1`, [req.params.id]);
    const deal = r.rows[0] as
      | {
          id: string;
          tg_chat_id?: number | null;
          status?: string;
          metadata?: Record<string, unknown> | null;
          offer?: { price?: number } | null;
        }
      | undefined;
    if (!deal) return reply.code(404).send({ error: "not_found" });

    const meta = (deal.metadata || {}) as Record<string, unknown>;
    const pending = Array.isArray(meta.pending_kp_messages)
      ? (meta.pending_kp_messages as string[])
      : [];
    const held = Boolean(meta.kp_hold) || deal.status === "awaiting_manager";

    const nextMeta = {
      ...meta,
      kp_hold: false,
      pending_kp_messages: [],
      kp_approved_at: new Date().toISOString(),
    };

    if (held && (pending.length || deal.offer?.price)) {
      const upd = await pool.query(
        `UPDATE deals SET
           status = 'pricing',
           escalate = FALSE,
           paused = FALSE,
           metadata = $2::jsonb,
           updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [deal.id, JSON.stringify(nextMeta)]
      );
      const chatId = Number(deal.tg_chat_id || 0);
      let sent = 0;
      if (chatId && pending.length) {
        for (let i = 0; i < pending.length; i++) {
          try {
            await enqueueOutboundTg(chatId, pending[i], deal.id, i);
            sent += 1;
          } catch {
            /* jobId collision ok */
          }
        }
      }
      if (req.staff?.id) {
        await logStaffEvent({
          req,
          actor: req.staff,
          action: "approve_kp",
          summary: `${req.staff.name || req.staff.email} утвердил КП ${deal.id.slice(0, 8)} → клиенту`,
          target_id: deal.id,
          meta: { sent },
        });
      }
      return { ok: true, mode: "release_to_client", sent, deal: upd.rows[0] };
    }

    const upd = await pool.query(
      `UPDATE deals SET
         status = 'contract',
         escalate = FALSE,
         paused = FALSE,
         metadata = $2::jsonb,
         updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [deal.id, JSON.stringify(nextMeta)]
    );
    if (req.staff?.id) {
      await logStaffEvent({
        req,
        actor: req.staff,
        action: "approve_kp",
        summary: `${req.staff.name || req.staff.email} утвердил КП ${deal.id.slice(0, 8)} → договор`,
        target_id: deal.id,
      });
    }
    return { ok: true, mode: "to_contract", deal: upd.rows[0] };
  });

  app.post<{ Params: { id: string } }>(
    "/deals/:id/messages",
    async (req, reply) => {
      const body = z
        .object({
          tg_chat_id: z.number().optional(),
          tg_message_id: z.number().optional(),
          direction: z.enum(["inbound", "outbound", "system"]),
          sender: z.string(),
          text: z.string(),
          raw: z.record(z.unknown()).optional(),
        })
        .parse(req.body);
      const r = await pool.query(
        `INSERT INTO messages (deal_id, tg_chat_id, tg_message_id, direction, sender, text, raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [
          req.params.id,
          body.tg_chat_id ?? 0,
          body.tg_message_id ?? null,
          body.direction,
          body.sender,
          body.text,
          JSON.stringify(body.raw ?? {}),
        ]
      );
      return reply.code(201).send(r.rows[0]);
    }
  );

  app.get<{ Params: { id: string } }>(
    "/deals/:id/messages",
    async (req) => {
      const r = await pool.query(
        `SELECT * FROM messages WHERE deal_id = $1 ORDER BY created_at ASC`,
        [req.params.id]
      );
      return r.rows;
    }
  );
}
