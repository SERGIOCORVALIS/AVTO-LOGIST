/**
 * Run: pnpm --filter @alo/workers-ts exec tsx src/digest.test.ts
 */
import { formatWeeklySilentReview, type SilentSupplierRow } from "./digest";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const rows: SilentSupplierRow[] = [
  {
    name: "ПЭК Тест",
    email: "quotes@pek.test",
    no_reply_streak: 3,
    last_rfq_at: "2026-08-20T10:00:00.000Z",
    silent_note: "auto: нет ответа после 3 RFQ",
  },
];

const text = formatWeeklySilentReview(rows, new Date("2026-08-22T09:00:00Z"));
assert(text.includes("Еженедельный разбор"), "title");
assert(text.includes("ПЭК Тест"), "supplier name");
assert(text.includes("quotes@pek.test"), "email");
assert(text.includes("streak 3"), "streak");
assert(text.includes("Не отвечают"), "cabinet hint");

const empty = formatWeeklySilentReview([]);
assert(empty.includes("нет поставщиков"), "empty state");

console.log("digest.test.ts: ok");
