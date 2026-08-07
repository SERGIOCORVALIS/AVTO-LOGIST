<pre>
╔══════════════════════════════════════════════════════════════╗
║  🔐 ENV SETUP · PREMIUM GUIDE · EVERY KEY · EVERY LINK       ║
╚══════════════════════════════════════════════════════════════╝
</pre>

# 🔐 Environment Setup — AutoLogistics OS

This premium guide explains **every** environment variable:

- what it means
- whether it is required to boot
- where to register
- how to obtain the value (step-by-step)
- how the system uses it

**Template:** [`.env.example`](../.env.example)  
**Copy:** `copy .env.example .env` (Windows) or `cp .env.example .env` (Unix)  
**Never commit** a real `.env`.

> 🧊 Fill keys from the **core slab** upward: DB/Redis → LLM → Telegram → Mail → Voice → Calendar/Observability.

---

## 📑 Table of contents

1. [Minimal local start](#1-minimal-local-start)
2. [Onboarding order](#2-onboarding-order)
3. [Core: runtime, DB, Redis, S3](#3-core-runtime-db-redis-s3)
3a. [Company / legal entity](#3a-company--legal-entity)
4. [Commercial policy](#4-commercial-policy)
5. [OpenAI (GPT + Realtime)](#5-openai-gpt--realtime)
6. [DeepSeek (customs / contracts)](#6-deepseek-customs--contracts)
7. [Telegram user account](#7-telegram-user-account-clients)
8. [Management Bot + channels](#8-management-bot--channels)
9. [Mail: Gmail / Yandex / custom](#9-mail-gmail--yandex--custom)
10. [Voice: SIP + Voice Gateway](#10-voice-sip-zadarma--beeline--voice-gateway)
11. [Observability (Langfuse)](#11-observability-langfuse)
12. [Partners / Calendar / HS / Doppler](#12-partners-calendar-hs--doppler)
13. [Readiness checklist](#13-readiness-checklist)
14. [Common mistakes](#14-common-mistakes)
15. [Quick links](#15-quick-links)

---

## 1. Minimal local start

After `.\scripts\setup.ps1`, Docker brings up Postgres / Redis / MinIO.  
To verify **API + orchestrator + workers** you only need:

| Variable | Example | Why |
|----------|---------|-----|
| `DATABASE_URL` | `postgresql://alo:alo@localhost:5432/autologistics` | CRM / deals |
| `REDIS_URL` | `redis://localhost:6379` | BullMQ queues |
| `API_URL` | `http://localhost:3000` | Service mesh |
| `ORCHESTRATOR_URL` | `http://localhost:8000` | Deal loop |
| `S3_*` | MinIO defaults | Attachments |

Telegram / LLM / mail / voice are **optional** until you leave heuristic mode.

```powershell
copy .env.example .env
.\scripts\setup.ps1
.\scripts\start.ps1
curl http://localhost:3000/health
curl http://localhost:8000/health
```

---

## 2. Onboarding order

```text
1. Core (DB / Redis / S3)     ← already in .env.example
2. OpenAI                     ← dialogue / OCR / voice
3. DeepSeek                   ← customs / contracts
4. Telegram bot + session     ← ops + clients
5. Mail SMTP/IMAP             ← rate hunting
6. Partners / HS feed         ← real quotes + duty table
7. Google Calendar            ← SLA visibility
8. SIP voice                  ← optional phone channel
9. Langfuse                   ← optional traces
```

---

## 3. Core: runtime, DB, Redis, S3

### `NODE_ENV` / `ALO_ENV`
- `development` (default) · `production` · `test`
- In production, mock rates default **off** unless `ALLOW_MOCK_RATES=true`

### `LOG_LEVEL` / `LOG_DIR`
- Levels: `debug` | `info` | `warn` | `error`
- Default dir: `./logs`

### `API_PORT` / `API_HOST` / `API_URL`
- Bind: `3000` / `0.0.0.0`
- `API_URL` is what other services call

### `ORCHESTRATOR_URL`
- Default `http://localhost:8000`
- API proxies `POST /orchestrator/process` here

### `REDIS_URL`
- Local Docker: `redis://localhost:6379`
- Queues: inbound, outbound, email, ocr, sla, digest, dlq…

### `DATABASE_URL`
- Local: `postgresql://alo:alo@localhost:5432/autologistics`
- Schema: `infra/init.sql` (+ `infra/migrations/*.sql` on existing volumes)

### `S3_ENDPOINT` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` / `S3_BUCKET` / `S3_REGION`
- Local MinIO: `http://localhost:9000`, `minioadmin` / `minioadmin`, bucket `alo-files`
- Console often on `:9001`
- API uses SigV4; falls back to `data/uploads` if S3 fails

### `INTERNAL_API_TOKEN`
- Shared secret for `/internal/*`
- Required when `ALO_ENV` or `NODE_ENV` is `production`
- Header: `x-internal-token: <token>`

### `LICENSE_KEY` (proprietary gate)
- Checked at startup of **API**, **tg-gateway**, **voice-gateway**
- First start writes `data/license.state.json` (`installedAt`)
- **180 days** after install/start → services **refuse** without a valid signed key
- Issue a key (copyright holder): `node scripts/issue-license.mjs --days 180`
- Format: `ALO1.<payload>.<hmac>`
- After key activation, another **180 days** — then a *new* key is required

| Variable | Purpose |
|----------|---------|
| `LICENSE_KEY` | Signed key from the copyright holder |
| `LICENSE_ENFORCE=true` | Require key immediately (no 180-day grace) |
| `LICENSE_SKIP=true` | Skip check in non-production (CI/dev) |
| `LICENSE_ISSUER_SECRET` | HMAC secret when issuing customer keys |
| `LICENSE_STATE_PATH` | Override path to `license.state.json` |

---

## 3a. Company / legal entity

| Variable | Purpose |
|----------|---------|
| `COMPANY_LEGAL_NAME` | Contracts / mail footer |
| `COMPANY_DISPLAY_NAME` | Voice greeting / client texts |
| `COMPANY_INN` / `COMPANY_KPP` / address fields | Requisites block |

Defaults ship for ООО «ЖД Трансинвест» in shared/company modules.

---

## 4. Commercial policy

Seeded into DB; editable via Management Bot (`/margin`, `/floor`, `/policy`).

| Variable | Meaning |
|----------|---------|
| `TARGET_MARGIN_PCT` | Default offer margin |
| `FLOOR_MARGIN_PCT` | Hard floor → escalate |
| `MAX_DISCOUNT_PCT` | Auto discount cap |
| `ESCALATE_AMOUNT_RUB` | Large-deal threshold |
| `CANARY_PCT` | Playbook canary traffic |
| `DEFAULT_VAT_PCT` | Import VAT (usually 20) |
| `OPS_LOCAL_RUB` / `OPS_FEE_RUB` / `OPS_INSURANCE_PCT` | Cost model knobs |

Playbook `body` can override margin/floor/discounts per canary lane.

---

## 5. OpenAI (GPT + Realtime)

### Register
1. https://platform.openai.com — create account + billing  
2. API keys → create secret  
3. Realtime docs: https://platform.openai.com/docs/guides/realtime  

### Variables

| Variable | Notes |
|----------|-------|
| `OPENAI_API_KEY` | Required for live GPT / Vision OCR / Realtime / embeddings |
| `OPENAI_MODEL` | e.g. `gpt-4o` / `gpt-4o-mini` |
| `OPENAI_BASE_URL` | Default OpenAI; swap for Azure/proxy |
| `OPENAI_REALTIME_MODEL` | Voice model |
| `OPENAI_EMBEDDING_MODEL` | Default `text-embedding-3-small` (1536 dims) |

Without a key → heuristic concierge / legal (dev mode).

---

## 6. DeepSeek (customs / contracts)

### Register
1. https://platform.deepseek.com  
2. Create API key  

### Variables

| Variable | Notes |
|----------|-------|
| `DEEPSEEK_API_KEY` | Legal agent |
| `DEEPSEEK_MODEL` | e.g. `deepseek-chat` |
| `DEEPSEEK_BASE_URL` | Default `https://api.deepseek.com` |

Without a key → heuristic HS + draft contract.

---

## 7. Telegram user account (clients)

### Register API
1. https://my.telegram.org → API development tools  
2. Create app → `TG_API_ID`, `TG_API_HASH`

### Session
```bash
pnpm --filter @alo/tg-gateway login
```
Paste `TG_STRING_SESSION` into `.env`. Use a **work** account.

### Rate / hours
`TG_MIN_REPLY_DELAY_MS`, `TG_MAX_REPLY_DELAY_MS`, `TG_MAX_MSGS_PER_MINUTE`, `TG_WORK_HOURS_START/END`

### Multi-account (optional)
`TG_ACCOUNTS_JSON=[...]` — sticky routing + `/accounts`

---

## 8. Management Bot + channels

### 8.1 BotFather
Create bot → `TG_BOT_TOKEN`

### 8.2 Manager IDs
Resolve numeric IDs → `TG_MANAGER_IDS=123,456`

### 8.3 Executive Channel
Create channel, add bot as admin → `TG_EXEC_CHANNEL_ID=-100...`

### 8.4 Escalation chat
`TG_ESCALATION_CHAT_ID` for disputed orders (falls back to exec channel)

---

## 9. Mail: Gmail / Yandex / custom

Outbound SMTP = rate requests · Inbound IMAP = carrier replies (`Ref: deal_uuid`).

### Shared

| Variable | Notes |
|----------|-------|
| `MAIL_PROVIDER` | `gmail` \| `yandex` \| `custom` |
| `MAIL_AUTH_MODE` | `app_password` \| `oauth2` |
| `MAIL_USER` / `MAIL_APP_PASSWORD` / `MAIL_FROM` | Identity |
| `MAIL_SYNC_ENABLED` | IMAP poll |
| `MAIL_SYNC_INTERVAL_MS` | Default 60000 |
| `MAIL_LLM_PARSE` | LLM price extract |
| `MAIL_MAX_SEND_PER_MINUTE` | Anti-spam |
| `MAIL_REQUIRE_SMTP` | Fail closed in prod |
| `EMAIL_WHITELIST_DOMAINS` | First-email approve gate |

### 9.A Gmail app password
Enable 2FA → https://myaccount.google.com/apppasswords

### 9.B Gmail OAuth2 (recommended prod)
Google Cloud OAuth client + refresh token → `MAIL_OAUTH_*`

### 9.C Yandex
https://id.yandex.ru/security → app password + enable IMAP

### 9.D Custom
`SMTP_HOST/PORT/USER/PASS` + `IMAP_HOST/PORT`

---

## 10. Voice: SIP (Zadarma / Beeline) + Voice Gateway

Optional phone channel: PSTN → SIP/RTP → OpenAI Realtime → same deal pipeline.

### Prerequisites
- `OPENAI_API_KEY`
- RU DID number
- SIP credentials
- Public IP + open UDP SIP/RTP ports

### 10.0 Pick a provider

| Provider | `SIP_PROVIDER` |
|----------|----------------|
| Zadarma | `zadarma` |
| Beeline Business | `beeline` / `beeline_business` |

### 10.1 Zadarma (high level)
1. Register at https://zadarma.com  
2. Buy DID · create SIP connection  
3. Fill `SIP_USERNAME`, `SIP_PASSWORD`, `SIP_SERVER`, `SIP_PUBLIC_HOST`  
4. Open firewall UDP 5060 + RTP range  
5. `.\scripts\start.ps1 -WithVoiceGateway` · call the DID  

### 10.2 Beeline Business
Map Cloud PBX fields to `SIP_DOMAIN`, `SIP_OUTBOUND_PROXY`, `SIP_AUTH_USERNAME`, password.

### 10.3 Modes
- **REGISTER** — classic username/password registration  
- **SIP URI** — `SIP_URI_MODE=1`, DID routes to your public host

### 10.4 Key SIP variables
`SIP_PROVIDER`, `SIP_USERNAME`, `SIP_PASSWORD`, `SIP_SERVER`, `SIP_PORT`, `SIP_DOMAIN`, `SIP_OUTBOUND_PROXY`, `SIP_PUBLIC_HOST`, `SIP_RTP_PORT_MIN/MAX`, `VOICE_DID_NUMBER`, `VOICE_GATEWAY_PORT` (3010), `VOICE_MANAGER_TRANSFER_NUMBER`

### 10.5 Voice persona
`VOICE_PERSONA`, `VOICE_COMPANY_NAME`, `VOICE_AGENT_NAME`, `VOICE_GREETING`, `VOICE_MAX_CALL_MINUTES`, `VOICE_RECORDING_DISCLAIMER`, `VOICE_AFTER_HOURS_MODE=message`, `VOICE_HOURS_START/END`, `VOICE_TZ=Europe/Moscow`

### 10.6 Network / Docker
Publish SIP/RTP UDP ports; apply voice migrations on old DBs if needed.

### 10.7 Verify
- `GET http://localhost:3010/health`  
- Test inbound call · `/call` · `/takeover` in Management Bot  

### 10.8 Minimal env sketch

```env
SIP_PROVIDER=zadarma
SIP_USERNAME=...
SIP_PASSWORD=...
SIP_SERVER=sip.zadarma.com
SIP_PUBLIC_HOST=your.public.ip
VOICE_DID_NUMBER=+7...
VOICE_MANAGER_TRANSFER_NUMBER=+7...
OPENAI_API_KEY=sk-...
VOICE_AFTER_HOURS_MODE=message
```

> Deep SIP field-by-field appendix lives in historical notes under `docs/_voice_section10.md` if you need ultra-detailed provider screenshots; this section is the maintained English source of truth.

---

## 11. Observability (Langfuse)

```bash
docker compose -f infra/docker-compose.yml --profile observability up -d
```

| Variable | Notes |
|----------|-------|
| `LANGFUSE_PUBLIC_KEY` | Project public key |
| `LANGFUSE_SECRET_KEY` | Secret |
| `LANGFUSE_HOST` | Default `http://localhost:3001` |

LLM calls in `services/common/llm.py` emit traces when keys are set.

---

## 12. Partners, Calendar, HS & Doppler

### HTTP / CDEK / JSON tariffs

```env
ALO_ENV=production
ALLOW_MOCK_RATES=false
PARTNER_QUOTE_EMAILS=rates@partner1.com
PARTNER_CDEK_ACCOUNT=
PARTNER_CDEK_SECURE=
PARTNER_CDEK_FROM_CODE=44
PARTNER_CDEK_TO_CODE=137
# PARTNER_HTTP_ACME=https://api.partner.example
# PARTNER_KEY_ACME=secret
HS_FEED_URL=
```

- JSON tariffs: `data/partner_tariffs/<code>.json` (`example_*` ignored)  
- HS seed: `python -m agents.hs_feed`  
- Migration: `infra/migrations/001_hs_duty_rates.sql`

### Google Calendar

```env
GOOGLE_CALENDAR_ENABLED=true
GOOGLE_CALENDAR_ID=primary
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
GOOGLE_OAUTH_REFRESH_TOKEN=
```

Refresh token must include Calendar events scope  
(or reuse `MAIL_OAUTH_*` if the same Google Cloud client has both scopes).  
ICS without Google: `GET /calendar/export.ics`

### Doppler
1. https://www.doppler.com → project/config  
2. CLI + service token  
3. `.\scripts\load-secrets.ps1`

### `PROMPTS_DIR`
Override path to `packages/prompts` (mainly Docker).

---

## 13. Readiness checklist

### Level A — stack up
- [ ] `.env` from example  
- [ ] Docker postgres/redis/minio  
- [ ] `/health` on `:3000` and `:8000`

### Level B — smart dialogue
- [ ] `OPENAI_API_KEY`  
- [ ] Prefer `DEEPSEEK_API_KEY`

### Level C — Telegram ops
- [ ] Bot + managers + exec channel  
- [ ] User session + gateway

### Level D — rate mail
- [ ] SMTP/IMAP credentials  
- [ ] `PARTNER_QUOTE_EMAILS` or CDEK/HTTP

### Level E — calls
- [ ] SIP provider + firewall  
- [ ] Realtime key + transfer number  
- [ ] After-hours message verified

### Level F — production polish
- [ ] `ALLOW_MOCK_RATES=false`  
- [ ] `INTERNAL_API_TOKEN`  
- [ ] Google Calendar sync  
- [ ] `python -m agents.hs_feed`  
- [ ] Langfuse (optional)

---

## 14. Common mistakes

| Symptom | Cause | Fix |
|---------|-------|-----|
| API 502 | Orchestrator down | Start uvicorn `:8000` |
| Silent TG | Bad session / hours | Re-login · check work hours |
| `smtp_not_configured` | Prod without SMTP | Fill mail or unset `MAIL_REQUIRE_SMTP` |
| `/internal` 401 | Token mismatch | Align `INTERNAL_API_TOKEN` |
| `[license] REFUSED` | Grace ended / bad key | Set valid `LICENSE_KEY` · `node scripts/issue-license.mjs` |
| Demo partners in KP | Mocks allowed | `ALLOW_MOCK_RATES=false` |
| Calendar empty | Flag/scope | Enable + Calendar OAuth scope |
| pnpm junction errors | Renamed folder | Wipe `node_modules` → `pnpm install` |
| OCR no re-quote | Workers/API down | Ensure workers + orchestrator healthy |

---

## 15. Quick links

| Service | URL |
|---------|-----|
| Telegram API | https://my.telegram.org |
| BotFather | https://t.me/BotFather |
| OpenAI | https://platform.openai.com |
| DeepSeek | https://platform.deepseek.com |
| Gmail app passwords | https://myaccount.google.com/apppasswords |
| Yandex security | https://id.yandex.ru/security |
| Zadarma | https://zadarma.com |
| Langfuse | https://langfuse.com |
| MinIO docs | https://min.io/docs |
| Doppler | https://www.doppler.com |

---

## 🔗 Related docs

- [INDEX.md](INDEX.md) · [RUNBOOK.md](RUNBOOK.md) · [COMMANDS.md](COMMANDS.md) · [ARCHITECTURE.md](ARCHITECTURE.md) · [PLAN_COMPLIANCE.md](PLAN_COMPLIANCE.md) · [../README.md](../README.md)

<p align="center">🔐 Env slab complete · turn keys · go live</p>
