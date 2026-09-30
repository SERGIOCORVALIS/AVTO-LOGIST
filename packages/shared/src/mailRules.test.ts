import assert from "node:assert/strict";
import {
  calcRequestScore,
  looksLikeNewsletter,
  preClassifyInboundMail,
} from "./mailRules";

function testNewsletters() {
  const nl = looksLikeNewsletter({
    fromEmail: "news@unisender.com",
    subject: "Тарифы на перевозку по России",
    body: "Отписаться от рассылки: https://example.com/unsub",
    headers: { "list-unsubscribe": "<https://example.com/unsub>" },
  });
  assert.equal(nl.yes, true, "promo with list-unsubscribe must be newsletter");

  const real = looksLikeNewsletter({
    fromEmail: "ivan@client.ru",
    subject: "Нужен расчёт Москва — Владивосток",
    body: "Груз 2 тонны, нужен расчёт стоимости перевозки",
  });
  assert.equal(real.yes, false);
}

function testPreClassify() {
  const noise = preClassifyInboundMail({
    fromEmail: "noreply@pochta.ru",
    subject: "Ваше отправление",
    body: "Отслеживание посылки",
  });
  assert.ok(noise, "pochta service must be filtered");
  assert.equal(noise!.kind === "noise" || noise!.kind === "service", true);

  const client = preClassifyInboundMail({
    fromEmail: "buyer@factory.ru",
    subject: "Расчёт доставки",
    body: "Нужен расчёт перевозки из Москвы во Владивосток, 1200 кг",
  });
  assert.equal(client, null);

  const calc = calcRequestScore(
    "Расчёт",
    "Нужен расчёт перевозки Москва — Владивосток, 2 т"
  );
  assert.equal(calc.isCalc, true);
}

testNewsletters();
testPreClassify();
console.log("mailRules.test.ts ok");
