# Бизнес-логика TRANSINVEST AI-логист v1 — что внедрено

Источник: `TRANSINVEST_AI_Logist_TZ_v1/` + `TRANSINVEST_AI_Logist_Business_Logic_v1.docx`.  
Архитектура кода: [ARCHITECTURE.md](ARCHITECTURE.md).

## Цикл

Квалификация → варианты → RFQ рынка → сравнение → себестоимость → КП → переговоры → договор/оплата → исполнение → закрытие → знания.

Статусы: `intake → sizing → customs → quoting → pricing → negotiation → contract → execution → closed_*` (+ `awaiting_manager`).

## География

| Условие | Коридор |
|---------|---------|
| Обе точки РФ | `ru_domestic` |
| Китай | `cn_import` |
| Любая другая зарубежная точка | `international` |

## Стопы и не-стопы

**Стоп:** налив, частный переезд, санкции, серые схемы.  
**Не стоп:** опасный, негабарит (нужен эксперт). Dual-use → hold логисту+брокеру.

## Поставщики

| Источник | Назначение |
|----------|------------|
| `data/suppliers_trans_russia_2026.json` | основной каталог → `pnpm seed:suppliers` |
| `seed_pszhvs.py` | FESCO / ТК / SASCO / … (fold-in при seed) |
| `data/suppliers_associations_cis.json` | ассоциации → `pnpm seed:associations` |
| `.env` `SUPPLIER_*` / `PARTNER_*` | ручные email / HTTP / кабинеты |
| FESCO FIT | `fesco_adapter.py` — живой калькулятор контейнера |
| ПЭК / ДЛ / Байкал / КИТ | сборка: competitor may be supplier |

Распределение RFQ: `list_supplier_rfq_emails` (mode/corridor/lanes) → `enqueue_freight_quote_emails` (лимит 10–20).  
Молчащие (`silent`) и ушедшие с рынка не получают RFQ.  
В RFQ не светим клиента/ИНН/завод; тело письма — GPT-черновик (`MAIL_LLM_DRAFT` + `style_supplier.md`).

Кабинет → **Поставщики** (`/partners`).

## Финансы

- Цель маржи 18%, пол 10%, прибыль &lt; 3000 ₽ → человек.
- РФ: клиенту с НДС. Поставщик без НДС → сопоставимая база (×1.22 при 22%).
- Международный фрахт НДС 0%.
- Предоплата: стремимся к 100%.
- Утверждение КП: `REQUIRE_HUMAN_KP_APPROVE` → бот/кабинет `approve-kp`.

## GPT во всех каналах общения

| Канал | Механизм |
|--------|----------|
| Клиент TG / voice / email | Concierge + academy + `style_client` |
| Сотрудники (staff room) | `staffPeer` + `staffPeerGpt` + `staff_peer.md` |
| RFQ поставщикам | `MAIL_LLM_DRAFT` |
| Ответ поставщика | `MAIL_LLM_PARSE` |
| Входящее письмо клиента без Ref | `MAIL_LLM_INBOUND` → orchestrator → SMTP |

## Конфиг

Источник правды: **premium `.env`** + [ENV_SETUP.md](ENV_SETUP.md).  
Ключи: `RU_VAT_PCT`, `MIN_GROSS_PROFIT_RUB`, брокер, выкуп, RFQ 10–20, `IMPORTER_SCHEME`, `ACADEMY_*`, `TG_STAFF_GPT`, `MAIL_LLM_*`.  
Приоритет: дефолты кода ← `.env` ← `policy_config`.

```powershell
node scripts/audit-env.mjs
```

## Код

**Python:** `services/agents/{geography,finance,procurement,readiness,escalation_matrix,transport_options,client_memory,tz_policy,academy,quote_pipeline,quote_compare,fesco_adapter,schemes,restrictions,order_split,seed_suppliers,seed_pszhvs}.py`  
**TS:** `packages/shared`, `apps/tg-gateway/src/{staffPeer,staffPeerGpt,managementBot}.ts`, `apps/workers-ts/src/{email,supplierQuality,reprocess}.ts`  
**SQL:** `infra/migrations/006`–`014` (+ init)  
**Промпты:** `packages/prompts/gpt/{concierge,orchestrator,negotiator,voice_concierge,customs,legal,academy,staff_peer,style_client,style_supplier}.md`

## Эскалация человеку

Матрица: `escalation_matrix.py` + `staffCopy.ts`.  
Доставка: `TG_ESCALATION_CHAT_ID` (+ копия в exec).  
Ответ логиста: peer-режим (обычный язык + GPT) или `/deal` / кнопки / `ops_hint`.  
Подробнее: [COMMANDS.md §2](COMMANDS.md#2-management-bot-telegram).

## Академия логиста

Учебник → `agents/academy.py`. При конфликте приоритет у ТЗ (маржа/НДС/RFQ/стопы).  
Флаги: `academy_enabled` / `academy_in_kp` / `academy_in_rfq` / `academy_in_voice`.  
См. [ACADEMY.md](ACADEMY.md).
