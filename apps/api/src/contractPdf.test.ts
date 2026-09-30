/**
 * Run: pnpm --filter @alo/api exec tsx src/contractPdf.test.ts
 */
import { buildContractPdf } from "@alo/shared";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const buf = buildContractPdf({
  dealId: "11111111-2222-3333-4444-555555555555",
  clientName: "ООО Тест",
  draftMd: "# Договор\n\nСтороны согласовали перевозку груза.\n\n1. Предмет\n2. Сроки",
  generatedAt: new Date("2026-08-22T12:00:00Z"),
});

assert(buf.slice(0, 5).toString() === "%PDF-", "pdf magic");
assert(buf.toString("latin1").includes("%%EOF"), "eof");
assert(buf.toString("latin1").includes("contract draft"), "header");
assert(buf.toString("latin1").includes("11111111-2222-3333-4444-555555555555"), "deal");
assert(buf.length > 400, "non-trivial size");

console.log("contractPdf.test.ts: ok");
