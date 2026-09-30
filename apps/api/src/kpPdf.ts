import { buildTextPdf, type TextPdfOptions } from "@alo/shared";

export type KpPdfInput = {
  dealId: string;
  clientName?: string | null;
  origin?: string | null;
  destination?: string | null;
  amountRub?: number | null;
  marginPct?: number | null;
  generatedAt?: Date;
};

export function buildKpPdf(input: KpPdfInput): Buffer {
  const when = (input.generatedAt || new Date()).toISOString();
  const amount =
    input.amountRub != null && Number.isFinite(input.amountRub)
      ? String(Math.round(input.amountRub))
      : "-";
  const margin =
    input.marginPct != null && Number.isFinite(input.marginPct)
      ? String(input.marginPct)
      : "-";
  const route = [input.origin || "-", input.destination || "-"].join(" -> ");
  const lines = [
    "TRANSINVEST  commercial offer (KP)",
    `Deal: ${input.dealId}`,
    `Client: ${input.clientName || "-"}`,
    `Route: ${route}`,
    `Amount RUB: ${amount}`,
    `Margin pct: ${margin}`,
    `Generated: ${when}`,
  ];
  return buildTextPdf({
    lines,
    title: `KP ${input.clientName || input.dealId}`,
    generatedAt: input.generatedAt,
  } satisfies TextPdfOptions);
}

export { buildContractPdf, buildTextPdf } from "@alo/shared";
