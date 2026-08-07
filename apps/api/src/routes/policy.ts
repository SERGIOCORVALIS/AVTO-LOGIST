import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db";
import { DEFAULT_POLICY } from "@alo/shared";

export function registerPolicyRoutes(app: FastifyInstance) {
  app.get("/policy", async () => {
    const r = await pool.query(`SELECT key, value FROM policy_config`);
    const policy: Record<string, unknown> = { ...DEFAULT_POLICY };
    for (const row of r.rows) {
      policy[row.key] = row.value;
    }
    return policy;
  });

  app.put("/policy", async (req) => {
    const body = z.record(z.unknown()).parse(req.body);
    for (const [key, value] of Object.entries(body)) {
      await pool.query(
        `INSERT INTO policy_config (key, value, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [key, JSON.stringify(value)]
      );
    }
    const r = await pool.query(`SELECT key, value FROM policy_config`);
    const policy: Record<string, unknown> = {};
    for (const row of r.rows) policy[row.key] = row.value;
    return policy;
  });
}
