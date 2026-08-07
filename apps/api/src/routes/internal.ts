import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { enqueueEmailJob, enqueueOcrJob, enqueueCalendarSync } from "../queues";
import { loadAttachmentBytes } from "../storage";

function assertInternalAuth(req: FastifyRequest, reply: FastifyReply): boolean {
  const token = process.env.INTERNAL_API_TOKEN || "";
  if (!token) {
    // Dev: open. Prod: require token when ALO_ENV/NODE_ENV=production
    const prod =
      process.env.ALO_ENV === "production" ||
      process.env.NODE_ENV === "production";
    if (!prod) return true;
    reply.code(401).send({ error: "internal_token_required" });
    return false;
  }
  const got =
    (req.headers["x-internal-token"] as string | undefined) ||
    (typeof req.headers.authorization === "string" &&
    req.headers.authorization.startsWith("Bearer ")
      ? req.headers.authorization.slice(7)
      : "");
  if (got !== token) {
    reply.code(401).send({ error: "unauthorized" });
    return false;
  }
  return true;
}

export function registerInternalRoutes(app: FastifyInstance) {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.url.startsWith("/internal")) return;
    if (!assertInternalAuth(req, reply)) return;
  });

  app.post("/internal/jobs/email", async (req) => {
    const body = z
      .object({
        name: z.enum(["request_quote", "find_and_request"]),
        data: z.record(z.unknown()),
        job_id: z.string().optional(),
      })
      .parse(req.body);
    const job = await enqueueEmailJob(
      body.name,
      body.data as Record<string, unknown>,
      { jobId: body.job_id }
    );
    return { ok: true, id: job.id, queue: "alo:email", name: body.name };
  });

  app.post("/internal/jobs/ocr", async (req) => {
    const body = z
      .object({
        deal_id: z.string().uuid(),
        attachment_id: z.string(),
        path: z.string(),
        key: z.string().optional(),
        storage: z.string().optional(),
        content_type: z.string().optional(),
        filename: z.string().optional(),
      })
      .parse(req.body);
    const job = await enqueueOcrJob(body);
    return { ok: true, id: job.id, queue: "alo:ocr" };
  });

  app.post("/internal/jobs/calendar", async () => {
    const job = await enqueueCalendarSync();
    return { ok: true, id: job.id, queue: "alo:sla", name: "sync_calendar" };
  });

  app.post("/internal/attachments/bytes", async (req, reply) => {
    const body = z
      .object({
        path: z.string().optional(),
        key: z.string().optional(),
        storage: z.string().optional(),
      })
      .parse(req.body);
    try {
      const buf = await loadAttachmentBytes(body);
      return reply
        .header("Content-Type", "application/octet-stream")
        .send(buf);
    } catch (err) {
      return reply.code(404).send({
        error: "not_found",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
