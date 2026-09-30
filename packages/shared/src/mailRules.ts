/**
 * Shared mail classification — used by live IMAP and archive ingest.
 */
export type MailRole =
  | "client"
  | "supplier"
  | "service_provider"
  | "internal"
  | "other"
  | "newsletter";

export type ServiceCategory =
  | "post"
  | "fuel"
  | "glonass"
  | "tracking"
  | "telecom"
  | "bank"
  | "it_saas"
  | "other_service";

export type AttachmentKind =
  | "kp"
  | "contracts"
  | "invoices"
  | "payments"
  | "customs"
  | "client"
  | "other";

export const FREIGHT_SUPPLIER_HINTS = [
  "fesco",
  "pek.ru",
  "dhl.",
  "dpd.",
  "cdek",
  "trcont",
  "transcontainer",
  "maersk",
  "cosco",
  "evergreen",
  "dellin",
  "baikalsr",
  "kit.ru",
  "jde.ru",
];

export const SERVICE_PROVIDER_RULES: Array<{
  category: ServiceCategory;
  name: string;
  domains: string[];
  keywords: RegExp;
}> = [
  {
    category: "post",
    name: "Почта России",
    domains: ["pochta.ru", "russianpost.ru"],
    keywords: /почта\s*росси|pochta\.ru|russian\s*post/i,
  },
  {
    category: "fuel",
    name: "Топливные карты",
    domains: ["ppr.ru", "gpnbonus.ru", "petrolplus.ru", "lukoil.ru"],
    keywords: /топливн\w*\s*карт|ппр\b|газпромнефть.*карт|petrol\s*plus|лукойл.*карт/i,
  },
  {
    category: "glonass",
    name: "ГЛОНАСС / мониторинг",
    domains: ["glonass.ru", "fort-monitor.ru", "wialon.com"],
    keywords: /глонасс|glonass|wialon|мониторинг\s*транспорт|форт.?монитор/i,
  },
  {
    category: "tracking",
    name: "Трекинг / телематика",
    domains: ["scout-gps.ru", "autotracker.ru"],
    keywords: /телематик|gps.?трек|автотрек/i,
  },
  {
    category: "telecom",
    name: "Телефония / связь",
    domains: [
      "beeline.ru",
      "mts.ru",
      "megafon.ru",
      "tele2.ru",
      "zadarma.com",
      "mango-office.ru",
    ],
    keywords: /билайн|beeline|мтс\b|megafon|мегафон|теле2|sip.?телефон|задарма|манго.?офис/i,
  },
  {
    category: "bank",
    name: "Банк / эквайринг",
    domains: ["tochka.com", "tinkoff.ru", "sberbank.ru", "modulbank.ru"],
    keywords: /банк\s*точка|tochka\.com|тинькофф|сбербанк|выписк|эквайринг/i,
  },
  {
    category: "it_saas",
    name: "IT / SaaS",
    domains: [
      "bitrix24.ru",
      "1c.ru",
      "yandex.ru",
      "timeweb.ru",
      "reg.ru",
      "google.com",
    ],
    keywords: /bitrix|битрикс|1[сc]\b|яндекс\s*360|timeweb|хостинг|рассылк.*сервис/i,
  },
];

const CALC_POSITIVE =
  /расч[её]т|ставк|стоимост|тариф|перевоз|маршрут|доставк|заявк\w*\s+на\s+перевоз|сколько\s+стоит|quote|rate|freight|вагон|платформ|станци/i;

const CALC_NEGATIVE =
  /сч[её]т\s+на\s+оплат|акт\s+сверк|упд\b|сч[её]т.?фактур|банковск\w*\s+выписк|unsubscribe|отписаться|newsletter|рассылк/i;

const BUSINESS_MARKERS =
  /расч[её]т|ставк|перевоз|договор|сч[её]т|invoice|contract|груз|маршрут|заявк/i;

function headerGet(
  headers: Record<string, string | string[] | undefined> | undefined,
  k: string
): string {
  const h = headers || {};
  const v = h[k] || h[k.toLowerCase()];
  return Array.isArray(v) ? v.join(" ") : String(v || "");
}

export function matchServiceProvider(
  fromEmail: string,
  subject: string,
  body: string
): { category: ServiceCategory; name: string } | null {
  const blob = `${fromEmail} ${subject} ${body}`.toLowerCase();
  const dom = (fromEmail.split("@")[1] || "").toLowerCase();
  for (const rule of SERVICE_PROVIDER_RULES) {
    if (rule.domains.some((d) => dom === d || dom.endsWith(`.${d}`) || blob.includes(d))) {
      return { category: rule.category, name: rule.name };
    }
    if (rule.keywords.test(blob)) {
      return { category: rule.category, name: rule.name };
    }
  }
  return null;
}

export function calcRequestScore(
  subject: string,
  body: string,
  opts?: { mailboxId?: string }
): { score: number; isCalc: boolean; reasons: string[] } {
  const blob = `${subject} ${body}`;
  const reasons: string[] = [];
  let score = 0;
  if (CALC_NEGATIVE.test(blob)) {
    score -= 3;
    reasons.push("negative_doc");
  }
  if (CALC_POSITIVE.test(blob)) {
    score += 2;
    reasons.push("positive_lex");
  }
  if (
    /(из|от).{2,40}(в|до|→|->)/i.test(blob) ||
    /[А-Яа-я]{3,}\s*[-–—→]\s*[А-Яа-я]{3,}/.test(blob)
  ) {
    score += 1;
    reasons.push("route");
  }
  if (/\d+\s*(кг|т|м³|м3|мест)/i.test(blob)) {
    score += 1;
    reasons.push("cargo_qty");
  }
  if (
    opts?.mailboxId === "rzd-perevoz" &&
    /ж[\s/.-]*д|вагон|платформ|станци|ржд/i.test(blob)
  ) {
    score += 1;
    reasons.push("rzd_lex");
  }
  return { score, isCalc: score >= 2, reasons };
}

export function looksLikeNewsletter(opts: {
  fromEmail: string;
  subject: string;
  body: string;
  headers?: Record<string, string | string[] | undefined>;
}): { yes: boolean; reason: string } {
  const listId = headerGet(opts.headers, "list-id") || headerGet(opts.headers, "List-Id");
  const listUnsub =
    headerGet(opts.headers, "list-unsubscribe") ||
    headerGet(opts.headers, "List-Unsubscribe");
  const precedence = (
    headerGet(opts.headers, "precedence") || headerGet(opts.headers, "Precedence")
  ).toLowerCase();
  const xmailer =
    headerGet(opts.headers, "x-mailer") || headerGet(opts.headers, "X-Mailer");
  const calc = calcRequestScore(opts.subject, opts.body);

  // Live IMAP: list headers without a real calc request → newsletter even if
  // body casually mentions «тариф/перевозка» (promo mail).
  if ((listId || listUnsub) && !calc.isCalc) {
    return { yes: true, reason: "list_headers" };
  }
  if (listId || listUnsub) {
    if (!BUSINESS_MARKERS.test(`${opts.subject} ${opts.body}`)) {
      return { yes: true, reason: "list_headers" };
    }
  }
  if (/bulk|list/.test(precedence)) {
    return { yes: true, reason: "precedence_bulk" };
  }
  if (/mailchimp|sendgrid|unisender|getsresponse|daemon/i.test(xmailer)) {
    return { yes: true, reason: "bulk_mailer" };
  }
  const from = opts.fromEmail.toLowerCase();
  if (/noreply|no-reply|mailer-daemon|newsletter|notify@|donotreply/i.test(from)) {
    if (!calc.isCalc && !BUSINESS_MARKERS.test(`${opts.subject} ${opts.body}`)) {
      return { yes: true, reason: "noreply_from" };
    }
    if (!calc.isCalc && /отписаться|unsubscribe|рассылк|newsletter/i.test(`${opts.subject} ${opts.body}`)) {
      return { yes: true, reason: "noreply_promo" };
    }
  }
  const blob = `${opts.subject} ${opts.body}`.toLowerCase();
  if (/отписаться|unsubscribe|newsletter|рассылк/.test(blob) && !calc.isCalc) {
    if (!BUSINESS_MARKERS.test(blob) || /отписаться|unsubscribe/.test(blob)) {
      return { yes: true, reason: "unsubscribe_lex" };
    }
  }
  const dom = from.split("@")[1] || "";
  if (
    /^(accounts\.google\.com|google\.com|yandex\.ru|mail\.ru)$/i.test(dom) &&
    /безопасн|security|verification|подтвержден|уведомлен/i.test(blob)
  ) {
    return { yes: true, reason: "system_notify" };
  }
  return { yes: false, reason: "" };
}

/**
 * Deterministic gate for live IMAP before GPT / deal creation.
 * Returns noise|service when the message must not open a client deal.
 */
export function preClassifyInboundMail(opts: {
  fromEmail: string;
  subject: string;
  body: string;
  headers?: Record<string, string | string[] | undefined>;
  hasDealRef?: boolean;
}): { kind: "noise" | "service"; reason: string } | null {
  const from = (opts.fromEmail || "").toLowerCase();
  const nl = looksLikeNewsletter({
    fromEmail: from,
    subject: opts.subject || "",
    body: opts.body || "",
    headers: opts.headers,
  });
  if (nl.yes) return { kind: "noise", reason: nl.reason };

  const svc = matchServiceProvider(from, opts.subject || "", opts.body || "");
  if (svc && !opts.hasDealRef) {
    const calc = calcRequestScore(opts.subject || "", opts.body || "");
    if (!calc.isCalc) {
      return { kind: "service", reason: `${svc.category}:${svc.name}` };
    }
  }
  return null;
}

export function classifyAttachmentKind(
  filename: string,
  contentType: string
): AttachmentKind {
  const name = (filename || "").toLowerCase();
  const ct = (contentType || "").toLowerCase();
  if (/договор|contract|соглашени/.test(name)) return "contracts";
  if (
    /платеж|платёж|платежн|поручен|payment|квитанц|(^|[^a-zа-яё0-9])пп([^a-zа-яё0-9]|$)/i.test(
      name
    )
  ) {
    return "payments";
  }
  if (
    /сч[её]т|invoice|упд|счет-фактур|(^|[^a-zа-яё0-9])сф([^a-zа-яё0-9]|$)|акт\b/.test(
      name
    )
  ) {
    return "invoices";
  }
  if (/(^|[^а-яa-z])кп([^а-яa-z]|$)|расч[её]т|offer|quote|ставк/.test(name)) return "kp";
  if (/тамож|customs|гтд|\bдт\b|декларац|сертифик/.test(name)) return "customs";
  if (/pdf|word|excel|sheet|document/.test(ct) || /\.(pdf|docx?|xlsx?|xls)$/i.test(name)) {
    return "client";
  }
  return "other";
}

export function shouldSkipInlineAttachment(opts: {
  filename?: string | null;
  contentDisposition?: string | null;
  contentType?: string | null;
  size?: number;
}): boolean {
  const cd = (opts.contentDisposition || "").toLowerCase();
  const ct = (opts.contentType || "").toLowerCase();
  const name = (opts.filename || "").trim();
  const size = opts.size || 0;
  if (cd.includes("inline") && !name && size < 20_000) return true;
  if (/^image\//.test(ct) && size < 20_000 && !name) return true;
  return false;
}
