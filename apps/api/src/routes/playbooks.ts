import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db";

export function registerPlaybookRoutes(app: FastifyInstance) {
  app.get("/playbooks", async (req) => {
    const q = req.query as { status?: string };
    if (q.status) {
      const r = await pool.query(
        `SELECT * FROM playbook_versions WHERE status = $1 ORDER BY created_at DESC`,
        [q.status]
      );
      return r.rows;
    }
    const r = await pool.query(
      `SELECT * FROM playbook_versions ORDER BY created_at DESC LIMIT 50`
    );
    return r.rows;
  });

  app.post<{ Params: { id: string } }>(
    "/playbooks/:id/decide",
    async (req, reply) => {
      const body = z
        .object({
          decision: z.enum(["canary", "active", "rejected", "retired"]),
        })
        .parse(req.body);
      const r = await pool.query(
        `UPDATE playbook_versions SET status = $1 WHERE id = $2 RETURNING *`,
        [body.decision, req.params.id]
      );
      if (!r.rows[0]) return reply.code(404).send({ error: "not_found" });
      return r.rows[0];
    }
  );
}
