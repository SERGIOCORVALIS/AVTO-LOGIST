/**
 * Run: pnpm --filter @alo/api exec tsx src/kpPdf.test.ts
 */
import { buildKpPdf } from "./kpPdf";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const buf = buildKpPdf({
  dealId: "11111111-2222-3333-4444-555555555555",
  clientName: "Иванов",
  origin: "Hangzhou",
  destination: "Khimki",
  amountRub: 450000,
  marginPct: 18,
  generatedAt: new Date("2026-08-22T12:00:00Z"),
});

assert(buf.slice(0, 5).toString() === "%PDF-", "pdf magic");
assert(buf.toString("latin1").includes("%%EOF"), "eof");
assert(buf.toString("latin1").includes("450000"), "amount");
assert(buf.toString("latin1").includes("11111111-2222-3333-4444-555555555555"), "deal");
assert(buf.length > 400, "non-trivial size");

console.log("kpPdf.test.ts: ok");
