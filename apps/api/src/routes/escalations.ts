import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db";

export function registerEscalationRoutes(app: FastifyInstance) {
  app.post<{ Params: { id: string } }>(
    "/deals/:id/escalate",
    async (req, reply) => {
      const body = z
        .object({
          reason: z.string(),
          summary: z.string(),
          numbers: z.record(z.unknown()).optional(),
          risks: z.array(z.unknown()).optional(),
          recommendation: z.string().optional(),
          needed_decision: z.string().optional(),
        })
        .parse(req.body);

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const deal = await client.query(`SELECT * FROM deals WHERE id = $1`, [
          req.params.id,
        ]);
        if (!deal.rows[0]) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: "not_found" });
        }
        await client.query(
          `UPDATE deals SET previous_status = status, status = 'awaiting_manager',
           escalate = TRUE, updated_at = NOW() WHERE id = $1`,
          [req.params.id]
        );
        const esc = await client.query(
          `INSERT INTO escalations
           (deal_id, reason, summary, numbers, risks, recommendation, needed_decision)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [
            req.params.id,
            body.reason,
            body.summary,
            JSON.stringify(body.numbers ?? {}),
            JSON.stringify(body.risks ?? []),
            body.recommendation ?? null,
            body.needed_decision ?? null,
          ]
        );
        await client.query("COMMIT");
        return reply.code(201).send(esc.rows[0]);
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    }
  );

  app.get("/escalations", async (req) => {
    const q = req.query as { status?: string };
    const status = q.status || "pending";
    const r = await pool.query(
      `SELECT e.*, d.client_name, d.tg_chat_id, d.amount_rub, d.margin_pct
       FROM escalations e JOIN deals d ON d.id = e.deal_id
       WHERE e.status = $1 ORDER BY e.created_at DESC LIMIT 50`,
      [status]
    );
    return r.rows;
  });

  app.post<{ Params: { id: string } }>(
    "/escalations/:id/decide",
    async (req, reply) => {
      const body = z
        .object({
          decision: z.enum(["approved", "rejected"]),
          manager_note: z.string().optional(),
          resume_status: z.string().optional(),
        })
        .parse(req.body);

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const esc = await client.query(
          `UPDATE escalations SET status = $1, manager_note = $2, resolved_at = NOW()
           WHERE id = $3 RETURNING *`,
          [body.decision, body.manager_note ?? null, req.params.id]
        );
        if (!esc.rows[0]) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: "not_found" });
        }
        const dealId = esc.rows[0].deal_id as string;
        const deal = await client.query(`SELECT * FROM deals WHERE id = $1`, [
          dealId,
        ]);
        const resume =
          body.resume_status ||
          deal.rows[0]?.previous_status ||
          "negotiation";
        if (body.decision === "approved") {
          await client.query(
            `UPDATE deals SET status = $1, escalate = FALSE, updated_at = NOW() WHERE id = $2`,
            [resume, dealId]
          );
        } else {
          await client.query(
            `UPDATE deals SET status = 'cancelled', escalate = FALSE, closed_at = NOW(), updated_at = NOW()
             WHERE id = $1`,
            [dealId]
          );
        }
        await client.query("COMMIT");
        return { escalation: esc.rows[0], decision: body.decision };
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    }
  );
}
