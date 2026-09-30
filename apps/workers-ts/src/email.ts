import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { createRequire } from "module";
import {
  calcRequestScore,
  companyDisplayName,
  openaiApiKey,
  openaiBaseUrl,
  openaiChatExtras,
  openaiFetchInit,
  openaiModel,
  preClassifyInboundMail,
  proxiedFetch,
} from "@alo/shared";
import { parseQuoteFromMail } from "./quoteParse";

const requireSocks = createRequire(__filename);

let _oauthCache: { token: string; exp: number } | null = null;

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
  corridor?: string;
  transport_mode?: string;
  cargo_class?: string;
  origin_incoterm?: string;
  dest_incoterm?: string;
  incoterms?: string;
  services?: string[];
  rfq_kind?: "freight" | "sourcing" | "cabinet";
  /** Manager-corrected RFQ body from staff room — used as-is in the mail. */
  rfq_body_override?: string;
  /** Academy §35 — technical RFQ card (no client identity). */
  academy_rfq?: Record<string, unknown>;
  ask_quote_to_include?: string[];
  do_not_disclose?: string[];
  bypass_protection?: boolean;
  /** From procurement sanitize — style_supplier.md excerpt */
  _style_hint?: string;
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

async function fetchOAuthAccessToken(provider: string): Promise<string | null> {
  const clientId = process.env.MAIL_OAUTH_CLIENT_ID;
  const clientSecret = process.env.MAIL_OAUTH_CLIENT_SECRET;
  const refresh = process.env.MAIL_OAUTH_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refresh) return null;
  if (_oauthCache && _oauthCache.exp > Date.now() + 60_000) {
    return _oauthCache.token;
  }
  const defaultUrl =
    provider === "yandex"
      ? "https://oauth.yandex.ru/token"
      : "https://oauth2.googleapis.com/token";
  const tokenUrl = process.env.MAIL_OAUTH_TOKEN_URL || defaultUrl;
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
  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!data.access_token) return null;
  const ttlMs = Math.max(60, Number(data.expires_in || 3500)) * 1000;
  _oauthCache = { token: data.access_token, exp: Date.now() + ttlMs };
  return data.access_token;
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
  if (authMode === "oauth2") {
    if (provider !== "gmail" && provider !== "yandex") return null;
    accessToken = (await fetchOAuthAccessToken(provider)) || undefined;
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
    if (authMode === "app_password" && (!user || !pass)) return null;
    return {
      smtpHost: process.env.YANDEX_SMTP_HOST || "smtp.yandex.ru",
      smtpPort: Number(process.env.YANDEX_SMTP_PORT || 465),
      smtpSecure: process.env.YANDEX_SMTP_SECURE !== "false",
      imapHost: process.env.YANDEX_IMAP_HOST || "imap.yandex.ru",
      imapPort: Number(process.env.YANDEX_IMAP_PORT || 993),
      imapSecure: process.env.YANDEX_IMAP_SECURE !== "false",
      user,
      pass: authMode === "app_password" ? pass : undefined,
      accessToken,
      from,
      authMode,
    };
  }

  const smtpHost = process.env.SMTP_HOST || "";
  if (!smtpHost || !user || (authMode === "app_password" && !pass)) return null;
  return {
    smtpHost,
    smtpPort: Number(process.env.SMTP_PORT || 587),
    smtpSecure: process.env.SMTP_SECURE === "true",
    imapHost: process.env.IMAP_HOST || "",
    imapPort: Number(process.env.IMAP_PORT || 993),
    imapSecure: process.env.IMAP_SECURE !== "false",
    user,
    pass: authMode === "app_password" ? pass : undefined,
    accessToken,
    from,
    authMode,
  };
}

function mailProxyUrl(): string | undefined {
  const enabled = (process.env.PROXY_ENABLED || "").toLowerCase();
  if (enabled === "0" || enabled === "false" || enabled === "no") return undefined;
  const host = process.env.PROXY_HOST || process.env.PX6_HOST || "";
  const port = process.env.PROXY_PORT || process.env.PX6_PORT || "";
  if (!host || !port) return undefined;
  const user =
    process.env.PROXY_USERNAME ||
    process.env.PROXY_USER ||
    process.env.PX6_USER ||
    "";
  const pass =
    process.env.PROXY_PASSWORD ||
    process.env.PROXY_PASS ||
    process.env.PX6_PASS ||
    "";
  const kind = (process.env.PROXY_TYPE || "socks5").toLowerCase();
  const auth = user ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@` : "";
  if (kind.startsWith("socks")) {
    const ver = kind === "socks4" ? "socks4" : "socks5";
    return `${ver}://${auth}${host}:${port}`;
  }
  return `http://${auth}${host}:${port}`;
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
  // nodemailer resolves `socks` lazily; ensure the optional peer is loaded.
  try {
    requireSocks("socks");
  } catch {
    /* optional until PROXY_ENABLED */
  }
  const ep = await resolveMailEndpoints();
  if (!ep) return null;
  const proxy = mailProxyUrl();
  const attempts: Array<{ port: number; secure: boolean }> = [
    { port: ep.smtpPort, secure: ep.smtpSecure },
  ];
  if (ep.smtpPort === 465) {
    attempts.push({ port: 587, secure: false });
  } else if (ep.smtpPort === 587) {
    attempts.push({ port: 465, secure: true });
  }
  let lastErr: unknown;
  for (const viaProxy of proxy ? [true, false] : [false]) {
    for (const a of attempts) {
      const tx = nodemailer.createTransport({
        host: ep.smtpHost,
        port: a.port,
        secure: a.secure,
        auth: smtpAuth(ep),
        connectionTimeout: 20_000,
        greetingTimeout: 20_000,
        socketTimeout: 30_000,
        ...(viaProxy && proxy ? { proxy } : {}),
        tls: { servername: ep.smtpHost },
      } as nodemailer.TransportOptions);
      try {
        await tx.verify();
        return { ep, tx };
      } catch (e) {
        lastErr = e;
        try {
          tx.close();
        } catch {
          /* ignore */
        }
      }
    }
  }
  if (lastErr) {
    console.error(
      "[smtp] verify failed",
      lastErr instanceof Error ? lastErr.message : lastErr
    );
  }
  return null;
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
  const kind = data.rfq_kind || "freight";
  const prefix =
    data.subject ||
    (kind === "sourcing"
      ? process.env.MAIL_SOURCING_SUBJECT_PREFIX || "Запрос выкупа/подбора"
      : process.env.MAIL_SUBJECT_PREFIX || "Запрос ставки");
  const ref = data.deal_id ? ` Ref: ${data.deal_id}` : "";
  const subject = data.subject || `${prefix}${ref}`.trim();

  const incoterms =
    data.incoterms ||
    [data.origin_incoterm, data.dest_incoterm].filter(Boolean).join("-");
  const intro =
    kind === "sourcing"
      ? "Просим предложение по выкупу / подбору поставщика товара в Китае (это не запрос ставки на перевозку):"
      : "Просим ставку на перевозку:";
  const askLines =
    kind === "freight" && data.ask_quote_to_include?.length
      ? [
          "",
          "Просим в ответе указать:",
          ...data.ask_quote_to_include.map((x) => `— ${x}`),
        ]
      : [];
  const protectLines =
    kind === "freight" && data.do_not_disclose?.length
      ? [
          "",
          "Не раскрывать в переписке / субподряде без необходимости: " +
            data.do_not_disclose.join("; ") +
            ".",
        ]
      : [];
  const academyScope =
    kind === "freight" &&
    data.academy_rfq &&
    Array.isArray((data.academy_rfq as { scope?: string[] }).scope)
      ? [
          "",
          "Состав / плечи к котировке: " +
            ((data.academy_rfq as { scope: string[] }).scope || [])
              .slice(0, 10)
              .join(" → "),
        ]
      : [];
  const closer =
    kind === "sourcing"
      ? "Нужны: цена товара/услуги, срок, условия оплаты, MOQ."
      : data.ask_quote_to_include?.length
        ? "Нужны: цена, срок, local charges, free time, валидность, включено/исключено, НДС/валюта."
        : "Нужны: цена, срок, доп. сборы, срок действия ставки.";
  const override =
    typeof data.rfq_body_override === "string" && data.rfq_body_override.trim()
      ? data.rfq_body_override.trim()
      : "";
  const factsBody = override
    ? [
        "Здравствуйте!",
        "",
        override,
        "",
        closer,
        data.deal_id ? `Ref: ${data.deal_id}` : null,
        "",
        "С уважением,",
        companyDisplayName(),
      ]
        .filter(Boolean)
        .join("\n")
    : [
        "Здравствуйте!",
        "",
        intro,
        data.route_summary || "—",
        data.cargo_summary || "—",
        data.corridor ? `Коридор: ${data.corridor}` : null,
        data.transport_mode ? `Режим: ${data.transport_mode}` : null,
        data.cargo_class ? `Тип груза: ${data.cargo_class}` : null,
        incoterms ? `Incoterms: ${incoterms}` : null,
        data.services?.length ? `Услуги: ${data.services.join(", ")}` : null,
        data.weight_kg != null ? `Вес: ${data.weight_kg} кг` : null,
        data.volume_m3 != null ? `Объём: ${data.volume_m3} м³` : null,
        data.ready_date ? `Готовность груза: ${data.ready_date}` : null,
        ...academyScope,
        ...askLines,
        ...protectLines,
        "",
        closer,
        data.deal_id ? `Ref: ${data.deal_id}` : null,
        "",
        "С уважением,",
        companyDisplayName(),
      ]
        .filter(Boolean)
        .join("\n");

  const drafted = await draftRfqBodyWithGpt({
    factsBody,
    styleHint: data._style_hint,
    kind: kind === "cabinet" ? "freight" : kind,
  });
  const body = scrubRfqPartyLeaks(drafted || factsBody);

  const t = await transporter();
  if (!t) {
    const requireSmtp =
      process.env.MAIL_REQUIRE_SMTP === "true" ||
      process.env.NODE_ENV === "production" ||
      (process.env.MAIL_PROVIDER || "").toLowerCase() === "yandex";
    console.log(`[email:dev] to=${data.to}\nsubject=${subject}\n${body}`);
    if (requireSmtp) {
      throw new Error("smtp_not_configured");
    }
    return { ok: true, mode: "dev" as const, gpt_draft: Boolean(drafted) };
  }
  const info = await t.tx.sendMail({
    from: t.ep.from,
    to: data.to,
    subject,
    text: body,
  });
  console.log(
    `[email:smtp] to=${data.to} subject=${subject} id=${info.messageId || ""} gpt=${Boolean(drafted)}`
  );
  return {
    ok: true,
    mode: "smtp" as const,
    provider: process.env.MAIL_PROVIDER,
    auth: t.ep.authMode,
    messageId: info.messageId,
    gpt_draft: Boolean(drafted),
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
  headers?: Record<string, string | string[] | undefined>;
}

function mailLlmDraftEnabled(): boolean {
  const v = (process.env.MAIL_LLM_DRAFT || "true").toLowerCase().trim();
  return !["0", "false", "off", "no"].includes(v);
}

function mailLlmInboundEnabled(): boolean {
  const v = (process.env.MAIL_LLM_INBOUND || "true").toLowerCase().trim();
  return !["0", "false", "off", "no"].includes(v);
}

/** Strip consignee/client party labels that GPT may re-introduce into RFQ bodies. */
export function scrubRfqPartyLeaks(text: string): string {
  let out = String(text || "");
  out = out.replace(
    /\b(получатель|грузополучатель|грузоотправитель|consignee|shipper|receiver|клиент|заказчик)\s*[:=]\s*[^\n;,]+/gi,
    "$1: [скрыто]"
  );
  out = out.replace(
    /\b(получатель|грузополучатель|consignee)\s+[«"]?[А-ЯA-Z][^.\n;,]{2,60}/gi,
    "$1 [скрыто]"
  );
  return out;
}

/** Polish RFQ body with GPT in supplier tone; keeps factual lines. */
export async function draftRfqBodyWithGpt(opts: {
  factsBody: string;
  styleHint?: string;
  kind: "freight" | "sourcing" | "cabinet";
}): Promise<string | null> {
  if (!mailLlmDraftEnabled() || !openaiApiKey()) return null;
  try {
    const model = openaiModel("fast");
    const base = openaiBaseUrl();
    const style = (opts.styleHint || "").slice(0, 2500);
    const res = await proxiedFetch(
      `${base}/chat/completions`,
      openaiFetchInit({
        method: "POST",
        headers: {
          Authorization: `Bearer ${openaiApiKey()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          ...openaiChatExtras(model, { temperature: 0.2 }),
          messages: [
            {
              role: "system",
              content: [
                "Ты экспедитор ЖД Трансинвест. Перепиши запрос ставки/выкупа поставщику живым деловым письмом.",
                "Сохрани ВСЕ факты (маршрут, груз, вес, Ref, ask-list). Не добавляй цену и не раскрывай клиента.",
                "Запрещено: имена получателя/клиента/грузоотправителя, ИНН клиента, завод ).",
                "Только текст письма, без markdown и без темы.",
                style ? `\nСтиль из архива:\n${style}` : "",
              ].join("\n"),
            },
            {
              role: "user",
              content: `Тип: ${opts.kind}\n\nЧерновик:\n${opts.factsBody.slice(0, 5000)}`,
            },
          ],
        }),
      })
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const out = scrubRfqPartyLeaks((data.choices?.[0]?.message?.content || "").trim());
    return out.length > 40 ? out.slice(0, 8000) : null;
  } catch {
    return null;
  }
}

export async function sendClientReplyEmail(opts: {
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string;
}): Promise<{ ok: boolean; mode: string; messageId?: string }> {
  if (!emailRateOk()) throw new Error("email_rate_limited");
  const t = await transporter();
  const text = opts.body.trim();
  if (!t) {
    console.log(`[email:dev] client-reply to=${opts.to}\n${opts.subject}\n${text}`);
    return { ok: true, mode: "dev" };
  }
  const info = await t.tx.sendMail({
    from: t.ep.from,
    to: opts.to,
    subject: opts.subject.startsWith("Re:") ? opts.subject : `Re: ${opts.subject}`,
    text,
    ...(opts.inReplyTo
      ? { headers: { "In-Reply-To": opts.inReplyTo, References: opts.inReplyTo } }
      : {}),
  });
  return { ok: true, mode: "smtp", messageId: info.messageId };
}

/** Deterministic + GPT classify. Never opens a client deal for newsletters/service mail. */
export async function classifyInboundMailWithGpt(opts: {
  from?: string;
  subject?: string;
  text?: string;
  headers?: Record<string, string | string[] | undefined>;
  hasDealRef: boolean;
  hasPrice: boolean;
}): Promise<"supplier_quote" | "supplier_other" | "client" | "noise" | null> {
  const fromAddr = extractAddress(opts.from) || opts.from || "";
  const pre = preClassifyInboundMail({
    fromEmail: fromAddr,
    subject: opts.subject || "",
    body: opts.text || "",
    headers: opts.headers,
    hasDealRef: opts.hasDealRef,
  });
  if (pre) {
    console.log(`[imap] preclassify ${pre.kind}: ${pre.reason} subj=${opts.subject || ""}`);
    return "noise";
  }

  if (!mailLlmInboundEnabled() || !openaiApiKey()) {
    if (opts.hasDealRef && opts.hasPrice) return "supplier_quote";
    if (opts.hasDealRef) return "supplier_other";
    const calc = calcRequestScore(opts.subject || "", opts.text || "");
    return calc.isCalc ? "client" : "noise";
  }
  try {
    const model = openaiModel("fast");
    const base = openaiBaseUrl();
    const res = await proxiedFetch(
      `${base}/chat/completions`,
      openaiFetchInit({
        method: "POST",
        headers: {
          Authorization: `Bearer ${openaiApiKey()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          ...openaiChatExtras(model, { temperature: 0 }),
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                'Classify inbound logistics email. JSON: {"kind":"supplier_quote"|"supplier_other"|"client"|"noise"}. supplier_quote=has freight price/rate for a deal. client=shipper asking for a freight calc. noise=newsletter/spam/bank/post/fuel/SaaS/system notify/service provider — NOT a deal.',
            },
            {
              role: "user",
              content: `hasDealRef=${opts.hasDealRef} hasPrice=${opts.hasPrice}\nFrom: ${opts.from || ""}\nSubject: ${opts.subject || ""}\n\n${(opts.text || "").slice(0, 4000)}`,
            },
          ],
        }),
      })
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = JSON.parse(data.choices?.[0]?.message?.content || "{}") as {
      kind?: string;
    };
    const k = String(raw.kind || "");
    if (
      k === "supplier_quote" ||
      k === "supplier_other" ||
      k === "client" ||
      k === "noise"
    ) {
      if (k === "client") {
        const calc = calcRequestScore(opts.subject || "", opts.text || "");
        if (!calc.isCalc && !opts.hasDealRef) {
          console.log(`[imap] gpt=client but weak calc → noise subj=${opts.subject || ""}`);
          return "noise";
        }
      }
      return k;
    }
    return null;
  } catch {
    return null;
  }
}

export function extractAddress(from?: string): string | undefined {
  if (!from) return undefined;
  const m = from.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return m?.[0]?.toLowerCase();
}

/** Optional LLM extract via OpenAI — fills gaps left by heuristics. */
export async function extractQuoteWithLlm(
  subject: string,
  text: string
): Promise<{
  price?: number;
  currency?: string;
  eta_days_min?: number;
  eta_days_max?: number;
} | null> {
  if (!openaiApiKey()) return null;
  try {
    const base = openaiBaseUrl();
    const model = openaiModel("fast");
    const res = await proxiedFetch(
      `${base}/chat/completions`,
      openaiFetchInit({
        method: "POST",
        headers: {
          Authorization: `Bearer ${openaiApiKey()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          ...openaiChatExtras(model, { temperature: 0 }),
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
      })
    );
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

  const proxy = mailProxyUrl();
  const proxyOrder: Array<string | undefined> = proxy ? [proxy, undefined] : [undefined];
  let client: ImapFlow | null = null;
  let lastErr: unknown;
  for (const p of proxyOrder) {
    const c = new ImapFlow({
      host: ep.imapHost,
      port: ep.imapPort,
      secure: ep.imapSecure,
      auth,
      logger: false,
      ...(p ? { proxy: p } : {}),
    });
    c.on("error", (err) => {
      console.error("[imap] socket", err instanceof Error ? err.message : err);
    });
    try {
      await c.connect();
      client = c;
      if (p) console.log("[imap] connected via SOCKS");
      break;
    } catch (e) {
      lastErr = e;
      try {
        c.close();
      } catch {
        /* ignore */
      }
    }
  }
  if (!client) {
    console.error(
      "[imap] connect failed",
      lastErr instanceof Error ? lastErr.message : lastErr
    );
    return [];
  }

  const results: SyncedMail[] = [];
  const mailbox = process.env.MAIL_IMAP_MAILBOX || "INBOX";
  const limit = opts?.limit ?? 20;

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
        const html =
          typeof parsed.html === "string" ? parsed.html : undefined;
        const h = parseQuoteFromMail({ subject, text, html });
        let price = h.price;
        let currency = h.currency;
        let etaMin = h.etaDaysMin;
        let etaMax = h.etaDaysMax;
        let parseSource: "heuristic" | "llm" = "heuristic";
        const dealId = h.dealId;

        const needLlm =
          process.env.MAIL_LLM_PARSE === "true" &&
          (price == null || etaMin == null);
        if (needLlm) {
          const llm = await extractQuoteWithLlm(subject, text || html || "");
          if (llm?.price != null && price == null) {
            price = llm.price;
            currency = llm.currency || currency;
            parseSource = "llm";
          }
          if (llm?.eta_days_min != null && etaMin == null) {
            etaMin = llm.eta_days_min ?? undefined;
            etaMax = llm.eta_days_max ?? etaMin;
            if (price != null) parseSource = parseSource === "llm" ? "llm" : "heuristic";
          }
        }

        const from =
          typeof parsed.from?.text === "string"
            ? parsed.from.text
            : parsed.from?.value?.[0]?.address;

        const headers: Record<string, string | string[] | undefined> = {};
        try {
          const rawHeaders = parsed.headers;
          if (rawHeaders && typeof rawHeaders.get === "function") {
            for (const key of [
              "list-id",
              "list-unsubscribe",
              "precedence",
              "x-mailer",
              "x-campaign",
              "auto-submitted",
            ]) {
              const v = rawHeaders.get(key);
              if (v != null) headers[key] = Array.isArray(v) ? v.map(String) : String(v);
            }
          }
        } catch {
          /* ignore */
        }

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
          headers,
        });

        await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
      }
    } finally {
      lock.release();
    }
  } catch (e) {
    console.error("[imap] sync failed", e instanceof Error ? e.message : e);
  } finally {
    try {
      await client.logout();
    } catch {
      try {
        client.close();
      } catch {
        /* ignore */
      }
    }
  }

  return results;
}
