import mammoth from "mammoth";
import * as XLSX from "xlsx";

const MAX_CHARS = 20_000;

export type OfficeKind = "word" | "excel";

const WORD_MIME = [
  "application/msword",
  "application/vnd.ms-word",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-word.document.macroenabled.12",
];

const EXCEL_MIME = [
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel.sheet.macroenabled.12",
  "application/vnd.ms-excel.sheet.binary.macroenabled.12",
  "text/csv",
  "application/csv",
];

export function classifyOfficeFile(filename: string, mime = ""): OfficeKind | null {
  const name = filename.toLowerCase();
  const ct = mime.toLowerCase();
  if (
    name.endsWith(".docx") ||
    name.endsWith(".doc") ||
    name.endsWith(".rtf") ||
    WORD_MIME.some((m) => ct.includes(m) || ct === m)
  ) {
    return "word";
  }
  if (
    name.endsWith(".xlsx") ||
    name.endsWith(".xls") ||
    name.endsWith(".xlsm") ||
    name.endsWith(".xlsb") ||
    name.endsWith(".csv") ||
    EXCEL_MIME.some((m) => ct.includes(m) || ct === m)
  ) {
    return "excel";
  }
  return null;
}

function clip(text: string): string {
  const t = text.replace(/\u0000/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (t.length <= MAX_CHARS) return t;
  return `${t.slice(0, MAX_CHARS)}\n…`;
}

function extractLegacyDoc(buf: Buffer): string {
  const as16 = buf.toString("utf16le");
  const runs = as16.match(/[\t\r\n\u0020-\u007E\u00A0-\uFFFF]{6,}/g) || [];
  const joined = runs
    .filter((s) => /[A-Za-zА-Яа-яЁё0-9]/.test(s))
    .join("\n");
  if (joined.replace(/\s/g, "").length > 40) return clip(joined);
  const as8 = buf.toString("latin1");
  const ascii = (as8.match(/[\t\r\n\x20-\x7E]{8,}/g) || []).join("\n");
  return clip(ascii);
}

export async function extractWordText(buf: Buffer, filename = ""): Promise<string> {
  const name = filename.toLowerCase();
  if (name.endsWith(".rtf") || buf.slice(0, 5).toString("ascii") === "{\\rtf") {
    return clip(
      buf
        .toString("latin1")
        .replace(/\\par[d]?/g, "\n")
        .replace(/\\[a-z]+\d* ?/g, "")
        .replace(/[{}]/g, " ")
    );
  }
  try {
    const result = await mammoth.extractRawText({ buffer: buf });
    const text = (result.value || "").trim();
    if (text) return clip(text);
  } catch {
    /* legacy .doc or corrupt docx */
  }
  return extractLegacyDoc(buf);
}

export function extractExcelText(buf: Buffer, filename = ""): string {
  const wb = XLSX.read(buf, {
    type: "buffer",
    raw: false,
    dense: false,
    cellDates: true,
  });
  const sheets = wb.SheetNames || [];
  if (!sheets.length) return "";
  const parts: string[] = [];
  const limit = filename.toLowerCase().endsWith(".csv") ? 1 : 8;
  for (const name of sheets.slice(0, limit)) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const csv = XLSX.utils.sheet_to_csv(ws, { blankrows: false }).trim();
    if (!csv) continue;
    parts.push(sheets.length > 1 ? `Лист «${name}»:\n${csv}` : csv);
  }
  return clip(parts.join("\n\n"));
}

export async function extractOfficeText(
  buf: Buffer,
  filename: string,
  mime = ""
): Promise<string | null> {
  const kind = classifyOfficeFile(filename, mime);
  if (!kind) return null;
  try {
    if (kind === "word") {
      const text = await extractWordText(buf, filename);
      return text || null;
    }
    const text = extractExcelText(buf, filename);
    return text || null;
  } catch {
    return null;
  }
}
