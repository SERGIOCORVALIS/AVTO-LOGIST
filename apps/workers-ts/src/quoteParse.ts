/**
 * Freight quote extraction from supplier email body/subject.
 * Pure heuristics — no network. Used by IMAP sync + unit tests.
 */
import { firstModelId, openaiModel } from "@alo/shared";

export type ParsedMailQuote = {
  price?: number;
  currency?: string;
  etaDaysMin?: number;
  etaDaysMax?: number;
  validUntilHours?: number;
  dealId?: string;
};

const REF_RE =
  /Ref:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

const PRICE_LABEL_RE =
  /(?:цена|стоимость|итого|тариф|ставка|фрахт|rate|price|cost|total|amount)[^\d]{0,24}(\d[\d\s\u00a0]{1,14}(?:[.,]\d{1,2})?)\s*(₽|руб\.?|rub|usd|\$|eur|€|cny|¥|rmb)?/i;

const PRICE_CURRENCY_FIRST_RE =
  /(?:usd|\$|eur|€|cny|¥|rmb|rub|₽)\s*(\d[\d\s\u00a0,]{1,14}(?:\.\d{1,2})?)/i;

const PRICE_SUFFIX_RE =
  /(\d[\d\s\u00a0]{2,14}(?:[.,]\d{1,2})?)\s*(₽|руб\.?|rub|usd|\$|eur|€|cny|¥|rmb)/i;

const ETA_RANGE_RE =
  /(?:срок|eta|transit|доставка|готовность)[^\d]{0,30}(\d{1,3})\s*[-–—]\s*(\d{1,3})\s*(?:дн|день|дня|дней|day|days)?/i;

const ETA_SINGLE_RE =
  /(?:срок|eta|transit|доставка)[^\d]{0,30}(?:около|~|примерно)?\s*(\d{1,3})\s*(?:дн|день|дня|дней|day|days)/i;

const VALID_RE =
  /(?:действ|valid|оферт)[^\d]{0,40}(\d{1,3})\s*(?:час|ч\.|h|hour)/i;

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function parseNumber(raw: string): number | undefined {
  let s = raw.replace(/[\s\u00a0]/g, "");
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) {
    s = s.replace(/,/g, "");
  } else if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else {
    s = s.replace(",", ".");
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return undefined;
  // Reject phone-like / weight-like extremes for freight quotes
  if (n < 500 || n > 50_000_000) return undefined;
  return n;
}

function currencyFromToken(tok?: string, blob?: string): string {
  const t = (tok || "").toLowerCase();
  if (t === "$" || t === "usd") return "USD";
  if (t === "€" || t === "eur") return "EUR";
  if (t === "¥" || t === "cny" || t === "rmb") return "CNY";
  if (t === "₽" || t.startsWith("руб") || t === "rub") return "RUB";
  const b = blob || "";
  // Prefer currency near the match region over whole-body scan when possible
  if (/\$|usd/i.test(b.slice(0, 80))) return "USD";
  if (/€|eur/i.test(b.slice(0, 80))) return "EUR";
  if (/¥|cny|rmb/i.test(b.slice(0, 80))) return "CNY";
  return "RUB";
}

export function extractDealId(...parts: (string | undefined)[]): string | undefined {
  for (const p of parts) {
    if (!p) continue;
    const m = p.match(REF_RE);
    if (m) return m[1];
  }
  return undefined;
}

export function parseQuoteFromMail(input: {
  subject?: string;
  text?: string;
  html?: string;
}): ParsedMailQuote {
  const subject = input.subject || "";
  const text = (input.text || "").trim() || (input.html ? stripHtml(input.html) : "");
  const blob = `${subject}\n${text}`;

  const out: ParsedMailQuote = {
    dealId: extractDealId(subject, text),
  };

  let price: number | undefined;
  let currency: string | undefined;
  const labeled = blob.match(PRICE_LABEL_RE);
  if (labeled) {
    price = parseNumber(labeled[1]);
    currency = currencyFromToken(labeled[2], labeled[0]);
  }
  if (price == null) {
    const first = blob.match(PRICE_CURRENCY_FIRST_RE);
    if (first) {
      price = parseNumber(first[1]);
      currency = currencyFromToken(first[0].trim().split(/\s/)[0], first[0]);
    }
  }
  if (price == null) {
    const suf = blob.match(PRICE_SUFFIX_RE);
    if (suf) {
      price = parseNumber(suf[1]);
      currency = currencyFromToken(suf[2], suf[0]);
    }
  }
  if (price != null) {
    out.price = price;
    out.currency = currency || "RUB";
  }

  const etaR = blob.match(ETA_RANGE_RE);
  if (etaR) {
    const a = Number(etaR[1]);
    const b = Number(etaR[2]);
    if (Number.isFinite(a) && Number.isFinite(b) && a >= 1 && b <= 120) {
      out.etaDaysMin = Math.min(a, b);
      out.etaDaysMax = Math.max(a, b);
    }
  } else {
    const etaS = blob.match(ETA_SINGLE_RE);
    if (etaS) {
      const d = Number(etaS[1]);
      if (Number.isFinite(d) && d >= 1 && d <= 120) {
        out.etaDaysMin = d;
        out.etaDaysMax = d;
      }
    }
  }

  const valid = blob.match(VALID_RE);
  if (valid) {
    const h = Number(valid[1]);
    if (Number.isFinite(h) && h >= 1 && h <= 720) out.validUntilHours = h;
  }

  return out;
}

/** First CSV segment, or OPENAI_FAST_MODEL from env. */
export function resolveOpenAiModel(raw?: string): string {
  if (raw && raw.trim()) return firstModelId(raw, openaiModel("fast"));
  return openaiModel("fast");
}
