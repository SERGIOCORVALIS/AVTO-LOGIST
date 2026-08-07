import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db";
import { randomUUID } from "crypto";
import { storeAttachment } from "../storage";
import { enqueueOcrJob } from "../queues";

export function registerAttachmentRoutes(app: FastifyInstance) {
  app.post<{ Params: { id: string } }>(
    "/deals/:id/attachments",
    async (req, reply) => {
      const body = z
        .object({
          filename: z.string(),
          content_base64: z.string(),
          content_type: z.string().optional(),
          kind: z.string().optional(),
        })
        .parse(req.body);

      const deal = await pool.query(`SELECT id FROM deals WHERE id = $1`, [
        req.params.id,
      ]);
      if (!deal.rows[0]) return reply.code(404).send({ error: "not_found" });

      const buf = Buffer.from(body.content_base64, "base64");
      const id = randomUUID();
      const stored = await storeAttachment(
        req.params.id,
        id,
        body.filename,
        buf,
        body.content_type
      );

      const meta = {
        id,
        deal_id: req.params.id,
        filename: body.filename,
        content_type: body.content_type || "application/octet-stream",
        kind: body.kind || "document",
        path: stored.path,
        key: stored.key,
        storage: stored.storage,
        bytes: stored.bytes,
        ocr_status: "queued",
        ocr_text: null as string | null,
      };

      await pool.query(
        `UPDATE deals SET metadata = jsonb_set(
           COALESCE(metadata, '{}'::jsonb),
           '{attachments}',
           COALESCE(metadata->'attachments', '[]'::jsonb) || $1::jsonb
         ), updated_at = NOW() WHERE id = $2`,
        [JSON.stringify(meta), req.params.id]
      );

      try {
        await enqueueOcrJob({
          deal_id: req.params.id,
          attachment_id: id,
          path: stored.path,
          key: stored.key,
          storage: stored.storage,
          content_type: meta.content_type,
          filename: body.filename,
        });
      } catch (err) {
        req.log.error({ err }, "ocr_enqueue_failed");
        meta.ocr_status = "enqueue_failed";
      }

      return reply.code(201).send(meta);
    }
  );
}
