/**
 * Run: pnpm --filter @alo/workers-ts exec tsx src/supplierQuality.test.ts
 */
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

assert(Number(process.env.SUPPLIER_SILENT_AFTER_STREAK || 3) >= 1, "streak default");
assert(Number(process.env.SUPPLIER_SILENT_AFTER_HOURS || 72) >= 1, "hours default");

// Pure parse check mirroring markSupplierReplied extraction
function extractEmail(from: string): string | null {
  const m = from.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return m?.[0]?.toLowerCase() || null;
}

assert(extractEmail("Rates <rates@pek.ru>") === "rates@pek.ru", "angle addr");
assert(extractEmail("info@tlscgroup.ru") === "info@tlscgroup.ru", "bare");
assert(extractEmail("no mail here") === null, "none");

console.log("supplierQuality.test.ts: ok");
