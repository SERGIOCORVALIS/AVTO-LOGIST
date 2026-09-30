import { Api, TelegramClient } from "telegram";
import {
  classifyOfficeFile,
  extractOfficeText,
  openaiApiKey,
  openaiBaseUrl,
  openaiChatExtras,
  openaiFetchInit,
  openaiModel,
  openaiTranscribeModel,
  proxiedFetch,
} from "@alo/shared";

const MAX_VISION_BYTES = 18 * 1024 * 1024;
const MAX_AUDIO_BYTES = 24 * 1024 * 1024;

export type InboundMediaKind =
  | "photo"
  | "image"
  | "pdf"
  | "word"
  | "excel"
  | "voice"
  | "audio";

export interface InboundMedia {
  buffer: Buffer;
  contentType: string;
  filename: string;
  kind: InboundMediaKind;
}

export function documentFilename(doc: Api.Document): string {
  for (const attr of doc.attributes || []) {
    if (attr instanceof Api.DocumentAttributeFilename) {
      return String(attr.fileName || "");
    }
  }
  return "";
}

function isStickerOrAnimated(doc: Api.Document): boolean {
  return (doc.attributes || []).some(
    (attr) =>
      attr instanceof Api.DocumentAttributeSticker ||
      attr instanceof Api.DocumentAttributeAnimated
  );
}

function audioKind(doc: Api.Document): "voice" | "audio" | null {
  for (const attr of doc.attributes || []) {
    if (attr instanceof Api.DocumentAttributeAudio) {
      return attr.voice ? "voice" : "audio";
    }
  }
  const mime = String(doc.mimeType || "").toLowerCase();
  const name = documentFilename(doc).toLowerCase();
  if (
    mime.startsWith("audio/") ||
    mime === "application/ogg" ||
    /\.(ogg|opus|mp3|m4a|wav|flac|oga)$/.test(name)
  ) {
    return "audio";
  }
  return null;
}

function isRoundVideo(doc: Api.Document): boolean {
  return (doc.attributes || []).some(
    (attr) =>
      attr instanceof Api.DocumentAttributeVideo &&
      Boolean((attr as { roundMessage?: boolean }).roundMessage)
  );
}

export function primaryChatModel(): string {
  return openaiModel("main");
}

export function classifyTelegramMedia(message: {
  photo?: unknown;
  document?: Api.Document;
  media?: unknown;
}): InboundMediaKind | null {
  if (message.photo || message.media instanceof Api.MessageMediaPhoto) return "photo";
  const doc = message.document;
  if (!doc || isStickerOrAnimated(doc) || isRoundVideo(doc)) return null;
  const spoken = audioKind(doc);
  if (spoken) return spoken;
  const mime = String(doc.mimeType || "").toLowerCase();
  const name = documentFilename(doc).toLowerCase();
  if (mime === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  const office = classifyOfficeFile(name, mime);
  if (office) return office;
  if (mime.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/.test(name)) return "image";
  return null;
}

export async function downloadInboundMedia(
  client: TelegramClient,
  message: Api.Message
): Promise<InboundMedia | null> {
  const mediaDoc =
    message.media instanceof Api.MessageMediaDocument &&
    message.media.document instanceof Api.Document
      ? message.media.document
      : undefined;
  const kind = classifyTelegramMedia({
    photo: message.photo,
    document: message.document || mediaDoc,
    media: message.media,
  });
  if (!kind) return null;
  const raw = await client.downloadMedia(message, {});
  if (!raw || typeof raw === "string") return null;
  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  if (!buffer.length) return null;

  const doc = message.document || mediaDoc;
  const mime = doc ? String(doc.mimeType || "") : "";
  const filename =
    (doc ? documentFilename(doc) : "") ||
    (kind === "pdf"
      ? "file.pdf"
      : kind === "word"
        ? "file.docx"
        : kind === "excel"
          ? "file.xlsx"
          : kind === "voice"
            ? "voice.ogg"
            : kind === "audio"
              ? "audio.ogg"
              : "photo.jpg");
  const contentType =
    kind === "photo"
      ? "image/jpeg"
      : kind === "voice" || kind === "audio"
        ? mime || "audio/ogg"
        : kind === "word"
          ? mime || "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          : kind === "excel"
            ? mime || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            : mime || (kind === "pdf" ? "application/pdf" : "image/jpeg");

  return { buffer, contentType, filename, kind };
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

export async function transcribeAudio(
  buf: Buffer,
  filename: string,
  contentType: string
): Promise<string | null> {
  const key = openaiApiKey();
  if (!key) {
    console.warn("[media] transcribe skipped: OPENAI_API_KEY empty");
    return null;
  }
  if (buf.length > MAX_AUDIO_BYTES) {
    console.warn("[media] transcribe skipped: audio too large", { bytes: buf.length });
    return null;
  }
  const base = openaiBaseUrl();
  const models = [
    openaiTranscribeModel(),
    "whisper-1",
    "gpt-4o-mini-transcribe",
  ].filter((m, i, a) => m && a.indexOf(m) === i);

  const tryOne = async (model: string): Promise<string | null> => {
    const form = new FormData();
    const blob = new Blob([new Uint8Array(buf)], {
      type: contentType || "audio/ogg",
    });
    form.append("file", blob, filename || "voice.ogg");
    form.append("model", model);
    form.append("response_format", "json");
    // whisper-1 uses `language`; newer models accept `languages` as JSON array in some versions —
    // keep whisper-compatible hint that also helps gpt-transcribe when supported.
    if (model === "whisper-1") {
      form.append("language", "ru");
    } else {
      form.append("prompt", "Логистика, перевозки, города России, вес, груз, ставка, контейнер.");
    }
    const res = await proxiedFetch(
      `${base}/audio/transcriptions`,
      openaiFetchInit({
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: form,
      })
    );
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      console.warn("[media] transcribe failed", {
        model,
        status: res.status,
        body: errBody.slice(0, 400),
      });
      return null;
    }
    const data = (await res.json()) as { text?: string };
    const text = data.text?.trim() || null;
    if (text) console.log("[media] transcribed", { model, chars: text.length });
    return text;
  };

  for (const model of models) {
    try {
      const text = await tryOne(model);
      if (text) return text;
    } catch (err) {
      console.warn(
        "[media] transcribe error",
        model,
        err instanceof Error ? err.message : err
      );
    }
  }
  return null;
}

export async function visionDescribe(buf: Buffer, contentType: string): Promise<string | null> {
  const key = openaiApiKey();
  if (!key) return null;
  if (buf.length > MAX_VISION_BYTES) return null;
  const model = openaiModel("document");
  const base = openaiBaseUrl();
  const mime = contentType.startsWith("image/") ? contentType : "image/jpeg";
  const extra = openaiChatExtras(model, { temperature: 0 });
  try {
    const res = await proxiedFetch(
      `${base}/chat/completions`,
      openaiFetchInit({
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          ...extra,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text:
                    "Клиент логистики прислал фото в личку (перевозки по РФ или импорт из Китая). " +
                    "Если на фото текст (инвойс, спецификация, packing list, этикетка, скриншот, переписка) — извлеки весь текст: " +
                    "наименование товара, описание, количество, сумма и валюта, вес, габариты, города отправления/доставки, дату готовности если есть. " +
                    "Если это товар/упаковка — коротко опиши что это, материал, количество, видимые размеры. " +
                    "Ответ на русском связным текстом без markdown. Не выдумывай то, чего нет на фото.",
                },
                {
                  type: "image_url",
                  image_url: { url: `data:${mime};base64,${buf.toString("base64")}` },
                },
              ],
            },
          ],
        }),
      })
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch {
    return null;
  }
}

export async function describeInboundMedia(media: InboundMedia): Promise<string | null> {
  if (media.kind === "pdf") {
    const text = extractPdfText(media.buffer);
    return text || null;
  }
  if (media.kind === "word" || media.kind === "excel") {
    return extractOfficeText(media.buffer, media.filename, media.contentType);
  }
  if (media.kind === "voice" || media.kind === "audio") {
    return transcribeAudio(media.buffer, media.filename, media.contentType);
  }
  return visionDescribe(media.buffer, media.contentType);
}

export function composeInboundText(opts: {
  caption: string;
  media?: InboundMedia | null;
  extracted?: string | null;
  /** staff = managers in work room; client = private DM */
  audience?: "client" | "staff";
}): string {
  const caption = opts.caption.trim();
  if (!opts.media) return caption;

  const audience = opts.audience || "client";
  const label =
    opts.media.kind === "pdf"
      ? "документ PDF"
      : opts.media.kind === "word"
        ? "документ Word"
        : opts.media.kind === "excel"
          ? "таблицу Excel"
          : opts.media.kind === "image"
            ? "файл-изображение"
            : opts.media.kind === "voice"
              ? "голосовое сообщение"
              : opts.media.kind === "audio"
                ? "аудиофайл"
                : "фото";

  // Staff voice: prefer plain transcript so peer intents parse cleanly.
  if (
    audience === "staff" &&
    (opts.media.kind === "voice" || opts.media.kind === "audio")
  ) {
    if (opts.extracted?.trim()) {
      return [opts.extracted.trim(), caption ? `(подпись: ${caption})` : ""]
        .filter(Boolean)
        .join("\n");
    }
    return (
      caption ||
      "Не удалось распознать голосовое. Напишите текстом или пришлите голосовое ещё раз."
    );
  }

  const who = audience === "staff" ? "Коллега прислал" : "Клиент прислал";
  const parts: string[] = [`${who} ${label} (${opts.media.filename}).`];
  if (caption) parts.push(`Подпись: ${caption}`);
  if (opts.extracted) {
    const prefix =
      opts.media.kind === "voice" || opts.media.kind === "audio"
        ? "Расшифровка речи"
        : "Содержимое";
    parts.push(`${prefix}:\n${opts.extracted}`);
  } else if (opts.media.kind === "voice" || opts.media.kind === "audio") {
    parts.push(
      "Не удалось распознать речь. Попроси коротко повторить текстом: что везём, откуда и куда."
    );
  } else {
    parts.push(
      "Распознать содержимое не удалось. Попроси прислать более чёткий снимок или написать текстом: что за груз, вес, инвойс, откуда и куда."
    );
  }
  return parts.join("\n");
}
