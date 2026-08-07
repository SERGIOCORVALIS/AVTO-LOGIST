import "dotenv/config";
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../../../scripts/load-secrets.cjs");
} catch {
  /* optional */
}
import { Queue, Worker, QueueEvents } from "bullmq";
import IORedis from "ioredis";
import { Pool } from "pg";
import nodemailer from "nodemailer";
import { QUEUES, createLogger, ensureLogTree } from "@alo/shared";
import { buildDailyDigest } from "./digest";
import { sendQuoteRequestEmail, findEmailOnDomain, syncInboundMail } from "./email";
import { applyOcrToDeal, parseInvoiceAttachment } from "./ocr";
import { triggerDealReprocess } from "./reprocess";
import { syncCalendarEvents } from "./calendar";

const log = createLogger("workers");
ensureLogTree();

const connection = new IORedis(process.env.REDIS_URL || "redis://localhost:6379", {
  maxRetriesPerRequest: null,
});
const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://alo:alo@localhost:5432/autologistics",
});

const channelQueue = new Queue(QUEUES.channel, { connection });
const slaQueue = new Queue(QUEUES.sla, { connection });
const digestQueue = new Queue(QUEUES.digest, { connection });
const emailQueue = new Queue(QUEUES.email, { connection });
const dlq = new Queue(QUEUES.dlq, { connection });

async function moveToDlq(queue: string, jobId: string | undefined, payload: unknown, error: string) {
  log.error("dlq", { queue, jobId, error });
  await dlq.add("failed", { queue, jobId, payload, error });
  await pool.query(
    `INSERT INTO dead_letter_jobs (queue, job_id, payload, error, attempts)
     VALUES ($1,$2,$3,$4,1)`,
    [queue, jobId ?? null, JSON.stringify(payload), error]
  );
}

async function main() {
  // SLA: quote validity + follow-ups
  new Worker(
    QUEUES.sla,
    async (job) => {
      const kind = job.name;
      if (kind === "check_quote_ttl") {
        const r = await pool.query(
          `SELECT q.id, q.deal_id, q.valid_until, d.tg_chat_id
           FROM quotes q JOIN deals d ON d.id = q.deal_id
           WHERE q.valid_until IS NOT NULL AND q.valid_until < NOW()
             AND d.status IN ('quoting','pricing','negotiation')`
        );
        for (const row of r.rows) {
          await channelQueue.add("alert", {
            kind: "alert",
            text: `⚠️ Quote expired for deal ${row.deal_id} (quote ${row.id}). Need refresh.`,
            deal_id: row.deal_id,
          });
        }
      }
      if (kind === "followup_partners") {
        const r = await pool.query(
          `SELECT id, client_name, status, updated_at FROM deals
           WHERE status = 'quoting' AND updated_at < NOW() - INTERVAL '2 hours'
           LIMIT 20`
        );
        for (const row of r.rows) {
          await channelQueue.add("info", {
            kind: "info",
            text: `⏳ Follow-up: deal ${row.id} still quoting (${row.client_name || "—"})`,
            deal_id: row.id,
          });
        }
      }
      if (kind === "sync_calendar") {
        const n = await syncCalendarEvents(pool);
        console.log(`[calendar] synced ${n} events`);
      }
    },
    { connection }
  );

  new Worker(
    QUEUES.digest,
    async () => {
      const text = await buildDailyDigest(pool);
      await channelQueue.add("digest", { kind: "digest", text });
    },
    { connection }
  );

  new Worker(
    QUEUES.ocr,
    async (job) => {
      try {
        if (job.name === "parse_invoice") {
          const parsed = await parseInvoiceAttachment(job.data);
          await applyOcrToDeal(pool, job.data, parsed);
          if (parsed.invoice_value != null) {
            await channelQueue.add("info", {
              kind: "info",
              text: `🧾 OCR invoice for deal ${job.data.deal_id}: ${parsed.invoice_value} ${parsed.invoice_currency || ""} (${parsed.parse_source})`.trim(),
              deal_id: job.data.deal_id,
            });
            const rp = await triggerDealReprocess({
              dealId: job.data.deal_id,
              idempotencyKey: `ocr-reprice:${job.data.deal_id}:${job.data.attachment_id}`,
              reason: "OCR invoice parsed",
            });
            if (!rp.ok) {
              console.warn(`[ocr] reprocess failed: ${rp.detail}`);
            }
          }
        }
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        await moveToDlq(QUEUES.ocr, job.id, job.data, err);
        throw e;
      }
    },
    { connection, concurrency: 2 }
  );

  new Worker(
    QUEUES.email,
    async (job) => {
      try {
        if (job.name === "request_quote") {
          await sendQuoteRequestEmail(job.data);
        } else if (job.name === "find_and_request") {
          const email = await findEmailOnDomain(job.data.website);
          if (!email) throw new Error("email_not_found");
          const domain = email.split("@")[1];
          const whitelist = (process.env.EMAIL_WHITELIST_DOMAINS || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          if (whitelist.length && !whitelist.includes(domain)) {
            // require first-email approval for new domains
            const existing = await pool.query(
              `SELECT * FROM partner_contacts WHERE email = $1`,
              [email]
            );
            if (!existing.rows[0]?.first_email_approved) {
              await pool.query(
                `INSERT INTO partner_contacts (email, domain, verified, first_email_approved, source_url)
                 VALUES ($1,$2,FALSE,FALSE,$3)
                 ON CONFLICT (email) DO NOTHING`,
                [email, domain, job.data.website]
              );
              await channelQueue.add("alert", {
                kind: "alert",
                text: `📧 New partner email needs approve before send: ${email} (${job.data.website})`,
              });
              return;
            }
          }
          await sendQuoteRequestEmail({ ...job.data, to: email });
        } else if (job.name === "imap_sync") {
          const mails = await syncInboundMail({ limit: 30 });
          for (const m of mails) {
            if (m.messageId) {
              const seen = await pool.query(
                `SELECT 1 FROM idempotency_keys WHERE key = $1 AND expires_at > NOW()`,
                [`email:${m.messageId}`]
              );
              if (seen.rows[0]) continue;
            }
            if (!m.dealId) {
              console.log(`[imap] skip (no Ref): ${m.subject}`);
              continue;
            }
            if (m.parsedPrice != null) {
              await pool.query(
                `INSERT INTO quotes
                   (deal_id, source, route_summary, price, currency, eta_days_min, eta_days_max, raw, valid_until)
                 VALUES ($1,'email_imap',$2,$3,$4,$5,$6,$7::jsonb, NOW() + INTERVAL '48 hours')`,
                [
                  m.dealId,
                  m.subject || "email reply",
                  m.parsedPrice,
                  m.parsedCurrency || "RUB",
                  m.etaDaysMin ?? null,
                  m.etaDaysMax ?? null,
                  JSON.stringify({
                    messageId: m.messageId,
                    from: m.from,
                    subject: m.subject,
                    text: m.text?.slice(0, 2000),
                    parseSource: m.parseSource,
                  }),
                ]
              );
              if (m.messageId) {
                await pool.query(
                  `INSERT INTO idempotency_keys (key, scope, result, expires_at)
                   VALUES ($1,'email_imap','{}'::jsonb, NOW() + INTERVAL '30 days')
                   ON CONFLICT (key) DO NOTHING`,
                  [`email:${m.messageId}`]
                );
              }
              await channelQueue.add("alert", {
                kind: "info",
                text: `📬 IMAP quote for deal ${m.dealId}: ${m.parsedPrice} ${m.parsedCurrency || ""} (${m.parseSource || "heuristic"}) from ${m.from || "?"}`.trim(),
                deal_id: m.dealId,
              });
              const rp = await triggerDealReprocess({
                dealId: m.dealId,
                idempotencyKey: `imap-reprice:${m.dealId}:${m.messageId || m.parsedPrice}`,
                reason: `IMAP quote ${m.parsedPrice} ${m.parsedCurrency || ""}`,
              });
              if (!rp.ok) {
                console.warn(`[imap] reprocess failed: ${rp.detail}`);
              }
            } else {
              await channelQueue.add("info", {
                kind: "info",
                text: `📬 Mail reply for deal ${m.dealId} (price not parsed). Subject: ${m.subject}`,
                deal_id: m.dealId,
              });
            }
          }
        }
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        await moveToDlq(QUEUES.email, job.id, job.data, err);
        throw e;
      }
    },
    { connection, concurrency: 2 }
  );

  // Schedule recurring jobs
  await slaQueue.add(
    "check_quote_ttl",
    {},
    { repeat: { every: 15 * 60 * 1000 }, jobId: "sla-quote-ttl" }
  );
  await slaQueue.add(
    "followup_partners",
    {},
    { repeat: { every: 30 * 60 * 1000 }, jobId: "sla-followup" }
  );
  if (process.env.GOOGLE_CALENDAR_ENABLED !== "false") {
    await slaQueue.add(
      "sync_calendar",
      {},
      { repeat: { every: 60 * 1000 }, jobId: "calendar-sync-poll" }
    );
  }
  // 09:30 Moscow = 06:30 UTC
  await digestQueue.add(
    "daily",
    {},
    { repeat: { pattern: "30 6 * * *" }, jobId: "daily-digest" }
  );

  const syncEvery = Number(process.env.MAIL_SYNC_INTERVAL_MS || 60_000);
  if (process.env.MAIL_SYNC_ENABLED !== "false") {
    await emailQueue.add(
      "imap_sync",
      {},
      { repeat: { every: syncEvery }, jobId: "imap-sync-poll" }
    );
  }

  // DLQ observer
  for (const q of [QUEUES.email, QUEUES.ocr, QUEUES.sla, QUEUES.digest]) {
    const events = new QueueEvents(q, { connection });
    events.on("failed", async ({ jobId, failedReason }) => {
      console.error(`[dlq-watch] ${q} job ${jobId}: ${failedReason}`);
    });
  }

  console.log("[workers-ts] SLA / digest / email / OCR workers running");
  log.info("workers running");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

export { emailQueue, nodemailer };
