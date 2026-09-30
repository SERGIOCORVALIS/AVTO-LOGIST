import { loadRootEnv } from "@alo/shared";
loadRootEnv();
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../../../scripts/load-secrets.cjs");
} catch {
  /* optional */
}
import { Queue, Worker, QueueEvents } from "bullmq";
import { randomUUID } from "crypto";
import IORedis from "ioredis";
import { Pool } from "pg";
import nodemailer from "nodemailer";
import {
  QUEUES,
  createLogger,
  dealSnippetFromRow,
  ensureLogTree,
  enforceLicense,
  formatFollowupStaff,
  formatImapQuoteStaff,
  formatImapUnparsedStaff,
  formatOcrInvoiceStaff,
  formatPartnerEmailApproveStaff,
  formatQuoteExpiredStaff,
} from "@alo/shared";
import { buildDailyDigest, buildWeeklySilentReview } from "./digest";
import { runAssociationsUpdateJob } from "./associationsParser";
import { submitCabinetRfq } from "./cabinet";
import { triggerApiQuoteFallback, triggerDealReprocess, processEmailWithGpt } from "./reprocess";
import { applyOcrToDeal, parseInvoiceAttachment } from "./ocr";
import { syncCalendarEvents } from "./calendar";
import {
  classifyInboundMailWithGpt,
  extractAddress,
  findEmailOnDomain,
  sendClientReplyEmail,
  sendQuoteRequestEmail,
  syncInboundMail,
} from "./email";
import {
  autoMarkSilentSuppliers,
  markSupplierReplied,
  markSupplierRfqSent,
} from "./supplierQuality";

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

function channelJobId(kind: string, ...parts: Array<string | number | undefined>): string {
  return [kind, ...parts.map((p) => String(p ?? "0"))]
    .join("-")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 128);
}

function isJobExistsError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /already exists/i.test(msg);
}

async function markEmailSeen(messageId: string | undefined) {
  if (!messageId) return;
  await pool.query(
    `INSERT INTO idempotency_keys (key, scope, result, expires_at)
     VALUES ($1,'email_imap','{}'::jsonb, NOW() + INTERVAL '30 days')
     ON CONFLICT (key) DO NOTHING`,
    [`email:${messageId}`]
  );
}

async function loadDealSnippet(dealId: string) {
  const r = await pool.query(`SELECT * FROM deals WHERE id = $1`, [dealId]);
  return r.rows[0] ? dealSnippetFromRow(r.rows[0] as Record<string, unknown>) : { id: dealId };
}

async function enqueueChannel(
  name: string,
  data: {
    kind: string;
    text: string;
    deal_id?: string;
    notify_director?: boolean;
  },
  jobId: string
) {
  try {
    await channelQueue.add(name, data, {
      jobId,
      removeOnComplete: false,
      attempts: 3,
    });
  } catch (err) {
    if (!isJobExistsError(err)) throw err;
  }
}

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
  await enforceLicense({
    service: "workers-ts",
    allowPrompt: Boolean(process.stdin.isTTY),
  });
  // SLA: quote validity + follow-ups
  new Worker(
    QUEUES.sla,
    async (job) => {
      const kind = job.name;
      if (kind === "check_quote_ttl") {
        const r = await pool.query(
          `SELECT q.id, q.deal_id, q.valid_until, q.price, q.currency, q.source,
                  d.client_name, d.status, d.amount_rub, d.margin_pct, d.client_phone,
                  d.channel, d.cargo, d.route, d.offer
           FROM quotes q JOIN deals d ON d.id = q.deal_id
           WHERE q.valid_until IS NOT NULL AND q.valid_until < NOW()
             AND d.status IN ('quoting','pricing','negotiation')`
        );
        for (const row of r.rows) {
          await enqueueChannel(
            "info",
            {
              kind: "info",
              text: formatQuoteExpiredStaff({
                deal: dealSnippetFromRow(row as Record<string, unknown>),
                quoteId: row.id,
                source: row.source,
                price: row.price != null ? Number(row.price) : undefined,
                currency: row.currency,
                validUntil: row.valid_until,
              }),
              deal_id: row.deal_id,
            },
            channelJobId("quote-expired", row.id)
          );
        }
      }
      if (kind === "followup_partners") {
        try {
          const n = await autoMarkSilentSuppliers(pool);
          if (n > 0) {
            log.info("suppliers_auto_silent", { count: n });
            await enqueueChannel(
              "info",
              {
                kind: "info",
                text: `Поставщики: автопометка «не отвечают» — ${n} шт. Проверьте вкладку в кабинете.`,
              },
              channelJobId("supplier-auto-silent", new Date().toISOString().slice(0, 13))
            );
          }
        } catch (err) {
          log.error("suppliers_auto_silent_failed", {
            err: err instanceof Error ? err.message : String(err),
          });
        }
        const r = await pool.query(
          `SELECT id, client_name, status, updated_at, amount_rub, margin_pct,
                  client_phone, channel, cargo, route, offer
           FROM deals
           WHERE status = 'quoting' AND updated_at < NOW() - INTERVAL '2 hours'
           LIMIT 20`
        );
        for (const row of r.rows) {
          const hour = new Date().toISOString().slice(0, 13);
          await enqueueChannel(
            "info",
            {
              kind: "info",
              text: formatFollowupStaff({
                deal: dealSnippetFromRow(row as Record<string, unknown>),
                updatedAt: row.updated_at,
              }),
              deal_id: row.id,
            },
            channelJobId("followup", row.id, hour)
          );
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
    async (job) => {
      if (job.name === "weekly_silent") {
        const text = await buildWeeklySilentReview(pool);
        const week = new Date().toISOString().slice(0, 10);
        await enqueueChannel(
          "digest",
          { kind: "digest", text },
          channelJobId("weekly-silent", week)
        );
        return;
      }
      if (job.name === "associations_weekly") {
        const enabled = await pool.query(
          `SELECT enabled FROM parser_settings WHERE id = 'associations_cis'`
        );
        if (enabled.rows[0]?.enabled === false) {
          console.log("[parser] associations weekly skipped (disabled)");
          return;
        }
        const runId = randomUUID();
        await pool.query(
          `INSERT INTO parser_runs (id, parser_id, status, triggered_by)
           VALUES ($1, 'associations_cis', 'queued', 'schedule')`,
          [runId]
        );
        await runAssociationsUpdateJob({ run_id: runId, triggered_by: "schedule" });
        return;
      }
      if (job.name === "associations_update") {
        const data = job.data as { run_id: string; staff_id?: string | null };
        await runAssociationsUpdateJob({
          run_id: data.run_id,
          staff_id: data.staff_id ?? null,
          triggered_by: "manual",
        });
        return;
      }
      const text = await buildDailyDigest(pool);
      const day = new Date().toISOString().slice(0, 10);
      await enqueueChannel("digest", { kind: "digest", text }, channelJobId("digest", day));
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
          const useful =
            parsed.invoice_value != null ||
            parsed.weight_kg != null ||
            parsed.name ||
            parsed.has_spec ||
            parsed.invoice_doc ||
            Boolean(parsed.ocr_text && parsed.ocr_text.trim().length >= 40);
          if (useful) {
            if (parsed.invoice_value != null) {
              await enqueueChannel(
                "alert",
                {
                  kind: "info",
                  text: formatOcrInvoiceStaff({
                    deal: await loadDealSnippet(job.data.deal_id),
                    value: parsed.invoice_value,
                    currency: parsed.invoice_currency,
                    source: parsed.parse_source,
                  }),
                  deal_id: job.data.deal_id,
                },
                channelJobId("ocr", job.data.deal_id, job.data.attachment_id)
              );
            }
            const rp = await triggerDealReprocess({
              dealId: job.data.deal_id,
              idempotencyKey: `ocr-reprice:${job.data.deal_id}:${job.data.attachment_id}`,
              reason: "OCR document parsed",
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
        if (job.name === "request_quote" || job.name === "request_sourcing") {
          await sendQuoteRequestEmail({
            ...job.data,
            rfq_kind: job.name === "request_sourcing" ? "sourcing" : job.data.rfq_kind || "freight",
          });
          await markSupplierRfqSent(pool, job.data.to);
        } else if (job.name === "cabinet_rfq") {
          const cab = await submitCabinetRfq(job.data);
          const dealId = String(job.data?.deal_id || "");
          const code = String(job.data?.code || cab?.code || "").toLowerCase();
          // Cabinet flow never invents a freight price — fall back to FIT/API.
          const gotPrice =
            cab &&
            typeof cab === "object" &&
            ("price" in cab || "quote" in cab) &&
            Boolean((cab as { price?: unknown }).price || (cab as { quote?: unknown }).quote);
          if (dealId && !gotPrice) {
            const fb = await triggerApiQuoteFallback({
              dealId,
              reason: `cabinet_${code || "x"}_no_reply`,
            });
            console.log(
              `[cabinet] api_fallback deal=${dealId} code=${code} ok=${fb.ok} priced=${fb.priced ?? false} ${fb.detail || ""}`
            );
          }
        } else if (job.name === "api_quote_fallback") {
          const dealId = String(job.data?.deal_id || "");
          if (!dealId) throw new Error("api_quote_fallback_missing_deal_id");
          const fb = await triggerApiQuoteFallback({
            dealId,
            reason: String(job.data?.reason || "cabinet_pending_no_http"),
          });
          if (!fb.ok) throw new Error(fb.detail || "api_quote_fallback_failed");
          console.log(
            `[api_quote_fallback] deal=${dealId} priced=${fb.priced ?? false}`
          );
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
              await enqueueChannel(
                "alert",
                {
                  kind: "info",
                  text: formatPartnerEmailApproveStaff({
                    email,
                    website: job.data.website,
                  }),
                },
                channelJobId("partner-approve", email)
              );
              return;
            }
          }
          await sendQuoteRequestEmail({ ...job.data, to: email });
          await markSupplierRfqSent(pool, email);
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

            const kind =
              (await classifyInboundMailWithGpt({
                from: m.from,
                subject: m.subject,
                text: m.text,
                headers: m.headers,
                hasDealRef: Boolean(m.dealId),
                hasPrice: m.parsedPrice != null,
              })) ||
              (m.dealId
                ? m.parsedPrice != null
                  ? "supplier_quote"
                  : "supplier_other"
                : "noise");

            if (kind === "noise") {
              console.log(`[imap] noise skip: ${m.subject}`);
              await markEmailSeen(m.messageId);
              continue;
            }

            // Client mail without Ref → GPT concierge + SMTP reply
            if (kind === "client" && !m.dealId) {
              const addr = extractAddress(m.from);
              if (!addr) {
                console.log(`[imap] client skip (no from): ${m.subject}`);
                await markEmailSeen(m.messageId);
                continue;
              }
              const gpt = await processEmailWithGpt({
                text: m.text || m.subject || "",
                clientEmail: addr,
                subject: m.subject,
                idempotencyKey: `imap-client:${m.messageId || addr}:${Date.now()}`,
              });
              await markEmailSeen(m.messageId);
              if (gpt.ok && gpt.replies?.length) {
                await sendClientReplyEmail({
                  to: addr,
                  subject: m.subject || "Расчёт перевозки",
                  body: gpt.replies.join("\n\n"),
                  inReplyTo: m.messageId,
                });
                await enqueueChannel(
                  "alert",
                  {
                    kind: "info",
                    text: `GPT ответил клиенту по почте ${addr}` +
                      (gpt.deal_id ? `\nСделка: ${gpt.deal_id}` : ""),
                    deal_id: gpt.deal_id,
                  },
                  channelJobId("imap-client", addr, m.messageId)
                );
              } else {
                console.warn(`[imap] client GPT failed: ${gpt.detail || "no replies"}`);
              }
              continue;
            }

            if (!m.dealId) {
              console.log(`[imap] skip (no Ref): ${m.subject}`);
              await markEmailSeen(m.messageId);
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
              await markSupplierReplied(pool, m.from);
              await markEmailSeen(m.messageId);
              await enqueueChannel(
                "alert",
                {
                  kind: "info",
                  text: formatImapQuoteStaff({
                    deal: await loadDealSnippet(m.dealId),
                    price: m.parsedPrice,
                    currency: m.parsedCurrency,
                    from: m.from,
                    source: m.parseSource,
                  }),
                  deal_id: m.dealId,
                },
                channelJobId("imap-quote", m.dealId, m.messageId)
              );
              // Rank station–port / supplier quotes for staff when 2+ rates land.
              try {
                const orch = (
                  process.env.ORCHESTRATOR_URL || "http://localhost:8000"
                ).replace(/\/$/, "");
                const cmpRes = await fetch(
                  `${orch}/deals/${m.dealId}/quote-compare?notify=1`
                );
                if (cmpRes.ok) {
                  const cmp = (await cmpRes.json()) as { count?: number };
                  console.log(
                    `[imap] quote-compare deal=${m.dealId} count=${cmp.count ?? "?"}`
                  );
                }
              } catch (e) {
                console.warn(
                  "[imap] quote-compare failed",
                  e instanceof Error ? e.message : e
                );
              }
              const rp = await triggerDealReprocess({
                dealId: m.dealId,
                idempotencyKey: `imap-reprice:${m.dealId}:${m.messageId || m.parsedPrice}`,
                reason: `IMAP quote ${m.parsedPrice} ${m.parsedCurrency || ""}`,
              });
              if (!rp.ok) {
                console.warn(`[imap] reprocess failed: ${rp.detail}`);
              }
            } else {
              await markSupplierReplied(pool, m.from);
              await markEmailSeen(m.messageId);
              await enqueueChannel(
                "alert",
                {
                  kind: "info",
                  text: formatImapUnparsedStaff({
                    deal: await loadDealSnippet(m.dealId),
                    subject: m.subject,
                    from: m.from,
                  }),
                  deal_id: m.dealId,
                },
                channelJobId("imap-noprice", m.dealId, m.messageId)
              );
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
  // Monday 09:00 Moscow = 06:00 UTC
  await digestQueue.add(
    "weekly_silent",
    {},
    { repeat: { pattern: "0 6 * * 1" }, jobId: "weekly-silent-review" }
  );
  if (process.env.PARSER_ASSOCIATIONS_ENABLED !== "false") {
    await digestQueue.add(
      "associations_weekly",
      {},
      { repeat: { pattern: "0 6 * * 1" }, jobId: "associations-weekly" }
    );
  }

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
