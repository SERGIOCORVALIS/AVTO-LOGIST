import { readFile } from "fs/promises";
import type { Pool } from "pg";

export interface OcrJobData {
  deal_id: string;
  attachment_id: string;
  path: string;
  key?: string;
  storage?: string;
  content_type?: string;
  filename?: string;
}

export interface InvoiceParseResult {
  invoice_value?: number;
  invoice_currency?: string;
  weight_kg?: number;
  length_cm?: number;
  width_cm?: number;
  height_cm?: number;
  quantity?: number;
  ocr_text: string;
  parse_source: "regex" | "llm" | "pdf_text" | "empty";
}

function extractPdfText(buf: Buffer): string {
  const raw = buf.toString("latin1");
  const chunks: string[] = [];
  const tj = /\((?:\\.|[^\\)])*\)\s*Tj/g;
  let m: RegExpExecArray | null;
  while ((m = tj.exec(raw))) {
    const inner = m[0]
      .replace(/\s*Tj$/, "")
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\([\\()])/g, "$1");
    if (inner.trim()) chunks.push(inner);
  }
  const tjArr = /\[(.*?)\]\s*TJ/gs;
  while ((m = tjArr.exec(raw))) {
    const parts = m[1].match(/\((?:\\.|[^\\)])*\)/g) || [];
    for (const p of parts) {
      const inner = p
        .slice(1, -1)
        .replace(/\\n/g, "\n")
        .replace(/\\([\\()])/g, "$1");
      if (inner.trim()) chunks.push(inner);
    }
  }
  return chunks.join(" ").replace(/\s+/g, " ").trim();
}

function currencyFromToken(tok?: string | null): string {
  const curTok = (tok || "usd").toLowerCase();
  if (curTok.includes("eur") || curTok === "€") return "EUR";
  if (
    curTok.includes("cny") ||
    curTok.includes("yuan") ||
    curTok === "¥" ||
    curTok.includes("rmb")
  )
    return "CNY";
  if (curTok.includes("rub") || curTok === "₽" || curTok.includes("руб")) return "RUB";
  return "USD";
}

function parseInvoiceFields(text: string): Omit<InvoiceParseResult, "ocr_text" | "parse_source"> {
  const low = text.toLowerCase();
  const out: Omit<InvoiceParseResult, "ocr_text" | "parse_source"> = {};

  const labeled = low.match(
    /(?:инвойс|invoice|total\s*amount|amount\s*due|стоимость|сумма|value|grand\s*total)[^\d]{0,24}(\d[\d\s]{0,12}(?:[.,]\d{1,2})?)\s*(usd|\$|eur|€|cny|rmb|yuan|¥|rub|₽|руб)?/i
  );
  const prefixed = low.match(
    /(usd|\$|eur|€|cny|¥|rub|₽)\s*(\d[\d\s]{0,12}(?:[.,]\d{1,2})?)/i
  );
  if (labeled) {
    const n = Number(labeled[1].replace(/\s/g, "").replace(",", "."));
    if (Number.isFinite(n) && n > 0) {
      out.invoice_value = n;
      out.invoice_currency = currencyFromToken(labeled[2]);
    }
  } else if (prefixed) {
    const n = Number(prefixed[2].replace(/\s/g, "").replace(",", "."));
    if (Number.isFinite(n) && n > 0) {
      out.invoice_value = n;
      out.invoice_currency = currencyFromToken(prefixed[1]);
    }
  }

  const w = low.match(/(?:gross\s*weight|net\s*weight|weight|вес)[^\d]{0,16}(\d[\d.,]{0,8})\s*(kg|кг|g|г)?/i);
  if (w) {
    let kg = Number(w[1].replace(",", "."));
    if ((w[2] || "kg").startsWith("g") || (w[2] || "") === "г") kg = kg / 1000;
    if (Number.isFinite(kg) && kg > 0) out.weight_kg = kg;
  }

  const dims = low.match(
    /(\d[\d.,]{0,6})\s*[xх×]\s*(\d[\d.,]{0,6})\s*[xх×]\s*(\d[\d.,]{0,6})\s*(cm|см|mm|мм)?/i
  );
  if (dims) {
    let l = Number(dims[1].replace(",", "."));
    let wd = Number(dims[2].replace(",", "."));
    let h = Number(dims[3].replace(",", "."));
    const unit = (dims[4] || "cm").toLowerCase();
    if (unit.startsWith("mm") || unit === "мм") {
      l /= 10;
      wd /= 10;
      h /= 10;
    }
    if ([l, wd, h].every((x) => Number.isFinite(x) && x > 0)) {
      out.length_cm = l;
      out.width_cm = wd;
      out.height_cm = h;
    }
  }

  const qty = low.match(/(?:qty|quantity|кол-?во|количество|pcs|шт)[^\d]{0,12}(\d{1,7})/i);
  if (qty) {
    const q = Number(qty[1]);
    if (Number.isFinite(q) && q > 0) out.quantity = q;
  }

  return out;
}

async function llmParseInvoice(text: string): Promise<Partial<InvoiceParseResult> | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key || !text.trim()) return null;
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
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
              "Extract invoice fields as JSON: invoice_value (number), invoice_currency (USD|EUR|CNY|RUB), weight_kg, length_cm, width_cm, height_cm, quantity. Omit unknown fields.",
          },
          { role: "user", content: text.slice(0, 12000) },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;
    return JSON.parse(content) as Partial<InvoiceParseResult>;
  } catch {
    return null;
  }
}

async function visionOcr(buf: Buffer, contentType: string): Promise<string | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const model = process.env.OPENAI_MODEL || "gpt-4o";
  const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const b64 = buf.toString("base64");
  const mime = contentType.startsWith("image/") ? contentType : "image/jpeg";
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Extract all text from this commercial invoice / packing list. Preserve numbers, currencies, weights, dimensions.",
              },
              {
                type: "image_url",
                image_url: { url: `data:${mime};base64,${b64}` },
              },
            ],
          },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return data.choices?.[0]?.message?.content || null;
  } catch {
    return null;
  }
}

async function loadBytes(data: OcrJobData): Promise<Buffer> {
  if (data.storage === "s3" && data.key) {
    const endpoint = (process.env.S3_ENDPOINT || "").replace(/\/$/, "");
    const bucket = process.env.S3_BUCKET || "";
    // Prefer local path mirror if API also wrote local; else fetch via API helper path
    if (data.path && !data.path.startsWith("s3://")) {
      try {
        return await readFile(data.path);
      } catch {
        /* fall through */
      }
    }
    const api = process.env.API_URL || "http://localhost:3000";
    const res = await fetch(`${api}/internal/attachments/bytes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: data.path,
        key: data.key,
        storage: data.storage,
      }),
    });
    if (res.ok) {
      const arr = await res.arrayBuffer();
      return Buffer.from(arr);
    }
    throw new Error(`s3_load_failed:${endpoint}/${bucket}/${data.key}`);
  }
  return readFile(data.path);
}

export async function parseInvoiceAttachment(data: OcrJobData): Promise<InvoiceParseResult> {
  const buf = await loadBytes(data);
  const ct = (data.content_type || "").toLowerCase();
  const name = (data.filename || data.path || "").toLowerCase();
  let text = "";
  let source: InvoiceParseResult["parse_source"] = "empty";

  if (ct.includes("pdf") || name.endsWith(".pdf")) {
    text = extractPdfText(buf);
    source = text ? "pdf_text" : "empty";
  } else if (ct.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/.test(name)) {
    const vision = await visionOcr(buf, ct || "image/jpeg");
    text = vision || "";
    source = text ? "llm" : "empty";
  } else {
    text = buf.toString("utf8").slice(0, 20000);
    source = text.trim() ? "regex" : "empty";
  }

  let fields = parseInvoiceFields(text);
  if (!fields.invoice_value) {
    const llm = await llmParseInvoice(text);
    if (llm) {
      fields = { ...fields, ...llm };
      source = "llm";
    } else if (Object.keys(fields).length) {
      source = source === "empty" ? "regex" : source;
    }
  } else if (source === "pdf_text" || source === "empty") {
    source = source === "empty" ? "regex" : source;
  }

  return { ...fields, ocr_text: text.slice(0, 8000), parse_source: source };
}

export async function applyOcrToDeal(pool: Pool, data: OcrJobData, parsed: InvoiceParseResult) {
  const cargoPatch: Record<string, unknown> = {};
  if (parsed.invoice_value != null) cargoPatch.invoice_value = parsed.invoice_value;
  if (parsed.invoice_currency) cargoPatch.invoice_currency = parsed.invoice_currency;
  if (parsed.weight_kg != null) cargoPatch.weight_kg = parsed.weight_kg;
  if (parsed.length_cm != null) cargoPatch.length_cm = parsed.length_cm;
  if (parsed.width_cm != null) cargoPatch.width_cm = parsed.width_cm;
  if (parsed.height_cm != null) cargoPatch.height_cm = parsed.height_cm;
  if (parsed.quantity != null) cargoPatch.quantity = parsed.quantity;

  const deal = await pool.query(`SELECT id, cargo, metadata FROM deals WHERE id = $1`, [
    data.deal_id,
  ]);
  if (!deal.rows[0]) throw new Error("deal_not_found");

  const meta = deal.rows[0].metadata || {};
  const attachments: Array<Record<string, unknown>> = Array.isArray(meta.attachments)
    ? meta.attachments
    : [];
  const nextAttachments = attachments.map((a) =>
    a.id === data.attachment_id
      ? {
          ...a,
          ocr_status: parsed.ocr_text || parsed.invoice_value ? "done" : "empty",
          ocr_text: parsed.ocr_text,
          ocr_parsed: {
            invoice_value: parsed.invoice_value,
            invoice_currency: parsed.invoice_currency,
            weight_kg: parsed.weight_kg,
            length_cm: parsed.length_cm,
            width_cm: parsed.width_cm,
            height_cm: parsed.height_cm,
            quantity: parsed.quantity,
            parse_source: parsed.parse_source,
          },
        }
      : a
  );

  await pool.query(
    `UPDATE deals SET
       cargo = COALESCE(cargo, '{}'::jsonb) || $1::jsonb,
       metadata = jsonb_set(
         jsonb_set(COALESCE(metadata, '{}'::jsonb), '{attachments}', $2::jsonb),
         '{invoice_ocr}',
         $3::jsonb
       ),
       updated_at = NOW()
     WHERE id = $4`,
    [
      JSON.stringify(cargoPatch),
      JSON.stringify(nextAttachments),
      JSON.stringify({
        attachment_id: data.attachment_id,
        ...parsed,
        at: new Date().toISOString(),
      }),
      data.deal_id,
    ]
  );
}
