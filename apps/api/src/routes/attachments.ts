import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db";
import { storeAttachment, loadAttachmentBytes } from "../storage";
import { enqueueOcrJob } from "../queues";
import { randomUUID } from "crypto";
import {
  DOCUMENT_FOLDERS,
  folderFromKind,
  listDealAttachments,
  normalizeFolder,
  withFolder,
} from "../folders";

export function registerAttachmentRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>(
    "/deals/:id/attachments",
    async (req, reply) => {
      const deal = await pool.query(
        `SELECT id, metadata FROM deals WHERE id = $1`,
        [req.params.id]
      );
      if (!deal.rows[0]) return reply.code(404).send({ error: "not_found" });
      const folder = (req.query as { folder?: string }).folder;
      let items = listDealAttachments(deal.rows[0].metadata, req.params.id);
      if (folder) {
        const f = normalizeFolder(folder);
        items = items.filter((a) => a.folder === f);
      }
      return { folders: DOCUMENT_FOLDERS, items };
    }
  );

  app.post<{ Params: { id: string } }>(
    "/deals/:id/attachments",
    async (req, reply) => {
      const body = z
        .object({
          filename: z.string(),
          content_base64: z.string(),
          content_type: z.string().optional(),
          kind: z.string().optional(),
          folder: z.enum(DOCUMENT_FOLDERS).optional(),
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

      const folder = body.folder || folderFromKind(body.kind, body.filename);

      const meta = withFolder(
        {
          id,
          deal_id: req.params.id,
          filename: body.filename,
          content_type: body.content_type || "application/octet-stream",
          kind: body.kind || body.folder || "document",
          folder,
          path: stored.path,
          key: stored.key,
          storage: stored.storage,
          bytes: stored.bytes,
          ocr_status: "queued",
          ocr_text: null,
          created_at: new Date().toISOString(),
        },
        req.params.id
      );

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

  app.patch<{ Params: { id: string; attId: string } }>(
    "/deals/:id/attachments/:attId",
    async (req, reply) => {
      const body = z
        .object({
          folder: z.enum(DOCUMENT_FOLDERS),
        })
        .parse(req.body);

      const deal = await pool.query(
        `SELECT id, metadata FROM deals WHERE id = $1`,
        [req.params.id]
      );
      if (!deal.rows[0]) return reply.code(404).send({ error: "not_found" });

      const items = listDealAttachments(deal.rows[0].metadata, req.params.id);
      const idx = items.findIndex((a) => a.id === req.params.attId);
      if (idx < 0) return reply.code(404).send({ error: "not_found" });
      items[idx] = { ...items[idx], folder: body.folder, kind: body.folder };

      await pool.query(
        `UPDATE deals SET metadata = jsonb_set(
           COALESCE(metadata, '{}'::jsonb),
           '{attachments}',
           $1::jsonb
         ), updated_at = NOW() WHERE id = $2`,
        [JSON.stringify(items), req.params.id]
      );
      return items[idx];
    }
  );

  app.get<{ Params: { id: string; attId: string } }>(
    "/deals/:id/attachments/:attId/file",
    async (req, reply) => {
      const deal = await pool.query(
        `SELECT id, metadata FROM deals WHERE id = $1`,
        [req.params.id]
      );
      if (!deal.rows[0]) return reply.code(404).send({ error: "not_found" });
      const items = listDealAttachments(deal.rows[0].metadata, req.params.id);
      const att = items.find((a) => a.id === req.params.attId);
      if (!att) return reply.code(404).send({ error: "not_found" });
      try {
        const buf = await loadAttachmentBytes({
          path: att.path,
          key: att.key,
          storage: att.storage,
        });
        const filename = att.filename || "document";
        return reply
          .header(
            "Content-Type",
            att.content_type || "application/octet-stream"
          )
          .header(
            "Content-Disposition",
            `attachment; filename="${encodeURIComponent(filename)}"`
          )
          .send(buf);
      } catch (err) {
        req.log.error({ err }, "attachment_download_failed");
        return reply.code(404).send({ error: "not_found" });
      }
    }
  );
}
