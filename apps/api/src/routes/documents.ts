import type { FastifyInstance } from "fastify";
import { pool } from "../db";
import {
  DOCUMENT_FOLDERS,
  listDealAttachments,
  normalizeFolder,
  type DocumentFolder,
} from "../folders";
import { buildContractPdf, buildKpPdf } from "../kpPdf";

interface ArchiveItem {
  id: string;
  deal_id: string;
  client_name: string | null;
  folder: DocumentFolder;
  kind: string;
  filename: string;
  source: "attachment" | "quote" | "contract";
  content_type?: string;
  bytes?: number;
  created_at?: string;
  extra?: Record<string, unknown>;
}

export function registerDocumentRoutes(app: FastifyInstance) {
  app.get("/documents", async (req) => {
    const q = req.query as { folder?: string; deal_id?: string };
    const folderFilter = q.folder ? normalizeFolder(q.folder) : null;
    const dealFilter = q.deal_id || null;

    const deals = await pool.query(
      dealFilter
        ? `SELECT id, client_name, metadata, offer, amount_rub, created_at
           FROM deals WHERE id = $1`
        : `SELECT id, client_name, metadata, offer, amount_rub, created_at
           FROM deals ORDER BY updated_at DESC LIMIT 300`,
      dealFilter ? [dealFilter] : []
    );

    const items: ArchiveItem[] = [];

    for (const deal of deals.rows) {
      for (const att of listDealAttachments(deal.metadata, deal.id)) {
        items.push({
          id: String(att.id),
          deal_id: deal.id,
          client_name: deal.client_name,
          folder: (att.folder as DocumentFolder) || "other",
          kind: att.kind || "document",
          filename: att.filename || "файл",
          source: "attachment",
          content_type: att.content_type,
          bytes: att.bytes,
          created_at: att.created_at || deal.created_at,
        });
      }
    }

    const quotes = await pool.query(
      dealFilter
        ? `SELECT q.*, d.client_name FROM quotes q
           JOIN deals d ON d.id = q.deal_id WHERE q.deal_id = $1
           ORDER BY q.created_at DESC`
        : `SELECT q.*, d.client_name FROM quotes q
           JOIN deals d ON d.id = q.deal_id
           ORDER BY q.created_at DESC LIMIT 200`,
      dealFilter ? [dealFilter] : []
    );
    for (const row of quotes.rows) {
      items.push({
        id: row.id,
        deal_id: row.deal_id,
        client_name: row.client_name,
        folder: "kp",
        kind: "quote",
        filename: `КП ${row.route_summary || ""} ${row.price} ${row.currency}.json`.trim(),
        source: "quote",
        created_at: row.created_at,
        extra: {
          price: row.price,
          currency: row.currency,
          source: row.source,
          eta_days_min: row.eta_days_min,
          eta_days_max: row.eta_days_max,
        },
      });
    }

    const contracts = await pool.query(
      dealFilter
        ? `SELECT c.*, d.client_name FROM contracts c
           JOIN deals d ON d.id = c.deal_id WHERE c.deal_id = $1
           ORDER BY c.created_at DESC`
        : `SELECT c.*, d.client_name FROM contracts c
           JOIN deals d ON d.id = c.deal_id
           ORDER BY c.created_at DESC LIMIT 200`,
      dealFilter ? [dealFilter] : []
    );
    for (const row of contracts.rows) {
      items.push({
        id: row.id,
        deal_id: row.deal_id,
        client_name: row.client_name,
        folder: "contracts",
        kind: "contract",
        filename: `Договор ${row.id.slice(0, 8)}.md`,
        source: "contract",
        created_at: row.created_at,
        extra: {
          approved: row.approved,
          must_approve: row.must_approve,
          sent_to_client: row.sent_to_client,
        },
      });
    }

    const filtered = folderFilter
      ? items.filter((i) => i.folder === folderFilter)
      : items;

    filtered.sort((a, b) =>
      String(b.created_at || "").localeCompare(String(a.created_at || ""))
    );

    const counts: Record<string, number> = {};
    for (const f of DOCUMENT_FOLDERS) counts[f] = 0;
    for (const i of items) counts[i.folder] = (counts[i.folder] || 0) + 1;

    return {
      folders: DOCUMENT_FOLDERS,
      counts,
      items: filtered,
    };
  });

  app.get<{ Params: { id: string } }>(
    "/deals/:id/contract.pdf",
    async (req, reply) => {
      const q = req.query as { contract_id?: string };
      const contractId = q.contract_id;
      const deal = await pool.query(
        `SELECT id, client_name FROM deals WHERE id = $1`,
        [req.params.id]
      );
      const row = deal.rows[0];
      if (!row) return reply.code(404).send({ error: "not_found" });

      const contract = contractId
        ? await pool.query(
            `SELECT id, draft_md FROM contracts WHERE id = $1 AND deal_id = $2`,
            [contractId, req.params.id]
          )
        : await pool.query(
            `SELECT id, draft_md FROM contracts WHERE deal_id = $1 ORDER BY created_at DESC LIMIT 1`,
            [req.params.id]
          );
      const c = contract.rows[0];
      if (!c) return reply.code(404).send({ error: "contract_not_found" });

      const pdf = buildContractPdf({
        dealId: row.id,
        clientName: row.client_name,
        draftMd: String(c.draft_md || ""),
      });
      return reply
        .header("Content-Type", "application/pdf")
        .header(
          "Content-Disposition",
          `attachment; filename="contract-${String(c.id).slice(0, 8)}.pdf"`
        )
        .send(pdf);
    }
  );

  app.get<{ Params: { id: string } }>("/deals/:id/kp.pdf", async (req, reply) => {
    const deal = await pool.query(
      `SELECT id, client_name, route, amount_rub, margin_pct FROM deals WHERE id = $1`,
      [req.params.id]
    );
    const row = deal.rows[0];
    if (!row) return reply.code(404).send({ error: "not_found" });
    const route = (row.route || {}) as {
      origin_city?: string;
      destination_city?: string;
    };
    const pdf = buildKpPdf({
      dealId: row.id,
      clientName: row.client_name,
      origin: route.origin_city,
      destination: route.destination_city,
      amountRub: row.amount_rub,
      marginPct: row.margin_pct,
    });
    return reply
      .header("Content-Type", "application/pdf")
      .header(
        "Content-Disposition",
        `attachment; filename="kp-${String(row.id).slice(0, 8)}.pdf"`
      )
      .send(pdf);
  });

  app.get<{ Params: { id: string } }>("/deals/:id/quotes", async (req, reply) => {
    const deal = await pool.query(`SELECT id FROM deals WHERE id = $1`, [
      req.params.id,
    ]);
    if (!deal.rows[0]) return reply.code(404).send({ error: "not_found" });
    const r = await pool.query(
      `SELECT * FROM quotes WHERE deal_id = $1 ORDER BY created_at DESC`,
      [req.params.id]
    );
    return r.rows;
  });

  app.get<{ Params: { id: string } }>(
    "/deals/:id/contracts",
    async (req, reply) => {
      const deal = await pool.query(`SELECT id FROM deals WHERE id = $1`, [
        req.params.id,
      ]);
      if (!deal.rows[0]) return reply.code(404).send({ error: "not_found" });
      const r = await pool.query(
        `SELECT * FROM contracts WHERE deal_id = $1 ORDER BY created_at DESC`,
        [req.params.id]
      );
      return r.rows;
    }
  );

  app.get<{ Params: { id: string; cid: string } }>(
    "/deals/:id/contracts/:cid",
    async (req, reply) => {
      const r = await pool.query(
        `SELECT * FROM contracts WHERE id = $1 AND deal_id = $2`,
        [req.params.cid, req.params.id]
      );
      if (!r.rows[0]) return reply.code(404).send({ error: "not_found" });
      return r.rows[0];
    }
  );
}
