/**
 * Run: pnpm --filter @alo/workers-ts exec tsx src/quoteParse.test.ts
 */
import { parseQuoteFromMail, resolveOpenAiModel, extractDealId } from "./quoteParse";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const deal = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

{
  const q = parseQuoteFromMail({
    subject: `Re: Запрос ставки Ref: ${deal}`,
    text: "Добрый день. Стоимость перевозки 185 000 руб. Срок 8–12 дней. Оферта 48 часов.",
  });
  assert(q.dealId === deal, "deal id");
  assert(q.price === 185000, `price got ${q.price}`);
  assert(q.currency === "RUB", "rub");
  assert(q.etaDaysMin === 8 && q.etaDaysMax === 12, "eta range");
  assert(q.validUntilHours === 48, "valid");
}

{
  const q = parseQuoteFromMail({
    text: "Rate USD 1,250. Transit about 10 days.",
  });
  assert(q.price === 1250, `usd price ${q.price}`);
  assert(q.currency === "USD", "usd");
  assert(q.etaDaysMin === 10, "eta single");
}

{
  const q = parseQuoteFromMail({
    html: "<p>Итого: <b>92&nbsp;500 ₽</b></p><p>Срок доставки 5-7 дн.</p>",
  });
  assert(q.price === 92500, `html price ${q.price}`);
  assert(q.currency === "RUB", "html rub");
  assert(q.etaDaysMin === 5 && q.etaDaysMax === 7, "html eta");
}

{
  const q = parseQuoteFromMail({ text: "наш телефон +7 999 123-45-67 вес 1500 кг" });
  assert(q.price == null, "reject phone/weight as price");
}

assert(extractDealId(`x Ref: ${deal} y`) === deal, "extractDealId");
assert(resolveOpenAiModel("gpt-5.6-small,gpt-4o-mini") === "gpt-5.6-small", "model first");
assert(resolveOpenAiModel("gpt-5.5-") === "gpt-5.5", "trim dash");

console.log("quoteParse.test.ts: ok");
