import type { FastifyInstance } from "fastify";
import { z } from "zod";

export function registerOrchestratorProxy(app: FastifyInstance) {
  app.post("/orchestrator/process", async (req, reply) => {
    const body = z
      .object({
        deal_id: z.string().uuid().optional(),
        channel: z.enum(["telegram", "voice", "email"]).optional().default("telegram"),
        chat_id: z.number().optional(),
        external_id: z.string().optional(),
        call_session_id: z.string().uuid().optional(),
        user_id: z.number().optional(),
        text: z.string(),
        client_name: z.string().optional(),
        idempotency_key: z.string(),
        full_quote: z.boolean().optional(),
      })
      .parse(req.body);

    const base = process.env.ORCHESTRATOR_URL || "http://localhost:8000";
    try {
      const res = await fetch(`${base}/process`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      return reply.code(res.status).send(data);
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({
        error: "orchestrator_unavailable",
        fallback_replies: [
          "Принял запрос. Сейчас уточняю детали по маршруту и вернусь с расчётом в ближайшее время.",
        ],
      });
    }
  });
}
