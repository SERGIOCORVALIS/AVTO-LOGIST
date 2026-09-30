/**
 * Minimal PDF 1.4 (Helvetica). Non-ASCII in Info UTF-16 metadata;
 * body lines are ASCII-safe for universal viewers.
 */
export function asciiLine(value: string): string {
  return [...value]
    .map((ch) => (ch.charCodeAt(0) < 128 ? ch : "?"))
    .join("");
}

export function pdfEscape(value: string): string {
  return asciiLine(value)
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

export function utf16BeHex(value: string): string {
  let hex = "FEFF";
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    hex += code.toString(16).toUpperCase().padStart(4, "0");
  }
  return hex;
}

export type TextPdfOptions = {
  lines: string[];
  title: string;
  generatedAt?: Date;
  lineHeight?: number;
  startY?: number;
  fontSize?: number;
};

export function buildTextPdf(opts: TextPdfOptions): Buffer {
  const when = (opts.generatedAt || new Date()).toISOString();
  const lineHeight = opts.lineHeight ?? 22;
  const startY = opts.startY ?? 760;
  const fontSize = opts.fontSize ?? 12;
  const lines = opts.lines.map((line) => asciiLine(line));

  const textOps = lines
    .map((line, i) => {
      const y = startY - i * lineHeight;
      if (y < 40) return "";
      return `BT /F1 ${fontSize} Tf 50 ${y} Td (${pdfEscape(line)}) Tj ET`;
    })
    .filter(Boolean)
    .join("\n");
  const stream = `${textOps}\n`;
  const titleHex = utf16BeHex(opts.title.slice(0, 120));
  const dateStamp = when.replace(/[-:]/g, "").slice(0, 15);

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Title <${titleHex}> /Creator (AutoLogistics OS) /CreationDate (D:${dateStamp}Z) >>`,
  ];

  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefAt = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n`;
  body += "0000000000 65535 f \n";
  for (let i = 1; i < offsets.length; i++) {
    body += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer << /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\n`;
  body += `startxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

export type ContractPdfInput = {
  dealId: string;
  clientName?: string | null;
  draftMd: string;
  generatedAt?: Date;
};

export function buildContractPdf(input: ContractPdfInput): Buffer {
  const header = [
    "TRANSINVEST  contract draft",
    `Deal: ${input.dealId}`,
    `Client: ${input.clientName || "-"}`,
    `Generated: ${(input.generatedAt || new Date()).toISOString()}`,
    "",
  ];
  const bodyLines = (input.draftMd || "")
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l, i, arr) => l.length > 0 || (i > 0 && arr[i - 1].length > 0))
    .slice(0, 32);
  const lines = [...header, ...bodyLines];
  return buildTextPdf({
    lines,
    title: `Contract ${input.clientName || input.dealId}`,
    generatedAt: input.generatedAt,
    lineHeight: 16,
    fontSize: 10,
  });
}
