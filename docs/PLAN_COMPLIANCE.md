# Соответствие плану и ТЗ TRANSINVEST AI-логист v1

Дата проверки: 2026-09-09.

## Сводка покрытия

| Блок | Статус | Комментарий |
|------|--------|-------------|
| Telegram client (GramJS) | DONE | Только private DM; группы клиента не в оркестратор |
| Management Bot + staff peer | DONE | regex + GPT (`staffPeerGpt`, `TG_STAFF_GPT`), forum, ops_hint |
| Executive Channel | DONE | digest + alerts |
| Voice SIP + Realtime | DONE | `apps/voice-gateway` (не Voximplant) |
| География без лимита Китай→РФ | DONE | `ru_domestic` / `cn_import` / `international` |
| Габариты/вес | DONE | client / past-deal / LLM / DDG + OCR |
| Preliminary vs impossible | DONE | `agents/readiness.py` |
| RFQ / procurement | DONE | mode filter, sanitize, GPT draft (`MAIL_LLM_DRAFT`), 10–20 |
| FESCO FIT + PSZhVS | DONE | `fesco_adapter.py`, `seed_pszhvs.py`, `schemes.py` |
| Groupage (ПЭК/ДЛ/…) | DONE | competitor may be supplier |
| VAT-comparable costs | DONE | без НДС × (1+ru_vat_pct/100) |
| Pricing / floor / min profit | DONE | 18 / 10 / 3000 ₽ |
| Таможня ТН ВЭД / пошлина / НДС | DONE | preliminary; broker learn path |
| Client email GPT | DONE | `MAIL_LLM_INBOUND` → orchestrator → SMTP |
| IMAP quote LLM | DONE | `MAIL_LLM_PARSE` |
| Supplier quality / silent | DONE | `supplierQuality.ts` + weekly review |
| Associations parser | DONE | `parse_association_carriers` + cabinet Parsers |
| Client archive | DONE | `011_client_archive.sql` + `/clients` |
| Follow-up / ABC / volume | DONE | calendar + TZ migrations |
| Escalation matrix | DONE | Python + `staffCopy.ts` |
| Academy of the logist | DONE | `academy.py` + `academy.md` (подчинён ТЗ) |
| Learning coach | DONE | `014_learning_coach.sql` |
| Docs / env | DONE | ENV_SETUP, ARCHITECTURE, COMMANDS, RUNBOOK |
| Observability | DONE | Langfuse profile |
| Bootstrap / CI | DONE | typecheck + pytest + migrate + e2e smoke |

## Формула таможни

```text
ТСст (CV)     = invoice → RUB
пошлина       = CV × duty_pct
НДС           = (CV + пошлина + акциз) × vat_pct   # РФ 22% (policy)
clearance     = пошлина + НДС + акциз + брокер + серт
себестоимость = Σ плеч (effective VAT base) + clearance + локалка + страховка + ops
```

Без инвойса: `duty_rub`/`vat_rub` = null. Клиенту всегда «предварительный расчёт».

## Сопоставимая налоговая база поставщиков

```text
raw 100_000 без НДС  → effective 122_000 (при RU_VAT_PCT=22)
raw 100_000 с НДС    → effective 100_000
Ранжирование RFQ — по effective_supplier_cost, не по raw.
```

## Ключевые env для прода

- `ALO_ENV=production` + `ALLOW_MOCK_RATES=false`
- `JWT_SECRET` + `INTERNAL_API_TOKEN` (обязательны)
- `CABINET_AUTH_REQUIRED=true`
- Каналы ставок: seeded DB / `SUPPLIER_QUOTE_EMAILS` / `SUPPLIER_EMAIL_*` / `PARTNER_HTTP_*` / `ALLOW_FILE_TARIFFS`
- FESCO (контейнер): `PARTNER_HTTP_FESCO` или `FESCO_OFFERS_URL` / `FESCO_API_BASE`
- GPT-каналы: `TG_STAFF_GPT=on`, `MAIL_LLM_PARSE/DRAFT/INBOUND=true`
- `SUPPLIER_SILENT_AFTER_STREAK=3`, `SUPPLIER_SILENT_AFTER_HOURS=72`
- `RU_VAT_PCT=22`, `MIN_GROSS_PROFIT_RUB=3000`
- `REQUIRE_HUMAN_KP_APPROVE=true` (пилот)
- Миграции: `pnpm db:migrate` (`infra/migrations/001`–`014`)
- Сид: `pnpm seed:suppliers` (+ опционально `pnpm seed:associations`)

## Источник правды

Рабочее ТЗ: `TRANSINVEST_AI_Logist_TZ_v1/`. При конфликте с Академией — ТЗ.
