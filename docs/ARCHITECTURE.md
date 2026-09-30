# Architecture — AutoLogistics OS (TRANSINVEST AI-логист)

Приоритет бизнес-правил: **ТЗ Александры** (`TRANSINVEST_AI_Logist_TZ_v1/`) > Академия логиста > старые эвристики.

Юрлицо в клиентских каналах: **ООО «ЖД Трансинвест»** (`packages/shared/src/company.ts`, `.env` `COMPANY_*`).

## Contours

| # | Контур | Код |
|---|--------|-----|
| 1 | **Клиентский Telegram** — только private DM (группы клиента в оркестратор не идут) | `apps/tg-gateway` (GramJS) |
| 2 | **Голос** — SIP (Zadarma / Билайн) + OpenAI Realtime | `apps/voice-gateway` |
| 3 | **Management Bot + staff room** — peer (regex + GPT), forum topics, обучение | `managementBot.ts`, `staffPeer.ts`, `staffPeerGpt.ts` |
| 4 | **Executive Channel** — алерты + CEO digest | `TG_EXEC_CHANNEL_ID` |
| 5 | **Escalation / staff chat** — спорные заказы + диалог с логистом | `TG_ESCALATION_CHAT_ID` / `TG_STAFF_CHAT_ID` |
| 6 | **Почта** — RFQ SMTP, IMAP sync, клиентские письма без Ref | `apps/workers-ts` `email.ts` |
| 7 | **Кабинет** — deals, partners, clients, parsers, policy, documents | `apps/web` + `apps/api` |
| 8 | **Оркестратор + agents** — GPT concierge / quote / legal / academy | `services/` |

## Message flow

```text
Клиент DM (GramJS) | SIP voice | email (с Ref или без)
  → API POST /orchestrator/process
       channel: telegram | voice | email
       (+ client_email для почты)
  → orchestrator /process
       → Concierge GPT (academy + style_client)
       → quote_pipeline
            ├── HTTP adapters (FESCO FIT, PEK/ДЛ, …)
            ├── RFQ email: list_supplier_rfq_emails → queues → workers
            │     GPT-черновик если MAIL_LLM_DRAFT (style_supplier)
            └── IMAP:
                  MAIL_LLM_PARSE → ставка → quotes + reprocess
                  MAIL_LLM_INBOUND → client без Ref → GPT → SMTP reply

Логист / менеджер (Management Bot + staff room):
  текст / reply на алерт / forum topic
  → staffPeer regex (быстрые действия)
  → иначе staffPeerGpt (staff_peer.md): Q&A, ops_hint, observe…
  → API /deals | /escalations | orchestrator apply-ops-hint | flush-rfq | …
  → ответ в чат (+ кнопки) или молчание (observe)
```

## Geography & product

- Обе точки РФ → `ru_domestic` (продажа с НДС).
- Китай → `cn_import`; иная зарубежная точка → `international`.
- Сборка: ПЭК / ДЛ / Байкал / … — конкурент может быть поставщиком.
- Контейнер/ПСЖВС: FESCO FIT (`fesco_adapter.py`) + preferred operators (`schemes.py` / `seed_pszhvs.py`).
- Опасный / негабарит — не hard stop. Dual-use → compliance hold. Серые схемы — hard block.

## Models (GPT)

| Роль | Env | Применение |
|------|-----|------------|
| main | `OPENAI_MODEL` | concierge, negotiator |
| fast | `OPENAI_FAST_MODEL` | staff peer, mail parse/draft/classify, габариты |
| document | `OPENAI_DOCUMENT_MODEL` | legal / customs / OCR |
| realtime / transcribe | `OPENAI_REALTIME_MODEL` / `OPENAI_TRANSCRIBE_MODEL` | голос |

Промпты: `packages/prompts/gpt/` — `concierge`, `negotiator`, `orchestrator`, `customs`, `legal`, `academy`, `voice_concierge`, `staff_peer`, `style_client`, `style_supplier`.

## Suppliers (указание и распределение)

| Слой | Путь |
|------|------|
| Каталог Trans Russia 2026 | `data/suppliers_trans_russia_2026.json` |
| Ассоциации СНГ | `data/suppliers_associations_cis.json` |
| Seed в БД | `agents/seed_suppliers.py` (+ fold-in `seed_pszhvs.py`) |
| Boot seed | `SEED_SUPPLIERS_ON_BOOT` в orchestrator |
| Ручные email / HTTP | `.env` `SUPPLIER_*` / `PARTNER_*` / `SOURCING_*` / `CABINET_*` |
| Выбор под RFQ | `common/db.py` → `list_supplier_rfq_emails` (mode / corridor / lanes / silent) |
| Постановка в очередь | `common/queues.py` → `enqueue_freight_quote_emails` |
| Лимит 10–20 | `tz_policy.py` `rfq_target_*` |
| Качество | `apps/workers-ts/src/supplierQuality.ts` |
| Кабинет CRUD | `apps/api/src/routes/partners.ts` |

## Key modules (Python)

`geography`, `finance`, `procurement`, `readiness`, `escalation_matrix`, `transport_options`, `client_memory`, `tz_policy`, `academy`, `quote_pipeline`, `quote_compare`, `fesco_adapter`, `carrier_adapters`, `adapters`, `schemes`, `restrictions`, `order_split`, `seed_suppliers`, `seed_pszhvs`, `parse_association_carriers`

## Shared / gateways (TypeScript)

- `packages/shared` — типы, `DEFAULT_POLICY`, `staffCopy`, `openai`, `loadRootEnv`, queues (`alo-email`, …)
- `apps/tg-gateway` — GramJS DM, `staffPeer` / `staffPeerGpt`, `managementBot`, `channel`, staff topics/listen
- `apps/workers-ts` — email (draft/parse/inbound), OCR, SLA, digest, associations job
- `apps/voice-gateway` — SIP + Realtime (`/health`, `/internal/takeover/:dealId`)
- `apps/api` — CRM, partners, clients, parsers, documents, KP/contract PDF, orchestrator proxy

## Learning & safety

- Outcomes → `learning_events` → calibration, partner scores, playbook canary; coach keys в `014_learning_coach.sql`
- Grey-scheme hard block; margin floor / min profit → human
- Client identity stripped from supplier RFQ
- Silent / left-market excluded; auto-silent по streak/hours
- Idempotency on `/process`; BullMQ retries + DLQ (`alo-dlq`)

## Configuration

Premium `.env` / `.env.example` (секции 1–16).  
Приоритет коммерции: code defaults ← `.env` ← `policy_config` (кабинет / bot).  
Миграции: `infra/migrations/001`–`014` (`pnpm db:migrate`).

См. [ENV_SETUP.md](ENV_SETUP.md) · [COMMANDS.md](COMMANDS.md) · [RUNBOOK.md](RUNBOOK.md) · [BUSINESS_LOGIC_TZ.md](BUSINESS_LOGIC_TZ.md).
