import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { QUEUES } from "@alo/shared";
import {
  enqueueEmailJob,
  enqueueOcrJob,
  enqueueCalendarSync,
  enqueueChannelJob,
} from "../queues";
import { loadAttachmentBytes } from "../storage";
import { pool } from "../db";

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
        name: z.enum([
          "request_quote",
          "find_and_request",
          "request_sourcing",
          "cabinet_rfq",
          "api_quote_fallback",
        ]),
        data: z.record(z.unknown()),
        job_id: z.string().optional(),
        delay_ms: z.number().int().nonnegative().optional(),
      })
      .parse(req.body);
    const job = await enqueueEmailJob(
      body.name,
      body.data as Record<string, unknown>,
      { jobId: body.job_id, delayMs: body.delay_ms }
    );
    return { ok: true, id: job.id, queue: QUEUES.email, name: body.name };
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
    return { ok: true, id: job.id, queue: QUEUES.ocr };
  });

  app.post("/internal/jobs/calendar", async () => {
    const job = await enqueueCalendarSync();
    return { ok: true, id: job.id, queue: QUEUES.sla, name: "sync_calendar" };
  });

  app.post("/internal/jobs/channel", async (req) => {
    const body = z
      .object({
        kind: z.enum(["alert", "info", "digest"]).default("alert"),
        text: z.string().min(1),
        deal_id: z.string().uuid().optional(),
        job_id: z.string().optional(),
        notify_director: z.boolean().optional(),
      })
      .parse(req.body);
    const job = await enqueueChannelJob({
      kind: body.kind,
      text: body.text,
      deal_id: body.deal_id,
      jobId: body.job_id,
      notify_director: body.notify_director,
    });
    return { ok: true, id: job.id, queue: QUEUES.channel, name: body.kind };
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

  app.post("/internal/learning", async (req) => {
    const body = z
      .object({
        deal_id: z.string().uuid().nullable().optional(),
        event_type: z.string().min(1),
        payload: z.record(z.unknown()).default({}),
      })
      .parse(req.body);
    await pool.query(
      `INSERT INTO learning_events (deal_id, event_type, payload)
       VALUES ($1, $2, $3::jsonb)`,
      [body.deal_id || null, body.event_type, JSON.stringify(body.payload)]
    );
    return { ok: true };
  });
}
