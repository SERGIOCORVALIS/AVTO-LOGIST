# Implemented improvements checklist

## P0
- [x] IMAP sync + Message-ID idempotency
- [x] LLM quote extract (`MAIL_LLM_PARSE`)
- [x] Gmail OAuth2 path (`MAIL_AUTH_MODE=oauth2`)
- [x] Management Bot deal card `/deal` + KP actions
- [x] HTTP partner adapter interface (`PARTNER_HTTP_*`)
- [x] Legal corpus loader for GPT

## P1
- [x] A/B playbook metrics in CEO digest
- [x] Calibration on close (existing learning loop + actual weight)
- [x] Multi-currency → RUB (`common/fx.py`)
- [x] Attachments endpoint + OCR pipeline (pdf/office/vision/regex in `apps/workers-ts/src/ocr.ts`)
- [x] Langfuse profile documented (compose `--profile observability`)

## P2
- [x] Email send rate limit
- [x] CI workflow (typecheck, pytest, compose config)
- [x] Multi TG accounts per manager (`TG_ACCOUNTS_JSON` + sticky router)
- [x] Vault/Doppler secrets (`scripts/load-secrets.*`, `doppler.yaml.example`, `common.secrets`)

## Customs / VAT (2026-07-22)
- [x] Numeric duty + VAT (НДС) in `agents/customs.py`
- [x] Wired into orchestrator `cost_breakdown` (not freight×12%)
- [x] Invoice required for duty/VAT; no fake tax without invoice
- [x] Client-facing customs summary in KP
- [x] `TG_ESCALATION_CHAT_ID` for disputed orders
- [x] Plan compliance doc: `docs/PLAN_COMPLIANCE.md`

## Staff peer mode (группа / канал, 2026-08)
- [x] Free-text intents in Management Bot (`staffPeer.ts`): статус, эскалации, карточка, утверди КП, перехвати, пауза
- [x] Reply-to-alert + @mention + `TG_STAFF_BOT_NAMES` triggers in escalation group
- [x] Peer-friendly escalation copy in `@alo/shared` `staffCopy.ts`
- [x] `GET /deals?q=` search by client / cargo / route
- [x] Env: `TG_STAFF_PEER_MODE`, `TG_STAFF_BOT_NAMES` + docs (ENV_SETUP §8.5, COMMANDS, RUNBOOK)

## GPT in all comms (2026-09)
- [x] Staff peer GPT (`staffPeerGpt.ts` + `staff_peer.md`): ambiguous NL + colleague Q&A; `TG_STAFF_GPT`
- [x] Supplier RFQ body drafted by GPT (`MAIL_LLM_DRAFT` + `_style_hint` / style_supplier)
- [x] Inbound client email without Ref → classify + orchestrator GPT + SMTP reply (`MAIL_LLM_INBOUND`)
- [x] API `/orchestrator/process` accepts `client_email`

## Academy of the logist (2026-08)
- [x] Executable playbook `services/agents/academy.py` from textbook v1
- [x] Prompt `packages/prompts/gpt/academy.md` + wired into concierge / legal / voice
- [x] Route matrix (CN port vs inland, SZFO sea-first, remote RU cabotage)
- [x] Scheme legs + KP includes/excludes/free time (`quote_pipeline`, `negotiator`)
- [x] RFQ academy card in email worker (`ask_quote_to_include`, `do_not_disclose`)
- [x] Readiness: MSDS / Incoterms / remote RU without blocking preliminary quote
- [x] Policy flags in `tz_policy` (`academy_*`)
- [x] Tests in `services/tests/test_business_logic.py`
- [x] Docs: ARCHITECTURE, RUNBOOK, PLAN_COMPLIANCE, ENV_SETUP, TZ README

## Cabinet supplier quality loop (2026-08-21)
- [x] last_rfq_at / last_reply_at / no_reply_streak on send & IMAP
- [x] Auto-silent after streak or stale hours (SLA followup job)
- [x] RFQ prefers suppliers who recently replied
- [x] Soft-fail logging in tz_store / academy RFQ enrich
- [x] Cabinet: note panel instead of prompt; streak/RFQ timestamps
- [x] Digest line: count silent suppliers

- [x] Вкладки: В RFQ / Не отвечают / Ушли / Пауза / Все
- [x] Добавление поставщика (имя, email, режимы)
- [x] Действия: не отвечает → вне RFQ; вернуть; ушёл с рынка; пауза
- [x] `suppliers.silent` + RFQ excludes silent/left
- [x] API `/partners` CRUD + status endpoints

- [x] Import `Транс раша 2026.xlsx` → `data/suppliers_trans_russia_2026.json` (120 unique)
- [x] Seed into `partners` / `suppliers` / `partner_contacts` (`python -m agents.seed_suppliers`)
- [x] Mode-aware RFQ emails via `list_supplier_rfq_emails`
- [x] Orchestrator auto-seed on boot (`SEED_SUPPLIERS_ON_BOOT=true`)

## Production boot harden (2026-08-21)
- [x] JWT_SECRET hard-required in production (no silent fallback)
- [x] CABINET_AUTH_REQUIRED defaults ON in production; false blocked without ALLOW_INSECURE_CABINET
- [x] INTERNAL_API_TOKEN required in production (API + orchestrator)
- [x] Partner channels required: email / HTTP / ALLOW_FILE_TARIFFS + baseline JSON
- [x] ALLOW_MOCK_RATES forbidden in production
- [x] `/health` checks Postgres + Redis (503 if down)
- [x] Real `pnpm db:migrate` with schema_migrations
- [x] CI: node unit tests + migrations 001–014 + deps smoke
- [x] Baseline tariffs: `data/partner_tariffs/*_baseline.json`

## Pilot channels + KP hold (2026-08-21)
- [x] IMAP quote parse: price/ETA/HTML + tests (`quoteParse.ts`)
- [x] OAuth2 token cache; Yandex oauth path; `scripts/mail-oauth-url.cjs`
- [x] File tariffs only if no live HTTP/IMAP quotes
- [x] PEK/ДЛ `carrier_adapters` + `pek_ru_ltl.json` / `dellin_ru_ltl.json`
- [x] `REQUIRE_HUMAN_KP_APPROVE` + `POST /deals/:id/approve-kp` (bot + cabinet)
- [x] `start.ps1` / `start.sh`: migrate; seed if boot-seed off

## Prod readiness follow-up (2026-08-22)
- [x] API security headers + rate limit + HTTP/DB integration tests
- [x] GPT cost budgets (`common/gpt_budget.py`)
- [x] PDF КП + PDF договор (`/deals/:id/contract.pdf`)
- [x] Weekly silent supplier review digest (Management Bot, Monday)
- [x] CI E2E RFQ smoke + golden evals nightly workflow
- [x] Prod cutover RUNBOOK + `scripts/generate-prod-secrets.mjs`
- [x] PEK/ДЛ adapter fixture tests + ENV_SETUP live API shapes

## FESCO / associations / archive / coach (2026-09)
- [x] FESCO FIT adapter (`fesco_adapter.py`) + PSZhVS seed fold-in (`seed_pszhvs.py`)
- [x] Associations CIS parser + cabinet Parsers + weekly job
- [x] Client mail archive (`011_client_archive.sql`, `/clients`, `pnpm mail:archive-*`)
- [x] Mail attachments migrations `012`/`013`
- [x] Learning coach policy (`014_learning_coach.sql`)
- [x] Staff intents: `ops_hint` / `set_active` / `approve_rfq` / `observe`
- [x] Docs synced to current code (ARCHITECTURE, README, COMMANDS, RUNBOOK, ENV, PLAN, BUSINESS_LOGIC)
