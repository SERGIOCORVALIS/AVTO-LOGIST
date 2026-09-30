/**
 * Export archive to Excel (6 sheets).
 * Usage: pnpm mail:archive-excel
 */
import { config } from "dotenv";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
config({ path: resolve(ROOT, ".env") });

const apiRequire = createRequire(resolve(ROOT, "apps/api/package.json"));
const workersRequire = createRequire(
  resolve(ROOT, "apps/workers-ts/package.json")
);
const { Pool } = apiRequire("pg") as typeof import("pg");

async function loadExcelJS(): Promise<typeof import("exceljs")> {
  try {
    return workersRequire("exceljs");
  } catch {
    try {
      return apiRequire("exceljs");
    } catch {
      const mod = await import("exceljs");
      return mod as unknown as typeof import("exceljs");
    }
  }
}

async function main() {
  const ExcelJS = await loadExcelJS();
  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ||
      "postgresql://alo:alo@localhost:5432/autologistics",
  });

  const wb = new ExcelJS.Workbook();
  wb.creator = "AVTO-logist archive";
  wb.created = new Date();

  const clients = await pool.query(`
    SELECT c.id, c.name, c.legal_name, c.primary_email, c.phone, c.inn, c.vip,
           (SELECT COUNT(*)::int FROM client_calc_requests r WHERE r.client_id=c.id) AS calc_count,
           (SELECT COUNT(*)::int FROM client_facts f WHERE f.client_id=c.id AND f.fact_type='invoice') AS invoices,
           (SELECT COUNT(*)::int FROM client_facts f WHERE f.client_id=c.id AND f.fact_type='contract') AS contracts,
           (SELECT COUNT(*)::int FROM deals d WHERE d.client_id=c.id) AS deal_count,
           c.personal_context->>'modes' AS modes
    FROM clients c
    ORDER BY c.updated_at DESC
  `);
  const shClients = wb.addWorksheet("Clients");
  shClients.columns = [
    { header: "id", key: "id", width: 38 },
    { header: "name", key: "name", width: 28 },
    { header: "legal_name", key: "legal_name", width: 28 },
    { header: "email", key: "primary_email", width: 32 },
    { header: "phone", key: "phone", width: 16 },
    { header: "inn", key: "inn", width: 14 },
    { header: "vip", key: "vip", width: 8 },
    { header: "calcs", key: "calc_count", width: 10 },
    { header: "invoices", key: "invoices", width: 10 },
    { header: "contracts", key: "contracts", width: 10 },
    { header: "deals", key: "deal_count", width: 10 },
    { header: "modes", key: "modes", width: 24 },
  ];
  for (const r of clients.rows) shClients.addRow(r);

  const calcs = await pool.query(`
    SELECT r.id, c.name AS client_name, c.primary_email, r.origin, r.destination,
           r.mode, r.requested_at, LEFT(r.cargo_desc, 200) AS cargo
    FROM client_calc_requests r
    JOIN clients c ON c.id = r.client_id
    ORDER BY r.requested_at DESC NULLS LAST
    LIMIT 20000
  `);
  const shCalc = wb.addWorksheet("CalcRequests");
  shCalc.columns = [
    { header: "id", key: "id", width: 38 },
    { header: "client", key: "client_name", width: 24 },
    { header: "email", key: "primary_email", width: 28 },
    { header: "origin", key: "origin", width: 18 },
    { header: "destination", key: "destination", width: 18 },
    { header: "mode", key: "mode", width: 14 },
    { header: "requested_at", key: "requested_at", width: 22 },
    { header: "cargo", key: "cargo", width: 40 },
  ];
  for (const r of calcs.rows) shCalc.addRow(r);

  const services = await pool.query(`
    SELECT name, category, primary_email, message_count, domains
    FROM service_providers
    ORDER BY message_count DESC
  `);
  const shSvc = wb.addWorksheet("ServiceProviders");
  shSvc.columns = [
    { header: "name", key: "name", width: 28 },
    { header: "category", key: "category", width: 14 },
    { header: "email", key: "primary_email", width: 32 },
    { header: "messages", key: "message_count", width: 12 },
    { header: "domains", key: "domains", width: 30 },
  ];
  for (const r of services.rows) {
    shSvc.addRow({
      ...r,
      domains: Array.isArray(r.domains) ? r.domains.join(", ") : r.domains,
    });
  }

  const mailboxes = await pool.query(`
    SELECT mailbox_id, COUNT(*)::int AS messages,
           COUNT(DISTINCT client_id)::int AS clients,
           MIN(sent_at) AS first_at, MAX(sent_at) AS last_at
    FROM mail_messages
    GROUP BY mailbox_id
    ORDER BY messages DESC
  `);
  const shBox = wb.addWorksheet("Mailboxes");
  shBox.columns = [
    { header: "mailbox", key: "mailbox_id", width: 16 },
    { header: "messages", key: "messages", width: 12 },
    { header: "clients", key: "clients", width: 12 },
    { header: "first_at", key: "first_at", width: 22 },
    { header: "last_at", key: "last_at", width: 22 },
  ];
  for (const r of mailboxes.rows) shBox.addRow(r);

  const purged = await pool.query(`
    SELECT message_id, from_email, subject, reason, mailbox_id, purged_at
    FROM newsletter_purge_log
    ORDER BY purged_at DESC
    LIMIT 10000
  `);
  const shNews = wb.addWorksheet("NewslettersPurged");
  shNews.columns = [
    { header: "message_id", key: "message_id", width: 40 },
    { header: "from", key: "from_email", width: 28 },
    { header: "subject", key: "subject", width: 40 },
    { header: "reason", key: "reason", width: 18 },
    { header: "mailbox", key: "mailbox_id", width: 12 },
    { header: "purged_at", key: "purged_at", width: 22 },
  ];
  for (const r of purged.rows) shNews.addRow(r);

  const atts = await pool.query(`
    SELECT a.filename, a.kind, a.sha256, a.storage_key, a.bytes,
           a.client_id, c.name AS client_name, a.content_type
    FROM mail_attachments a
    LEFT JOIN clients c ON c.id = a.client_id
    ORDER BY a.created_at DESC
    LIMIT 20000
  `);
  const shAtt = wb.addWorksheet("Attachments");
  shAtt.columns = [
    { header: "filename", key: "filename", width: 36 },
    { header: "kind", key: "kind", width: 12 },
    { header: "client", key: "client_name", width: 24 },
    { header: "bytes", key: "bytes", width: 10 },
    { header: "sha256", key: "sha256", width: 20 },
    { header: "path", key: "storage_key", width: 40 },
    { header: "content_type", key: "content_type", width: 24 },
  ];
  for (const r of atts.rows) shAtt.addRow(r);

  const outDir = resolve(ROOT, "data/exports");
  mkdirSync(outDir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const outPath = join(outDir, `clients-archive-${day}.xlsx`);
  await wb.xlsx.writeFile(outPath);
  console.log(`[excel] ${outPath}`);
  console.log({
    clients: clients.rows.length,
    calcs: calcs.rows.length,
    services: services.rows.length,
    mailboxes: mailboxes.rows.length,
    purged: purged.rows.length,
    attachments: atts.rows.length,
  });
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
