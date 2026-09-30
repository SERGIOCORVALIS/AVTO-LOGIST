import {
  dealSnippetFromRow,
  formatEscalationStaff,
  formatFollowupStaff,
  formatMoneyRub,
  formatQuoteExpiredStaff,
  statusRu,
} from "./staffCopy";

const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(msg);
};

assert(statusRu("quoting") === "запрос ставок у поставщиков", "status ru");
assert(formatMoneyRub(450000).includes("450"), "money");

const deal = dealSnippetFromRow({
  id: "11111111-2222-3333-4444-555555555555",
  client_name: "Иванов",
  cargo: { name: "мясорубки", quantity: 100 },
  route: { origin_city: "Ханчжоу", destination_city: "Химки" },
  status: "quoting",
  amount_rub: 450000,
  margin_pct: 18,
});

const esc = formatEscalationStaff({
  dealId: deal.id,
  reason: "missing_partner_channels",
  summary: "Нет HTTP-ставок и почты поставщиков",
  neededDecision: "configure_suppliers",
  deal,
});
assert(esc.includes("Некуда запросить ставки"), "reason title");
assert(esc.includes("Ханчжоу → Химки"), "route");
assert(esc.includes("мясорубки"), "cargo");
assert(esc.includes("/deal "), "command");
assert(esc.includes("обычным текстом"), "peer hint");
assert(!/ESCALATION|deal:|reason:|decision needed/i.test(esc), "no english labels");

const expired = formatQuoteExpiredStaff({
  deal,
  source: "email_imap",
  price: 120000,
  currency: "RUB",
});
assert(expired.includes("истекла"), "expired ru");

const follow = formatFollowupStaff({ deal, updatedAt: new Date().toISOString() });
assert(follow.includes("2 часов"), "followup ru");

console.log("staffCopy.test.ts ok");
