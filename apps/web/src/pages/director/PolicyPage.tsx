import { FormEvent, useEffect, useState } from "react";
import { api } from "../../api/client";
import type { PolicyConfig } from "../../api/types";
import { Button, Field, GoldCard, Hint, inputClass } from "../../components/ui";

export function PolicyPage() {
  const [policy, setPolicy] = useState<PolicyConfig | null>(null);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    api.get<PolicyConfig>("/policy").then(setPolicy);
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!policy) return;
    const next = await api.put<PolicyConfig>("/policy", {
      target_margin_pct: Number(policy.target_margin_pct),
      floor_margin_pct: Number(policy.floor_margin_pct),
      max_discount_pct: Number(policy.max_discount_pct),
      escalate_amount_rub: Number(policy.escalate_amount_rub),
      first_reply_sla_sec: Number(policy.first_reply_sla_sec),
      quote_sla_hours: Number(policy.quote_sla_hours),
      learning_enabled: Boolean(policy.learning_enabled),
      canary_pct: Number(policy.canary_pct),
      min_gross_profit_rub: Number(policy.min_gross_profit_rub ?? 3000),
      ru_vat_pct: Number(policy.ru_vat_pct ?? 22),
      broker_cost_rub: Number(policy.broker_cost_rub ?? 15000),
      broker_client_price_rub: Number(policy.broker_client_price_rub ?? 20000),
      certification_markup_pct: Number(policy.certification_markup_pct ?? 5),
      buyout_commission_pct: Number(policy.buyout_commission_pct ?? 5),
      buyout_fx_markup_rub: Number(policy.buyout_fx_markup_rub ?? 0.45),
      rfq_target_min: Number(policy.rfq_target_min ?? 10),
      rfq_target_max: Number(policy.rfq_target_max ?? 20),
      importer_scheme: String(policy.importer_scheme ?? "manual"),
    });
    setPolicy({ ...policy, ...next });
    setMsg("Политика робота обновлена. Новые сделки возьмут эти числа сразу.");
  }

  if (!policy) return <p className="text-gold-300">Загрузка политики…</p>;
  const current = policy;

  function num(key: keyof PolicyConfig, label: string, hint: string) {
    return (
      <Field label={label} hint={hint}>
        <input
          className={inputClass()}
          type="number"
          value={Number(current[key] ?? 0)}
          onChange={(e) =>
            setPolicy({ ...current, [key]: Number(e.target.value) })
          }
        />
      </Field>
    );
  }

  return (
    <form onSubmit={save} className="space-y-5">
      <header>
        <h1 className="font-serif text-3xl text-gold-300">Политика робота</h1>
        <Hint>
          ТЗ TRANSINVEST: маржа 18/10, прибыль ≥ 3000 ₽, НДС РФ 22% для сопоставления ставок,
          брокер/выкуп/сертификация и RFQ 10–20 — конфигурируемые. Менять может только директор.
        </Hint>
      </header>
      {msg ? <p className="text-sm text-gold-300">{msg}</p> : null}
      <GoldCard className="grid gap-4 md:grid-cols-2">
        {num("target_margin_pct", "Целевая маржа %", "Робот закладывает эту маржу в КП.")}
        {num("floor_margin_pct", "Пол маржи %", "Ниже — сделка уходит директору.")}
        {num("min_gross_profit_rub", "Мин. прибыль, ₽", "Ниже 3000 ₽ по умолчанию — эскалация.")}
        {num("ru_vat_pct", "НДС РФ %", "Сопоставление ставок без НДС: × (1 + vat/100).")}
        {num("max_discount_pct", "Макс. скидка %", "Потолок уступки клиенту без эскалации.")}
        {num(
          "escalate_amount_rub",
          "Порог суммы, ₽",
          "КП дороже порога не уходит клиенту без Approve."
        )}
        {num("broker_cost_rub", "Брокер себестоимость, ₽", "Ориентир за ДТ до 4 товаров.")}
        {num("broker_client_price_rub", "Брокер клиенту, ₽", "Фикс в КП за растаможку.")}
        {num("certification_markup_pct", "Сертификация +%", "Наценка к себестоимости партнёра.")}
        {num("buyout_commission_pct", "Выкуп комиссия %", "База экономики выкупа.")}
        {num("buyout_fx_markup_rub", "Выкуп + к курсу", "Рублей к курсу CNY→RUB.")}
        {num("rfq_target_min", "RFQ мин. шт", "Ориентир числа рыночных расчётов.")}
        {num("rfq_target_max", "RFQ макс. шт", "Верхняя планка, где разумно.")}
        {num("first_reply_sla_sec", "SLA первого ответа, сек", "Для календаря и контроля скорости.")}
        {num("quote_sla_hours", "SLA котировки, ч", "Срок, за который робот должен собрать КП.")}
        {num("canary_pct", "Canary, %", "Доля сделок на новый playbook до полного включения.")}
        <Field
          label="Схема импортёра"
          hint="Кто импортёр в агентской схеме (ТЗ: пока manual)."
        >
          <select
            className={inputClass()}
            value={String(policy.importer_scheme ?? "manual")}
            onChange={(e) =>
              setPolicy({ ...current, importer_scheme: e.target.value })
            }
          >
            <option value="manual">manual (ручная настройка)</option>
            <option value="client">client</option>
            <option value="transinvest">transinvest</option>
          </select>
        </Field>
        <Field
          label="Самообучение"
          hint="Если выкл, робот не предлагает новые playbook после закрытия сделок."
        >
          <select
            className={inputClass()}
            value={policy.learning_enabled ? "1" : "0"}
            onChange={(e) =>
              setPolicy({ ...policy, learning_enabled: e.target.value === "1" })
            }
          >
            <option value="1">Включено</option>
            <option value="0">Выключено</option>
          </select>
        </Field>
      </GoldCard>
      <Button type="submit">Сохранить политику</Button>
    </form>
  );
}
