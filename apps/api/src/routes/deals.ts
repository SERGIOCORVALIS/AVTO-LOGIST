import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db";

const createDealSchema = z.object({
  tg_chat_id: z.number().optional(),
  tg_user_id: z.number().optional(),
  client_name: z.string().optional(),
  cargo: z.record(z.unknown()).optional(),
  route: z.record(z.unknown()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export function registerDealRoutes(app: FastifyInstance) {
  app.get("/deals", async (req) => {
    const q = req.query as { status?: string; limit?: string };
    const limit = Math.min(Number(q.limit || 50), 200);
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
    return r.rows[0];
  });

  app.post<{ Params: { id: string } }>(
    "/deals/:id/messages",
    async (req, reply) => {
      const body = z
        .object({
          tg_chat_id: z.number(),
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
          body.tg_chat_id,
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
