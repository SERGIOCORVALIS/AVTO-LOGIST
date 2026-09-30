# Runbook — AutoLogistics OS

## Bootstrap (install + start + docker rebuild)

```powershell
.\scripts\setup.ps1
.\scripts\start.ps1
.\scripts\start.ps1 -WithGateway
.\scripts\start.ps1 -WithVoiceGateway
.\scripts\docker-rebuild.ps1
.\scripts\load-secrets.ps1
.\scripts\stop.ps1 -DockerToo
```

**Полный справочник команд:** [COMMANDS.md](COMMANDS.md)  
**Бизнес-логика ТЗ v1:** [BUSINESS_LOGIC_TZ.md](BUSINESS_LOGIC_TZ.md)  
**Настройка `.env` (premium, секции 1–16, аудит):** [ENV_SETUP.md](ENV_SETUP.md) §0  
**Академия логиста (обучение AI):** [ACADEMY.md](ACADEMY.md)

## Environment (`.env`)

Шаблон и рабочий файл — **одинаковая структура** (`\.env.example` → `\.env`).

```powershell
copy .env.example .env          # первый раз
node scripts/audit-env.mjs      # проверка дублей / пустых критичных
node scripts/write-premium-env.mjs   # пересобрать структуру (секреты сохранятся)
.\scripts\load-secrets.ps1      # ключи в текущую сессию PowerShell
```

`start.ps1` передаёт **весь** `.env` в api / workers / gateway / orchestrator.  
После правок — перезапуск. Подробности: [ENV_SETUP.md §0](ENV_SETUP.md#0-premium-env--как-устроена-настройка).

## Prod cutover (пилот на одном сервере)

Чеклист перед `ALO_ENV=production`:

1. **Секреты** — сгенерировать и вставить в `.env` (не коммитить):
   ```powershell
   node scripts/generate-prod-secrets.mjs
   pnpm license:mint
   ```
   Обязательно: `JWT_SECRET`, `INTERNAL_API_TOKEN`, `LICENSE_KEY`, `OPENAI_API_KEY`, `TG_BOT_TOKEN`, пароли `CABINET_*`, сильный `POSTGRES_PASSWORD` + обновить `DATABASE_URL`.

2. **Аудит** — `node scripts/audit-env.mjs` → все critical `set`, без placeholder.

3. **CORS** — `CABINET_CORS_ORIGIN=https://cabinet.your-domain.ru` (через запятую несколько origin).

4. **TLS** — шаблон [`apps/web/nginx.prod.conf.example`](../apps/web/nginx.prod.conf.example) или внешний reverse-proxy; наружу только 443/80 (Postgres/Redis/MinIO не публиковать).

5. **Bootstrap**:
   ```powershell
   pnpm db:migrate
   pnpm seed:suppliers
   docker compose --env-file .env up -d --build
   ```
   TG userbot: `.\scripts\start.ps1 -WithGateway` (GramJS session).

6. **Проверка** — `GET /health` → 200; login в кабинет; один RFQ без `ALLOW_MOCK_RATES=true`.

7. **Пилот** — `REQUIRE_HUMAN_KP_APPROVE=true`; утверждение КП в боте/кабинете.

## Масштабирование (фаза 3)

| Задача | Команда / env |
|--------|----------------|
| Несколько worker-процессов | `docker compose up -d --scale workers=3` |
| Managed Redis | `REDIS_URL=rediss://...` + persistence у провайдера |
| TG pool | `TG_ACCOUNTS_JSON` — несколько менеджерских аккаунтов |
| RBAC | роли `director` / `manager` в `staff_users` |

BullMQ `jobId` dedup защищает от двойных digest/alert при нескольких workers.

## Logs

Папка `logs/` (создаётся setup/start):

```powershell
Get-Content .\logs\audit\current.log -Wait -Tail 40
Get-Content .\logs\api\current.log -Wait -Tail 50
Get-Content .\logs\orchestrator\current.log -Wait -Tail 50
Get-Content .\logs\voice\current.log -Wait -Tail 50
```

См. [logs/README.md](../logs/README.md).

## Academy of the logist (обучение AI)

Учебник: `TRANSINVEST_AI_Logist_TZ_v1/Академия_логиста_TRANSINVEST_версия_1.md`  
Код: `services/agents/academy.py` · промпт: `packages/prompts/gpt/academy.md`

При конфликте с ТЗ Александры приоритет у ТЗ (маржа/НДС/RFQ/стопы). Академия даёт схемы маршрутов, плечи, чек-листы RFQ/КП, DG и удалённые регионы.

Проверка:

```powershell
cd services
.\.venv\Scripts\python.exe -m pytest tests\test_business_logic.py -k academy -q
```

Отключить: в `.env` `ACADEMY_ENABLED=false` или слойно `ACADEMY_IN_VOICE=false` / `ACADEMY_IN_KP=false` / `ACADEMY_IN_RFQ=false` / `ACADEMY_IN_PROMPTS=false`.  
БД (существующий volume): после поднятия Postgres выполнить  
`Get-Content .\infra\migrations\007_academy_policy.sql -Raw | docker compose exec -T postgres psql -U alo -d autologistics`  
(на свежей БД ключи уже в `infra/init.sql`).

## Secrets
Never commit `.env`. Rotate:
- `TG_STRING_SESSION` after any suspicion of leak (re-run `login`)
- `TG_BOT_TOKEN`, OpenAI
- `MAIL_APP_PASSWORD` / OAuth refresh tokens

Backup `TG_STRING_SESSION` and mail app passwords to a password manager.
For production prefer Doppler/Vault instead of plaintext `.env`.

## GramJS session
1. Create app at https://my.telegram.org → `TG_API_ID`, `TG_API_HASH`
2. `pnpm --filter @alo/tg-gateway login`
3. Paste session into `.env`
4. Use a dedicated employee account (not personal VIP)

## Management Bot / staff room
1. BotFather → token → `TG_BOT_TOKEN`
2. Admin в Executive Channel → `TG_EXEC_CHANNEL_ID`
3. Staff / escalation chat → `TG_ESCALATION_CHAT_ID` (или `TG_STAFF_CHAT_ID`); BotFather `/setprivacy` → **Disable**
4. `TG_MANAGER_IDS=123,456`
5. `TG_STAFF_PEER_MODE=on` + `TG_STAFF_GPT=on` — обычный язык; быстрые действия на regex, остальное через GPT (`staff_peer.md`)
6. Примеры: «статус», «эскалации», ответом на алерт «утверди КП» / «перехвати»; подсказки «Текст RFQ: …» / «только на a@b.ru» → `ops_hint`
7. Slash: `/deal` `/takeover` `/escalations` `/staff_sync` `/call` `/accounts`

## Anti-ban
- `TG_MIN_REPLY_DELAY_MS` / `TG_MAX_REPLY_DELAY_MS`
- `TG_MAX_MSGS_PER_MINUTE`
- `TG_WORK_HOURS_START` / `END`
- Prefer `/takeover` for sensitive chats instead of aggressive automation

## Mail: Gmail / Yandex / custom

### Quick Gmail
```env
MAIL_PROVIDER=gmail
MAIL_USER=quotes@gmail.com
MAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx
MAIL_FROM=ЖД Трансинвест <quotes@gmail.com>
MAIL_SYNC_ENABLED=true
MAIL_LLM_PARSE=true
MAIL_LLM_DRAFT=true
MAIL_LLM_INBOUND=true
```
App passwords: https://myaccount.google.com/apppasswords (2FA required).

### Gmail OAuth2 (production)
```env
MAIL_PROVIDER=gmail
MAIL_AUTH_MODE=oauth2
MAIL_USER=quotes@company.com
MAIL_OAUTH_CLIENT_ID=...
MAIL_OAUTH_CLIENT_SECRET=...
MAIL_OAUTH_REFRESH_TOKEN=...
```

### Quick Yandex
```env
MAIL_PROVIDER=yandex
MAIL_USER=quotes@yandex.ru
MAIL_APP_PASSWORD=...
MAIL_FROM=ЖД Трансинвест <quotes@yandex.ru>
MAIL_SYNC_ENABLED=true
```
Passwords: https://id.yandex.ru/security — enable IMAP in mailbox settings.

### Behaviour
- Outbound SMTP subject: `Запрос ставки Ref: {deal_uuid}`; тело — GPT-черновик при `MAIL_LLM_DRAFT=true` (`style_supplier`)
- Inbound IMAP poll every `MAIL_SYNC_INTERVAL_MS` (default 60s)
- Письма с `Ref:` + цена → `quotes` + reprocess КП (`MAIL_LLM_PARSE`)
- Письма **без** Ref (клиент) → classify (`MAIL_LLM_INBOUND`) → orchestrator GPT → SMTP reply
- `EMAIL_WHITELIST_DOMAINS` — trusted partner domains; others need first-email approve
- Rate limit: `MAIL_MAX_SEND_PER_MINUTE`
- FESCO FIT (контейнер): `PARTNER_HTTP_FESCO` / `FESCO_OFFERS_URL` — живой HTTP, не только email

## Observability
```bash
docker compose -f infra/docker-compose.yml --profile observability up -d
# Langfuse UI http://localhost:3001
```

### Langfuse в production

1. **Self-hosted:** `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` из UI Langfuse; `LANGFUSE_HOST=http://langfuse:3000` в docker-сети или `https://langfuse.your-domain`.
2. **Langfuse Cloud:** ключи из проекта на langfuse.com; `LANGFUSE_HOST=https://cloud.langfuse.com`.
3. Смените `LANGFUSE_NEXTAUTH_SECRET` и `LANGFUSE_SALT` (не `change-me`).
4. После одного LLM-вызова (intake в TG) — trace `orchestrator` / `gpt_*` в UI.

### GPT budget (пилот)

```env
GPT_DAILY_BUDGET_USD=25
GPT_MONTHLY_BUDGET_USD=500
GPT_BUDGET_REDIS=true
```

`0` = без лимита. При превышении LLM-вызов блокируется, агенты уходят в эвристики.

## Почта и перевозчики (P0)

См. разделы **Mail** выше и [ENV_SETUP](ENV_SETUP.md) (FESCO / PEK / ДЛ).

- Живой IMAP/SMTP или OAuth: `MAIL_SYNC_ENABLED=true`, `MAIL_LLM_PARSE/DRAFT/INBOUND=true`
- Контейнер: FESCO FIT (`PARTNER_HTTP_FESCO` / `FESCO_OFFERS_URL`)
- ПЭК/ДЛ при ключах: `PARTNER_HTTP_PEK`, `PARTNER_HTTP_DELLIN`, `PARTNER_KEY_*`
- Без ключей — lane JSON в `data/partner_tariffs/` при `ALLOW_FILE_TARIFFS=true`
- Сид поставщиков: `pnpm seed:suppliers` (+ опционально `pnpm seed:associations`)

## Playbook canary
1. Proposal in `playbook_versions` status `pending_approve`
2. Management Bot `/playbooks` → Canary / Reject
3. After metrics OK → set `active`, old → `retired`
4. CEO digest shows 7d winrate/margin by playbook lane

## DLQ
```sql
SELECT * FROM dead_letter_jobs ORDER BY created_at DESC LIMIT 50;
```

## Таможня и НДС

В КП и `cost_breakdown` теперь отдельные поля: `duty`, `vat`, `broker`, `certs`.

Формула и статус плана: [PLAN_COMPLIANCE.md](PLAN_COMPLIANCE.md).

Env: `DEFAULT_VAT_PCT=22` (или `RU_VAT_PCT`), `TG_ESCALATION_CHAT_ID` — чат спорных заказов + peer-режим с логистом.

## Voice — SIP (Zadarma / Билайн) + OpenAI Realtime

1. Выберите провайдера: `SIP_PROVIDER=zadarma` или `beeline` (`beeline_business`)
2. Режим A: `SIP_USERNAME` / `SIP_PASSWORD` + `SIP_PUBLIC_HOST` (REGISTER)  
   Режим B: `SIP_URI_MODE=1` + белый IP, DID → `sip:did@host:5060`
3. Билайн: задайте `SIP_DOMAIN`, `SIP_OUTBOUND_PROXY`, при необходимости `SIP_AUTH_USERNAME` из ЛК
4. Firewall: UDP `SIP_PORT` (5060) и RTP range
5. `.env`: `OPENAI_API_KEY`, `VOICE_MANAGER_TRANSFER_NUMBER`
6. Management Bot: `/call`, `/takeover` — SIP REFER
7. Миграция: `003_provider_call_id.sql` при старой БД

Запуск: `.\scripts\start.ps1 -WithVoiceGateway` или Docker `voice-gateway`.
