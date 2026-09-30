/**
 * Ingest local EML archive into Postgres clients / calc_requests / facts / attachments.
 * Usage:
 *   pnpm --filter @alo/workers-ts exec tsx ../../scripts/mail-archive-ingest.ts [--limit N] [--dry-run] [--mailbox id] [--recalc-only]
 */
import { config } from "dotenv";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FREIGHT_SUPPLIER_HINTS,
  calcRequestScore,
  classifyAttachmentKind,
  looksLikeNewsletter,
  matchServiceProvider,
  shouldSkipInlineAttachment,
  type MailRole,
} from "./mail-archive-rules";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
config({ path: resolve(ROOT, ".env") });

const workersRequire = createRequire(
  resolve(ROOT, "apps/workers-ts/package.json")
);
const apiRequire = createRequire(resolve(ROOT, "apps/api/package.json"));
const { simpleParser } = workersRequire("mailparser") as typeof import("mailparser");
const { Pool } = apiRequire("pg") as typeof import("pg");

const DRY_RUN = process.argv.includes("--dry-run");
const RECALC_ONLY = process.argv.includes("--recalc-only");
const ONLY_BOX = (() => {
  const i = process.argv.indexOf("--mailbox");
  return i >= 0 ? String(process.argv[i + 1] || "").trim() : "";
})();
const LIMIT = (() => {
  const i = process.argv.indexOf("--limit");
  return i >= 0 ? Number(process.argv[i + 1] || 0) : 0;
})();

const ARCHIVE_DIR = resolve(
  ROOT,
  process.env.ARCHIVE_MAIL_DIR || "data/mail-archive"
);
const ATTACH_DIR = join(ARCHIVE_DIR, "_attachments");
const OWN_DOMAINS = new Set(
  (process.env.ARCHIVE_OWN_DOMAINS || "zhdtransinvest.ru,transinvest.ru")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);
const OWN_ADDRESSES = new Set(
  (process.env.ARCHIVE_OWN_ADDRESSES || "rzd-perevoz@yandex.ru")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

type MetaSidecar = {
  mailbox_id?: string;
  mailbox_user?: string;
  folder?: string;
  uid?: number;
  message_id?: string | null;
  in_reply_to?: string | null;
  subject?: string;
  date?: string | null;
  from?: string;
  from_email?: string | null;
  to?: string[];
  cc?: string[];
  raw_path?: string;
};

function domainOf(email: string): string {
  const m = email.toLowerCase().match(/@([\w.-]+)/);
  return (m?.[1] || "").toLowerCase();
}

function isOwnEmail(email: string): boolean {
  const e = email.toLowerCase().trim();
  if (OWN_ADDRESSES.has(e)) return true;
  const d = domainOf(e);
  return OWN_DOMAINS.has(d) || [...OWN_DOMAINS].some((o) => d.endsWith(`.${o}`));
}

function normalizeSubject(subject: string): string {
  return (subject || "")
    .replace(/^(re|fw|fwd|ответ|пересл)\s*:\s*/gi, "")
    .replace(/^(re|fw|fwd|ответ|пересл)\s*:\s*/gi, "")
    .trim()
    .toLowerCase()
    .slice(0, 200);
}

function normalizePhone(raw: string): string | null {
  const s = (raw || "").trim();
  if (!s) return null;
  let digits = s.replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("8") && digits.length === 11) digits = "7" + digits.slice(1);
  if (digits.length < 10) return null;
  return `+${digits}`;
}

function extractPhones(text: string): string[] {
  const found =
    text.match(
      /(?:\+7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}|\+\d{10,15}/g
    ) || [];
  const out: string[] = [];
  for (const f of found) {
    const n = normalizePhone(f);
    if (n) out.push(n);
  }
  return [...new Set(out)];
}

function extractInn(text: string): string | null {
  const m = text.match(/\bИНН[:\s]*(\d{10}|\d{12})\b/i);
  return m ? m[1] : null;
}

function detectMode(blob: string): string | null {
  const t = blob.toLowerCase();
  if (/авиа|air\s*freight|\bair\b/.test(t)) return "air";
  if (/море|sea\s*freight|контейнер|feu|teu|fesco/.test(t)) return "sea";
  if (/ж[\s/.-]*д|железн|вагон|rail|жд\b/.test(t)) return "rail";
  if (/сборн|ltl|groupage/.test(t)) return "ltl_groupage";
  if (/фура|ftl|еврофур|автопоезд/.test(t)) return "ftl_truck";
  if (/авто|truck|доставк/.test(t)) return "road";
  if (/мульти|intermodal/.test(t)) return "multimodal";
  return null;
}

function extractRoute(blob: string): { origin?: string; destination?: string } {
  const m =
    blob.match(
      /(?:из|от)\s+([А-Яа-яA-Za-zёЁ\- ]{2,40})\s+(?:в|до|→|->)\s+([А-Яа-яA-Za-zёЁ\- ]{2,40})/i
    ) ||
    blob.match(/([А-Яа-яA-Za-zёЁ]{2,30})\s*[-–—→]\s*([А-Яа-яA-Za-zёЁ]{2,30})/);
  if (!m) return {};
  return { origin: m[1].trim(), destination: m[2].trim() };
}

function contentHash(from: string, subject: string, body: string): string {
  const norm = `${from}|${normalizeSubject(subject)}|${body
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 8000)}`;
  return createHash("sha256").update(norm).digest("hex");
}

function classifyRole(
  fromEmail: string,
  subject: string,
  body: string,
  folder: string,
  mailboxUser: string,
  headers?: Record<string, string | string[] | undefined>
): { role: MailRole; direction: "inbound" | "outbound"; reason: string } {
  const blob = `${subject} ${body} ${fromEmail}`.toLowerCase();
  const folderLow = folder.toLowerCase();
  const isSent =
    /sent|отправ|исходящ/i.test(folderLow) ||
    (fromEmail && isOwnEmail(fromEmail));
  const direction: "inbound" | "outbound" = isSent ? "outbound" : "inbound";

  const news = looksLikeNewsletter({ fromEmail, subject, body, headers });
  if (news.yes) {
    return { role: "newsletter", direction, reason: news.reason };
  }

  const svc = matchServiceProvider(fromEmail, subject, body);
  if (svc && !isSent) {
    return {
      role: "service_provider",
      direction,
      reason: `service:${svc.category}`,
    };
  }

  if (fromEmail && isOwnEmail(fromEmail) && !isSent) {
    return { role: "internal", direction, reason: "own domain inbound" };
  }
  if (
    FREIGHT_SUPPLIER_HINTS.some((h) => fromEmail.includes(h) || blob.includes(h)) ||
    (/ставк|quote|rfq|тариф|rate/.test(blob) &&
      /ответ|re:|на ваш запрос|ref:\s*[0-9a-f-]{36}/i.test(blob))
  ) {
    return { role: "supplier", direction, reason: "supplier/rfq" };
  }
  if (isSent) {
    if (/запрос ставк|ref:\s*[0-9a-f-]{36}/i.test(blob)) {
      return { role: "supplier", direction, reason: "outbound rfq" };
    }
    if (
      calcRequestScore(subject, body).isCalc ||
      /клиент|заявк/.test(blob)
    ) {
      return { role: "client", direction, reason: "outbound to client" };
    }
    return { role: "internal", direction, reason: "outbound other" };
  }
  if (fromEmail && !isOwnEmail(fromEmail) && fromEmail !== mailboxUser.toLowerCase()) {
    if (
      calcRequestScore(subject, body).isCalc ||
      /груз|маршрут|доставк|перевоз|сч[её]т|договор|invoice|contract/i.test(blob) ||
      /клиенты[/|\\]/i.test(folder)
    ) {
      return { role: "client", direction, reason: "client request/docs" };
    }
    return { role: "client", direction, reason: "external contact" };
  }
  return { role: "other", direction, reason: "unclassified" };
}

function walkEmlFiles(root: string): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const name of readdirSync(dir)) {
      if (name === "manifest.json" || name === "_attachments") continue;
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) stack.push(p);
      else if (name.endsWith(".eml")) out.push(p);
    }
  }
  return out.sort();
}

async function main() {
  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ||
      "postgresql://alo:alo@localhost:5432/autologistics",
  });

  if (RECALC_ONLY) {
    console.log(`[ingest] --recalc-only (dryRun=${DRY_RUN})`);
    const msgs = await pool.query(
      `
      SELECT id, client_id, thread_id, mailbox_id, subject, body_text, sent_at
      FROM mail_messages
      WHERE role = 'client' AND client_id IS NOT NULL
      ${ONLY_BOX ? "AND mailbox_id = $1" : ""}
      ORDER BY sent_at DESC NULLS LAST
      ${LIMIT > 0 ? `LIMIT ${LIMIT}` : ""}
      `,
      ONLY_BOX ? [ONLY_BOX] : []
    );
    let added = 0;
    let skipped = 0;
    for (const row of msgs.rows) {
      const subject = row.subject || "";
      const body = row.body_text || "";
      const calc = calcRequestScore(subject, body, {
        mailboxId: row.mailbox_id,
      });
      if (!calc.isCalc) {
        skipped += 1;
        continue;
      }
      const exists = await pool.query(
        `SELECT 1 FROM client_calc_requests WHERE source_message_id = $1 LIMIT 1`,
        [row.id]
      );
      if (exists.rows[0]) {
        skipped += 1;
        continue;
      }
      const mode = detectMode(`${subject} ${body}`);
      const route = extractRoute(`${subject} ${body}`);
      if (!DRY_RUN) {
        await pool.query(
          `INSERT INTO client_calc_requests (
             client_id, source_message_id, thread_id, origin, destination,
             mode, cargo_desc, requested_at, raw
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
          [
            row.client_id,
            row.id,
            row.thread_id,
            route.origin || null,
            route.destination || null,
            mode,
            body.slice(0, 500) || subject.slice(0, 200),
            row.sent_at,
            JSON.stringify({
              subject,
              mode,
              route,
              score: calc.score,
              reasons: calc.reasons,
              recalc: true,
            }),
          ]
        );
      }
      added += 1;
    }
    if (!DRY_RUN) {
      await pool.query(`
        UPDATE clients c SET
          personal_context = COALESCE(c.personal_context, '{}'::jsonb) || jsonb_build_object(
            'calc_count', (SELECT COUNT(*) FROM client_calc_requests r WHERE r.client_id = c.id),
            'modes', (
              SELECT COALESCE(jsonb_agg(DISTINCT mode), '[]'::jsonb)
              FROM client_calc_requests r
              WHERE r.client_id = c.id AND mode IS NOT NULL
            ),
            'last_calc_at', (
              SELECT MAX(requested_at) FROM client_calc_requests r WHERE r.client_id = c.id
            )
          ),
          updated_at = NOW()
        WHERE EXISTS (SELECT 1 FROM client_calc_requests r WHERE r.client_id = c.id)
      `);
    }
    console.log(`[recalc] scanned=${msgs.rows.length} added=${added} skipped=${skipped}`);
    await pool.end();
    return;
  }

  const files = walkEmlFiles(ARCHIVE_DIR);
  let list = LIMIT > 0 ? files.slice(0, LIMIT) : files;
  if (ONLY_BOX) {
    const needle = ONLY_BOX.toLowerCase();
    list = list.filter(
      (p) =>
        p.toLowerCase().includes(`mail-archive\\${needle}\\`) ||
        p.toLowerCase().includes(`mail-archive/${needle}/`)
    );
  }
  if (!list.length) {
    console.error(
      `[ingest] no .eml under ${ARCHIVE_DIR}${ONLY_BOX ? ` for mailbox ${ONLY_BOX}` : ""} — run mail-archive-dump.ts first`
    );
    process.exit(1);
  }
  console.log(
    `[ingest] ${list.length}/${files.length} files (dryRun=${DRY_RUN}${ONLY_BOX ? ` mailbox=${ONLY_BOX}` : ""})`
  );

  if (!DRY_RUN) mkdirSync(ATTACH_DIR, { recursive: true });

  // pool already created above

  const stats = {
    messages: 0,
    skipped: 0,
    clients: 0,
    calcs: 0,
    facts: 0,
    attachments: 0,
    services: 0,
    byRole: {} as Record<string, number>,
    modes: {} as Record<string, number>,
    uncertain: 0,
  };

  const clientCache = new Map<string, string>();

  async function resolveOrCreateClient(opts: {
    email?: string | null;
    name?: string | null;
    phone?: string | null;
    inn?: string | null;
    source: string;
  }): Promise<string | null> {
    const email = (opts.email || "").toLowerCase().trim();
    if (email && isOwnEmail(email)) return null;
    if (email && clientCache.has(email)) return clientCache.get(email)!;

    if (DRY_RUN) {
      const fake = `dry-${email || opts.phone || "x"}`;
      if (email) clientCache.set(email, fake);
      return fake;
    }

    if (email) {
      const byId = await pool.query(
        `SELECT client_id FROM client_identities WHERE kind='email' AND value_norm=$1`,
        [email]
      );
      if (byId.rows[0]) {
        clientCache.set(email, byId.rows[0].client_id);
        return byId.rows[0].client_id;
      }
      const byPrimary = await pool.query(
        `SELECT id FROM clients WHERE lower(primary_email)=lower($1) LIMIT 1`,
        [email]
      );
      if (byPrimary.rows[0]) {
        const id = byPrimary.rows[0].id as string;
        await pool.query(
          `INSERT INTO client_identities (client_id, kind, value, value_norm, source)
           VALUES ($1,'email',$2,$3,$4) ON CONFLICT (kind, value_norm) DO NOTHING`,
          [id, email, email, opts.source]
        );
        clientCache.set(email, id);
        return id;
      }
    }

    if (opts.phone) {
      const phone = normalizePhone(opts.phone);
      if (phone) {
        const byPhone = await pool.query(
          `SELECT client_id FROM client_identities WHERE kind='phone' AND value_norm=$1`,
          [phone]
        );
        if (byPhone.rows[0]) {
          const id = byPhone.rows[0].client_id as string;
          if (email) clientCache.set(email, id);
          return id;
        }
      }
    }

    if (opts.inn) {
      const byInn = await pool.query(
        `SELECT client_id FROM client_identities WHERE kind='inn' AND value_norm=$1`,
        [opts.inn]
      );
      if (byInn.rows[0]) {
        const id = byInn.rows[0].client_id as string;
        if (email) clientCache.set(email, id);
        return id;
      }
    }

    const ins = await pool.query(
      `INSERT INTO clients (channel, name, primary_email, phone, inn, metadata)
       VALUES ('email', $1, $2, $3, $4, $5::jsonb) RETURNING id`,
      [
        opts.name || null,
        email || null,
        opts.phone ? normalizePhone(opts.phone) : null,
        opts.inn || null,
        JSON.stringify({ source: opts.source }),
      ]
    );
    const id = ins.rows[0].id as string;
    stats.clients += 1;

    if (email) {
      await pool.query(
        `INSERT INTO client_identities (client_id, kind, value, value_norm, source)
         VALUES ($1,'email',$2,$3,$4) ON CONFLICT (kind, value_norm) DO NOTHING`,
        [id, email, email, opts.source]
      );
      clientCache.set(email, id);
    }
    if (opts.phone) {
      const phone = normalizePhone(opts.phone);
      if (phone) {
        await pool.query(
          `INSERT INTO client_identities (client_id, kind, value, value_norm, source)
           VALUES ($1,'phone',$2,$3,$4) ON CONFLICT (kind, value_norm) DO NOTHING`,
          [id, phone, phone, opts.source]
        );
      }
    }
    if (opts.inn) {
      await pool.query(
        `INSERT INTO client_identities (client_id, kind, value, value_norm, source)
         VALUES ($1,'inn',$2,$3,$4) ON CONFLICT (kind, value_norm) DO NOTHING`,
        [id, opts.inn, opts.inn, opts.source]
      );
    }
    return id;
  }

  async function upsertThread(
    threadKey: string,
    subjectNorm: string,
    clientId: string | null,
    sentAt: Date | null,
    opts: { bumpCount: boolean }
  ): Promise<string | null> {
    if (DRY_RUN) return `dry-thread-${threadKey.slice(0, 12)}`;
    if (opts.bumpCount) {
      const r = await pool.query(
        `INSERT INTO mail_threads (thread_key, subject_norm, client_id, first_at, last_at, message_count)
         VALUES ($1,$2,$3,$4,$4,1)
         ON CONFLICT (thread_key) DO UPDATE SET
           last_at = GREATEST(COALESCE(mail_threads.last_at, EXCLUDED.last_at), EXCLUDED.last_at),
           first_at = LEAST(COALESCE(mail_threads.first_at, EXCLUDED.first_at), EXCLUDED.first_at),
           message_count = mail_threads.message_count + 1,
           client_id = COALESCE(mail_threads.client_id, EXCLUDED.client_id),
           updated_at = NOW()
         RETURNING id`,
        [threadKey, subjectNorm, clientId, sentAt]
      );
      return r.rows[0]?.id ?? null;
    }
    const r = await pool.query(
      `INSERT INTO mail_threads (thread_key, subject_norm, client_id, first_at, last_at, message_count)
       VALUES ($1,$2,$3,$4,$4,0)
       ON CONFLICT (thread_key) DO UPDATE SET
         client_id = COALESCE(mail_threads.client_id, EXCLUDED.client_id),
         updated_at = NOW()
       RETURNING id`,
      [threadKey, subjectNorm, clientId, sentAt]
    );
    return r.rows[0]?.id ?? null;
  }

  async function upsertServiceProvider(
    fromEmail: string,
    category: string,
    name: string
  ): Promise<void> {
    if (DRY_RUN) {
      stats.services += 1;
      return;
    }
    const email = fromEmail.toLowerCase();
    const dom = domainOf(email);
    await pool.query(
      `INSERT INTO service_providers (name, category, primary_email, domains, message_count)
       VALUES ($1,$2,$3,ARRAY[$4]::text[],1)
       ON CONFLICT (primary_email) DO UPDATE SET
         message_count = service_providers.message_count + 1,
         category = EXCLUDED.category,
         updated_at = NOW()`,
      [name, category, email || null, dom || ""]
    );
    stats.services += 1;
  }

  async function saveAttachments(
    parsed: Awaited<ReturnType<typeof simpleParser>>,
    mailRowId: string | null,
    clientId: string | null
  ): Promise<void> {
    const atts = parsed.attachments || [];
    for (const att of atts) {
      const buf = att.content;
      if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) continue;
      if (
        shouldSkipInlineAttachment({
          filename: att.filename,
          contentDisposition: att.contentDisposition,
          contentType: att.contentType,
          size: buf.length,
        })
      ) {
        continue;
      }
      const filename = (att.filename || `attachment-${buf.length}`).slice(0, 240);
      const sha = createHash("sha256").update(buf).digest("hex");
      const ext = extname(filename) || "";
      const storageKey = `_attachments/${sha}${ext}`;
      const abs = join(ATTACH_DIR, `${sha}${ext}`);
      const kind = classifyAttachmentKind(filename, att.contentType || "");

      if (!DRY_RUN) {
        if (!existsSync(abs)) writeFileSync(abs, buf);
        if (mailRowId) {
          await pool.query(
            `INSERT INTO mail_attachments
               (mail_message_id, client_id, filename, content_type, bytes, sha256, storage_key, kind)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (sha256) DO UPDATE SET
               mail_message_id = COALESCE(mail_attachments.mail_message_id, EXCLUDED.mail_message_id),
               client_id = COALESCE(mail_attachments.client_id, EXCLUDED.client_id)`,
            [
              mailRowId,
              clientId,
              filename,
              att.contentType || null,
              buf.length,
              sha,
              storageKey,
              kind,
            ]
          );
        }
      }
      stats.attachments += 1;
    }
  }

  for (const emlPath of list) {
    const metaPath = emlPath.replace(/\.eml$/i, ".json");
    let side: MetaSidecar = {};
    if (existsSync(metaPath)) {
      try {
        side = JSON.parse(readFileSync(metaPath, "utf8"));
      } catch {
        /* ignore */
      }
    }

    const relParts = emlPath
      .slice(ARCHIVE_DIR.length)
      .replace(/^[/\\]/, "")
      .split(/[/\\]/);
    const mailboxId = side.mailbox_id || relParts[0] || "unknown";
    const folder = side.folder || relParts.slice(1, -1).join("/") || "INBOX";

    try {
      const raw = readFileSync(emlPath);
      const parsed = await simpleParser(raw);
      const messageId =
        (parsed.messageId || side.message_id || "").toString().trim() || null;
      const fromEmail = (
        parsed.from?.value?.[0]?.address ||
        side.from_email ||
        ""
      )
        .toLowerCase()
        .trim();
      const fromRaw = parsed.from?.text || side.from || fromEmail || "";
      const toEmails = side.to?.length
        ? side.to
        : (parsed.to?.value || [])
            .map((a) => (a.address || "").toLowerCase())
            .filter(Boolean);
      const ccEmails = side.cc?.length
        ? side.cc
        : (parsed.cc?.value || [])
            .map((a) => (a.address || "").toLowerCase())
            .filter(Boolean);
      const subject = (parsed.subject || side.subject || "").toString();
      const body = (
        parsed.text ||
        (typeof parsed.html === "string"
          ? parsed.html.replace(/<[^>]+>/g, " ")
          : "") ||
        ""
      )
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 50000);
      const sentAt = parsed.date
        ? parsed.date
        : side.date
          ? new Date(side.date)
          : null;
      const inReplyTo =
        (parsed.inReplyTo || side.in_reply_to || "").toString() || null;
      const references = (
        Array.isArray(parsed.references)
          ? parsed.references.join(" ")
          : parsed.references || ""
      ).toString() || null;

      const headerMap: Record<string, string | string[] | undefined> = {};
      if (parsed.headers && typeof parsed.headers.get === "function") {
        for (const key of [
          "list-id",
          "list-unsubscribe",
          "precedence",
          "x-mailer",
        ]) {
          const v = parsed.headers.get(key);
          if (v != null) headerMap[key] = String(v);
        }
      }

      const mailboxUser = (side.mailbox_user || "").toLowerCase();
      const { role, direction, reason } = classifyRole(
        fromEmail,
        subject,
        body,
        folder,
        mailboxUser,
        headerMap
      );
      stats.byRole[role] = (stats.byRole[role] || 0) + 1;

      const cHash = contentHash(fromEmail, subject, body);
      const subjectNorm = normalizeSubject(subject);
      const threadKey = (
        inReplyTo ||
        (references ? references.split(/\s+/)[0] : "") ||
        `subj:${subjectNorm}`
      )
        .trim()
        .toLowerCase()
        .slice(0, 300);

      // Early duplicate check BEFORE thread bump
      let existingId: string | null = null;
      if (!DRY_RUN) {
        if (messageId) {
          const exists = await pool.query(
            `SELECT id, client_id FROM mail_messages WHERE message_id = $1`,
            [messageId]
          );
          if (exists.rows[0]) existingId = exists.rows[0].id;
        }
        if (!existingId) {
          const byHash = await pool.query(
            `SELECT id, client_id FROM mail_messages WHERE content_hash = $1 LIMIT 1`,
            [cHash]
          );
          if (byHash.rows[0]) existingId = byHash.rows[0].id;
        }
        const uid = side.uid ?? null;
        if (!existingId && uid != null) {
          const existsUid = await pool.query(
            `SELECT id, client_id FROM mail_messages WHERE mailbox_id=$1 AND folder=$2 AND uid=$3`,
            [mailboxId, folder, uid]
          );
          if (existsUid.rows[0]) existingId = existsUid.rows[0].id;
        }
      }
      if (existingId) {
        // Backfill attachments / role / content_hash on re-ingest without bumping threads
        if (!DRY_RUN) {
          const prev = await pool.query(
            `SELECT client_id, role FROM mail_messages WHERE id = $1`,
            [existingId]
          );
          const prevClient = (prev.rows[0]?.client_id as string | null) || null;
          await pool.query(
            `UPDATE mail_messages SET
               content_hash = COALESCE(content_hash, $2),
               role = CASE
                 WHEN role IN ('client','supplier') AND $3 IN ('newsletter','service_provider') THEN role
                 WHEN $3 IN ('newsletter','service_provider','internal') THEN $3
                 ELSE role
               END,
               metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb
             WHERE id = $1`,
            [
              existingId,
              cHash,
              role,
              JSON.stringify({ classify_reason: reason, headers: headerMap }),
            ]
          );
          if (role === "service_provider") {
            const svc = matchServiceProvider(fromEmail, subject, body);
            if (svc) await upsertServiceProvider(fromEmail, svc.category, svc.name);
          }
          await saveAttachments(parsed, existingId, prevClient);
        }
        stats.skipped += 1;
        continue;
      }

      let clientId: string | null = null;
      if (role === "client") {
        const contactEmail =
          direction === "inbound"
            ? fromEmail
            : toEmails.find((e) => e && !isOwnEmail(e)) || null;
        const displayName =
          parsed.from?.value?.[0]?.name ||
          fromRaw.replace(/<.*?>/, "").trim() ||
          null;
        const phones = extractPhones(`${body} ${fromRaw}`);
        const inn = extractInn(body);
        if (!contactEmail && !phones.length) {
          stats.uncertain += 1;
        } else {
          clientId = await resolveOrCreateClient({
            email: contactEmail,
            name: displayName,
            phone: phones[0] || null,
            inn,
            source: `mail:${mailboxId}`,
          });
        }
      }

      if (role === "service_provider") {
        const svc = matchServiceProvider(fromEmail, subject, body);
        if (svc) await upsertServiceProvider(fromEmail, svc.category, svc.name);
      }

      const threadId = await upsertThread(
        threadKey,
        subjectNorm,
        clientId,
        sentAt,
        { bumpCount: false }
      );

      let mailRowId: string | null = null;
      if (!DRY_RUN) {
        const uid = side.uid ?? null;
        const ins = await pool.query(
          `INSERT INTO mail_messages (
             mailbox_id, folder, uid, message_id, in_reply_to, references_hdr,
             thread_id, thread_key, from_raw, from_email, to_emails, cc_emails,
             subject, sent_at, body_text, raw_path, role, client_id, direction,
             content_hash, metadata
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb
           )
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [
            mailboxId,
            folder,
            uid,
            messageId,
            inReplyTo,
            references,
            threadId,
            threadKey,
            fromRaw,
            fromEmail || null,
            toEmails,
            ccEmails,
            subject,
            sentAt,
            body.slice(0, 20000),
            emlPath.replace(ROOT + "\\", "").replace(ROOT + "/", ""),
            role,
            clientId,
            direction,
            cHash,
            JSON.stringify({ classify_reason: reason, headers: headerMap }),
          ]
        );
        mailRowId = ins.rows[0]?.id ?? null;
        if (!mailRowId) {
          stats.skipped += 1;
          continue;
        }
        // Bump thread count only after a real new message row
        await upsertThread(threadKey, subjectNorm, clientId, sentAt, {
          bumpCount: true,
        });
      } else {
        await upsertThread(threadKey, subjectNorm, clientId, sentAt, {
          bumpCount: true,
        });
      }

      stats.messages += 1;

      await saveAttachments(parsed, mailRowId, clientId);

      const calc = calcRequestScore(subject, body, { mailboxId });
      if (role === "client" && clientId && calc.isCalc) {
        const mode = detectMode(`${subject} ${body}`);
        const route = extractRoute(`${subject} ${body}`);
        if (mode) stats.modes[mode] = (stats.modes[mode] || 0) + 1;
        if (!DRY_RUN && !clientId.startsWith("dry-")) {
          await pool.query(
            `INSERT INTO client_calc_requests (
               client_id, source_message_id, thread_id, origin, destination,
               mode, cargo_desc, requested_at, raw
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
            [
              clientId,
              mailRowId,
              threadId,
              route.origin || null,
              route.destination || null,
              mode,
              body.slice(0, 500) || subject.slice(0, 200),
              sentAt,
              JSON.stringify({
                subject,
                mode,
                route,
                score: calc.score,
                reasons: calc.reasons,
              }),
            ]
          );
          stats.calcs += 1;
        } else if (DRY_RUN) {
          stats.calcs += 1;
        }
      }

      if (
        role === "client" &&
        clientId &&
        !DRY_RUN &&
        !clientId.startsWith("dry-")
      ) {
        const phones = extractPhones(body);
        for (const p of phones.slice(0, 2)) {
          await pool.query(
            `INSERT INTO client_facts (client_id, fact_type, value, source_message_id, confidence)
             VALUES ($1,'phone',$2,$3,0.8)`,
            [clientId, p, mailRowId]
          );
          stats.facts += 1;
        }
        const inn = extractInn(body);
        if (inn) {
          await pool.query(
            `INSERT INTO client_facts (client_id, fact_type, value, source_message_id, confidence)
             VALUES ($1,'inn',$2,$3,0.9)`,
            [clientId, inn, mailRowId]
          );
          stats.facts += 1;
        }
        const mode = detectMode(`${subject} ${body}`);
        if (mode) {
          await pool.query(
            `INSERT INTO client_facts (client_id, fact_type, value, source_message_id, confidence)
             VALUES ($1,'preferred_mode',$2,$3,0.6)`,
            [clientId, mode, mailRowId]
          );
          stats.facts += 1;
        }
        const docBlob = `${subject} ${body} ${folder}`;
        if (
          /сч[её]т[аыу]?(\s|$|№|#)|invoice|счет-фактур|счёт-фактур/i.test(
            docBlob
          )
        ) {
          await pool.query(
            `INSERT INTO client_facts (client_id, fact_type, value, source_message_id, confidence, metadata)
             VALUES ($1,'invoice',$2,$3,0.75,$4::jsonb)`,
            [
              clientId,
              subject.slice(0, 300) || "счет",
              mailRowId,
              JSON.stringify({ folder, mailbox_id: mailboxId }),
            ]
          );
          stats.facts += 1;
        }
        if (/договор|contract|соглашени/i.test(docBlob)) {
          await pool.query(
            `INSERT INTO client_facts (client_id, fact_type, value, source_message_id, confidence, metadata)
             VALUES ($1,'contract',$2,$3,0.75,$4::jsonb)`,
            [
              clientId,
              subject.slice(0, 300) || "договор",
              mailRowId,
              JSON.stringify({ folder, mailbox_id: mailboxId }),
            ]
          );
          stats.facts += 1;
        }
        const folderClient = folder.match(/Клиенты[/|\\]([^/|\\]+)/i);
        if (folderClient?.[1]) {
          const nameHint = folderClient[1].trim();
          if (nameHint.length > 1) {
            await pool.query(
              `UPDATE clients SET
                 name = COALESCE(NULLIF(name,''), $2),
                 legal_name = COALESCE(legal_name, $2),
                 updated_at = NOW()
               WHERE id = $1 AND (name IS NULL OR name = '' OR legal_name IS NULL)`,
              [clientId, nameHint]
            );
            await pool.query(
              `INSERT INTO client_facts (client_id, fact_type, value, source_message_id, confidence, metadata)
               VALUES ($1,'folder_client',$2,$3,0.85,$4::jsonb)`,
              [
                clientId,
                nameHint,
                mailRowId,
                JSON.stringify({ folder, mailbox_id: mailboxId }),
              ]
            );
            stats.facts += 1;
          }
        }
      }
    } catch (e) {
      console.warn(
        `[ingest] fail ${emlPath}:`,
        e instanceof Error ? e.message : e
      );
    }

    if (stats.messages % 100 === 0 && stats.messages > 0) {
      console.log(
        `[ingest] processed=${stats.messages} clients+=${stats.clients} att+=${stats.attachments}`
      );
    }
    if (stats.skipped % 500 === 0 && stats.skipped > 0) {
      console.log(
        `[ingest] skipped=${stats.skipped} att+=${stats.attachments} svc+=${stats.services}`
      );
    }
  }

  if (!DRY_RUN) {
    await pool.query(`
      UPDATE clients c SET
        personal_context = COALESCE(c.personal_context, '{}'::jsonb) || jsonb_build_object(
          'calc_count', (SELECT COUNT(*) FROM client_calc_requests r WHERE r.client_id = c.id),
          'modes', (
            SELECT COALESCE(jsonb_agg(DISTINCT mode), '[]'::jsonb)
            FROM client_calc_requests r
            WHERE r.client_id = c.id AND mode IS NOT NULL
          ),
          'last_calc_at', (
            SELECT MAX(requested_at) FROM client_calc_requests r WHERE r.client_id = c.id
          )
        ),
        updated_at = NOW()
      WHERE EXISTS (SELECT 1 FROM client_calc_requests r WHERE r.client_id = c.id)
    `);
  }

  await pool.end();

  const day = new Date().toISOString().slice(0, 10);
  const reportDir = resolve(ROOT, "logs/mail");
  mkdirSync(reportDir, { recursive: true });
  const reportPath = join(reportDir, `archive-ingest-${day}.md`);
  const topModes = Object.entries(stats.modes)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([m, n]) => `- ${m}: ${n}`);
  writeFileSync(
    reportPath,
    [
      "# Mail archive ingest",
      "",
      `Date: ${day}`,
      DRY_RUN ? "*(dry-run)*" : "",
      "",
      `Messages: ${stats.messages}`,
      `Skipped: ${stats.skipped}`,
      `Clients: ${stats.clients}`,
      `Calcs: ${stats.calcs}`,
      `Facts: ${stats.facts}`,
      `Attachments: ${stats.attachments}`,
      `Service providers: ${stats.services}`,
      "",
      "## By role",
      ...Object.entries(stats.byRole).map(([k, v]) => `- ${k}: ${v}`),
      "",
      "## Modes",
      ...(topModes.length ? topModes : ["- (none)"]),
      "",
    ]
      .filter(Boolean)
      .join("\n"),
    "utf8"
  );
  console.log(`[report] ${reportPath}`);
  console.log(JSON.stringify(stats, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
