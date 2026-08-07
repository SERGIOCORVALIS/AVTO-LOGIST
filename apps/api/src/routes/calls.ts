import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db";

export function registerCallRoutes(app: FastifyInstance) {
  app.get("/calls/deal/:dealId", async (req, reply) => {
    const { dealId } = req.params as { dealId: string };
    const active = await pool.query(
      `SELECT * FROM call_sessions
       WHERE deal_id = $1 AND status IN ('ringing', 'active')
       ORDER BY started_at DESC LIMIT 1`,
      [dealId]
    );
    const recent = await pool.query(
      `SELECT * FROM call_sessions
       WHERE deal_id = $1 ORDER BY started_at DESC LIMIT 5`,
      [dealId]
    );
    return reply.send({
      active: active.rows[0] ?? null,
      recent: recent.rows,
    });
  });

  app.get("/calls/:sessionId", async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    const r = await pool.query(`SELECT * FROM call_sessions WHERE id = $1`, [sessionId]);
    if (!r.rows[0]) return reply.code(404).send({ error: "not_found" });
    return reply.send(r.rows[0]);
  });

  app.post("/calls/:sessionId/end", async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    const body = z
      .object({
        status: z.enum(["completed", "transferred", "failed"]).default("completed"),
        recording_url: z.string().optional(),
      })
      .parse(req.body ?? {});
    const r = await pool.query(
      `UPDATE call_sessions
       SET status = $2, ended_at = NOW(), recording_url = COALESCE($3, recording_url)
       WHERE id = $1 RETURNING *`,
      [sessionId, body.status, body.recording_url ?? null]
    );
    if (!r.rows[0]) return reply.code(404).send({ error: "not_found" });
    return reply.send(r.rows[0]);
  });
}
