import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { companyDisplayName } from "@alo/shared";

export interface QuoteEmailPayload {
  to: string;
  deal_id?: string;
  subject?: string;
  route_summary?: string;
  cargo_summary?: string;
  weight_kg?: number;
  volume_m3?: number;
  ready_date?: string;
  website?: string;
}

export interface MailEndpoints {
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  user: string;
  pass?: string;
  from: string;
  accessToken?: string;
  authMode: "app_password" | "oauth2";
}

async function fetchGoogleAccessToken(): Promise<string | null> {
  const clientId = process.env.MAIL_OAUTH_CLIENT_ID;
  const clientSecret = process.env.MAIL_OAUTH_CLIENT_SECRET;
  const refresh = process.env.MAIL_OAUTH_REFRESH_TOKEN;
  const tokenUrl =
    process.env.MAIL_OAUTH_TOKEN_URL || "https://oauth2.googleapis.com/token";
  if (!clientId || !clientSecret || !refresh) return null;
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refresh,
    grant_type: "refresh_token",
  });
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    console.error("[oauth2] token refresh failed", await res.text());
    return null;
  }
  const data = (await res.json()) as { access_token?: string };
  return data.access_token || null;
}

/** Resolve Gmail / Yandex / custom SMTP+IMAP from env */
export async function resolveMailEndpoints(): Promise<MailEndpoints | null> {
  const provider = (process.env.MAIL_PROVIDER || "custom").toLowerCase();
  const authMode = (process.env.MAIL_AUTH_MODE || "app_password") as
    | "app_password"
    | "oauth2";
  const user =
    process.env.MAIL_USER ||
    process.env.SMTP_USER ||
    process.env.IMAP_USER ||
    "";
  const pass =
    process.env.MAIL_APP_PASSWORD ||
    process.env.SMTP_PASS ||
    process.env.IMAP_PASS ||
    "";
  const from =
    process.env.MAIL_FROM ||
    process.env.SMTP_FROM ||
    (user ? `${companyDisplayName()} <${user}>` : "");

  let accessToken: string | undefined;
  if (authMode === "oauth2" && provider === "gmail") {
    accessToken = (await fetchGoogleAccessToken()) || undefined;
    if (!accessToken || !user) return null;
  }

  if (provider === "gmail") {
    if (authMode === "app_password" && (!user || !pass)) return null;
    return {
      smtpHost: process.env.GMAIL_SMTP_HOST || "smtp.gmail.com",
      smtpPort: Number(process.env.GMAIL_SMTP_PORT || 587),
      smtpSecure: process.env.GMAIL_SMTP_SECURE === "true",
      imapHost: process.env.GMAIL_IMAP_HOST || "imap.gmail.com",
      imapPort: Number(process.env.GMAIL_IMAP_PORT || 993),
      imapSecure: process.env.GMAIL_IMAP_SECURE !== "false",
      user,
      pass: authMode === "app_password" ? pass : undefined,
      accessToken,
      from,
      authMode,
    };
  }

  if (provider === "yandex") {
    if (!user || !pass) return null;
    return {
      smtpHost: process.env.YANDEX_SMTP_HOST || "smtp.yandex.ru",
      smtpPort: Number(process.env.YANDEX_SMTP_PORT || 465),
      smtpSecure: process.env.YANDEX_SMTP_SECURE !== "false",
      imapHost: process.env.YANDEX_IMAP_HOST || "imap.yandex.ru",
      imapPort: Number(process.env.YANDEX_IMAP_PORT || 993),
      imapSecure: process.env.YANDEX_IMAP_SECURE !== "false",
      user,
      pass,
      from,
      authMode: "app_password",
    };
  }

  const smtpHost = process.env.SMTP_HOST || "";
  if (!smtpHost || !user || !pass) return null;
  return {
    smtpHost,
    smtpPort: Number(process.env.SMTP_PORT || 587),
    smtpSecure: process.env.SMTP_SECURE === "true",
    imapHost: process.env.IMAP_HOST || "",
    imapPort: Number(process.env.IMAP_PORT || 993),
    imapSecure: process.env.IMAP_SECURE !== "false",
    user,
    pass,
    from,
    authMode: "app_password",
  };
}

function smtpAuth(ep: MailEndpoints) {
  if (ep.authMode === "oauth2" && ep.accessToken) {
    return {
      type: "OAuth2" as const,
      user: ep.user,
      accessToken: ep.accessToken,
    };
  }
  return { user: ep.user, pass: ep.pass || "" };
}

async function transporter() {
  const ep = await resolveMailEndpoints();
  if (!ep) return null;
  return {
    ep,
    tx: nodemailer.createTransport({
      host: ep.smtpHost,
      port: ep.smtpPort,
      secure: ep.smtpSecure,
      auth: smtpAuth(ep),
    }),
  };
}

/** Simple outbound rate limit (per process) */
const sentAt: number[] = [];
function emailRateOk(): boolean {
  const limit = Number(process.env.MAIL_MAX_SEND_PER_MINUTE || 30);
  const now = Date.now();
  while (sentAt.length && now - sentAt[0] > 60_000) sentAt.shift();
  if (sentAt.length >= limit) return false;
  sentAt.push(now);
  return true;
}

export async function sendQuoteRequestEmail(data: QuoteEmailPayload) {
  if (!emailRateOk()) {
    throw new Error("email_rate_limited");
  }
  const prefix = process.env.MAIL_SUBJECT_PREFIX || "Запрос ставки";
  const ref = data.deal_id ? ` Ref: ${data.deal_id}` : "";
  const subject = data.subject || `${prefix}${ref}`.trim();

  const body = [
    "Здравствуйте!",
    "",
    "Просим ставку на перевозку:",
    data.route_summary || "—",
    data.cargo_summary || "—",
    data.weight_kg != null ? `Вес: ${data.weight_kg} кг` : null,
    data.volume_m3 != null ? `Объём: ${data.volume_m3} м³` : null,
    data.ready_date ? `Готовность груза: ${data.ready_date}` : null,
    "",
    "Нужны: цена, срок, доп. сборы, срок действия ставки.",
    data.deal_id ? `Ref: ${data.deal_id}` : null,
    "",
    "С уважением,",
    companyDisplayName(),
  ]
    .filter(Boolean)
    .join("\n");

  const t = await transporter();
  if (!t) {
    const requireSmtp =
      process.env.MAIL_REQUIRE_SMTP === "true" ||
      process.env.NODE_ENV === "production";
    console.log(`[email:dev] to=${data.to}\nsubject=${subject}\n${body}`);
    if (requireSmtp) {
      throw new Error("smtp_not_configured");
    }
    return { ok: true, mode: "dev" as const };
  }
  await t.tx.sendMail({
    from: t.ep.from,
    to: data.to,
    subject,
    text: body,
  });
  return {
    ok: true,
    mode: "smtp" as const,
    provider: process.env.MAIL_PROVIDER,
    auth: t.ep.authMode,
  };
}

export async function findEmailOnDomain(
  website?: string
): Promise<string | null> {
  if (!website) return null;
  try {
    const url = website.startsWith("http") ? website : `https://${website}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const html = await res.text();
    const match = html.match(
      /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
    );
    if (!match) return null;
    const skip = ["example.com", "sentry.io", "wixpress", "schema.org"];
    const found = match.find((e) => !skip.some((s) => e.includes(s)));
    return found || null;
  } catch {
    return null;
  }
}

export interface SyncedMail {
  messageId?: string;
  from?: string;
  subject?: string;
  text?: string;
  dealId?: string;
  parsedPrice?: number;
  parsedCurrency?: string;
  etaDaysMin?: number;
  etaDaysMax?: number;
  parseSource?: "heuristic" | "llm";
}

const REF_RE =
  /Ref:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const PRICE_RE =
  /(?:цена|cost|rate|price|ставка)[^\d]{0,20}(\d[\d\s]{2,12}(?:[.,]\d{1,2})?)/i;

function extractDealId(...parts: (string | undefined)[]): string | undefined {
  for (const p of parts) {
    if (!p) continue;
    const m = p.match(REF_RE);
    if (m) return m[1];
  }
  return undefined;
}

function extractPriceHeuristic(text?: string): {
  price?: number;
  currency?: string;
} {
  if (!text) return {};
  const m = text.match(PRICE_RE);
  if (!m) return {};
  const raw = m[1].replace(/\s/g, "").replace(",", ".");
  const price = Number(raw);
  const currency = /\$|usd/i.test(text)
    ? "USD"
    : /€|eur/i.test(text)
      ? "EUR"
      : /¥|cny|rmb/i.test(text)
        ? "CNY"
        : "RUB";
  return Number.isFinite(price) ? { price, currency } : {};
}

/** Optional LLM extract via orchestrator helper endpoint / OpenAI */
export async function extractQuoteWithLlm(
  subject: string,
  text: string
): Promise<{
  price?: number;
  currency?: string;
  eta_days_min?: number;
  eta_days_max?: number;
} | null> {
  if (!process.env.OPENAI_API_KEY) return null;
  try {
    const base = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              'Extract freight quote as JSON: {"price":number|null,"currency":"RUB|USD|EUR|CNY|null","eta_days_min":number|null,"eta_days_max":number|null}. No inventing.',
          },
          {
            role: "user",
            content: `Subject: ${subject}\n\n${text.slice(0, 6000)}`,
          },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = data.choices?.[0]?.message?.content || "{}";
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function syncInboundMail(opts?: {
  limit?: number;
}): Promise<SyncedMail[]> {
  const ep = await resolveMailEndpoints();
  if (!ep?.imapHost) {
    console.log("[imap:dev] no IMAP endpoints configured");
    return [];
  }
  if (process.env.MAIL_SYNC_ENABLED === "false") {
    return [];
  }

  const auth =
    ep.authMode === "oauth2" && ep.accessToken
      ? {
          user: ep.user,
          accessToken: ep.accessToken,
        }
      : { user: ep.user, pass: ep.pass || "" };

  const client = new ImapFlow({
    host: ep.imapHost,
    port: ep.imapPort,
    secure: ep.imapSecure,
    auth,
    logger: false,
  });

  const results: SyncedMail[] = [];
  const mailbox = process.env.MAIL_IMAP_MAILBOX || "INBOX";
  const limit = opts?.limit ?? 20;

  await client.connect();
  try {
    const lock = await client.getMailboxLock(mailbox);
    try {
      const uids = await client.search({ seen: false }, { uid: true });
      const list = (Array.isArray(uids) ? uids : []).slice(-limit);
      for (const uid of list) {
        const msg = await client.fetchOne(
          uid,
          { source: true, uid: true },
          { uid: true }
        );
        if (!msg || !msg.source) continue;
        const parsed = await simpleParser(msg.source);
        const subject = parsed.subject || "";
        const text = parsed.text || "";
        const dealId = extractDealId(subject, text);
        let price: number | undefined;
        let currency: string | undefined;
        let etaMin: number | undefined;
        let etaMax: number | undefined;
        let parseSource: "heuristic" | "llm" = "heuristic";

        const h = extractPriceHeuristic(text);
        price = h.price;
        currency = h.currency;

        if (price == null || process.env.MAIL_LLM_PARSE === "true") {
          const llm = await extractQuoteWithLlm(subject, text);
          if (llm?.price != null) {
            price = llm.price;
            currency = llm.currency || currency;
            etaMin = llm.eta_days_min ?? undefined;
            etaMax = llm.eta_days_max ?? undefined;
            parseSource = "llm";
          }
        }

        const from =
          typeof parsed.from?.text === "string"
            ? parsed.from.text
            : parsed.from?.value?.[0]?.address;

        results.push({
          messageId: parsed.messageId,
          from,
          subject,
          text: text.slice(0, 8000),
          dealId,
          parsedPrice: price,
          parsedCurrency: currency,
          etaDaysMin: etaMin,
          etaDaysMax: etaMax,
          parseSource,
        });

        await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }

  return results;
}
