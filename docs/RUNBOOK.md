<pre>
╔══════════════════════════════════════════════════════════════╗
║  🛰️  RUNBOOK · OPS · SECRETS · INCIDENTS · VOICE             ║
╚══════════════════════════════════════════════════════════════╝
</pre>

# 🛰️ Runbook — AutoLogistics OS

> Day-2 operations for the 3D stack: bootstrap → channels → mail → voice → learning.

📚 [COMMANDS.md](COMMANDS.md) · [ENV_SETUP.md](ENV_SETUP.md) · [PLAN_COMPLIANCE.md](PLAN_COMPLIANCE.md)

---

## 🚀 Bootstrap

```powershell
.\scripts\setup.ps1
.\scripts\start.ps1
.\scripts\start.ps1 -WithGateway
.\scripts\start.ps1 -WithVoiceGateway
.\scripts\docker-rebuild.ps1
.\scripts\load-secrets.ps1
.\scripts\stop.ps1 -DockerToo
```

---

## 📜 Logs

```powershell
Get-Content .\logs\audit\current.log -Wait -Tail 40
Get-Content .\logs\api\current.log -Wait -Tail 50
Get-Content .\logs\orchestrator\current.log -Wait -Tail 50
Get-Content .\logs\voice\current.log -Wait -Tail 50
```

See [logs/README.md](../logs/README.md).

---

## 🔐 Secrets

Never commit `.env`. Rotate on suspicion:

- 🔑 `TG_STRING_SESSION` → re-run `pnpm --filter @alo/tg-gateway login`
- 🤖 `TG_BOT_TOKEN`, OpenAI, DeepSeek
- 📧 `MAIL_APP_PASSWORD` / OAuth refresh tokens
- 🗓️ Google Calendar refresh token

Backup sessions & mail secrets in a password manager. Prefer **Doppler/Vault** in production.

---

## 💬 GramJS session

1. https://my.telegram.org → `TG_API_ID`, `TG_API_HASH`
2. `pnpm --filter @alo/tg-gateway login`
3. Paste session into `.env`
4. Use a **dedicated work account** (not personal VIP)

### 🛡️ Anti-ban

- `TG_MIN_REPLY_DELAY_MS` / `TG_MAX_REPLY_DELAY_MS`
- `TG_MAX_MSGS_PER_MINUTE`
- `TG_WORK_HOURS_START` / `END`
- Prefer `/takeover` for sensitive chats

---

## 🎛️ Management Bot

1. BotFather → `TG_BOT_TOKEN`
2. Add bot as admin to Executive Channel → `TG_EXEC_CHANNEL_ID`
3. `TG_MANAGER_IDS=123,456`
4. Deal card: `/deal <uuid>` → Approve KP / Cut −3% / Takeover / Reject

---

## 📧 Mail: Gmail / Yandex / custom

### Gmail (app password)

```env
MAIL_PROVIDER=gmail
MAIL_USER=quotes@gmail.com
MAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx
MAIL_FROM=ZHD Transinvest <quotes@gmail.com>
MAIL_SYNC_ENABLED=true
MAIL_LLM_PARSE=true
```

### Gmail OAuth2 (prod)

```env
MAIL_PROVIDER=gmail
MAIL_AUTH_MODE=oauth2
MAIL_USER=quotes@company.com
MAIL_OAUTH_CLIENT_ID=...
MAIL_OAUTH_CLIENT_SECRET=...
MAIL_OAUTH_REFRESH_TOKEN=...
```

### Yandex

```env
MAIL_PROVIDER=yandex
MAIL_USER=quotes@yandex.ru
MAIL_APP_PASSWORD=...
MAIL_SYNC_ENABLED=true
```

### Behaviour

- Outbound subject: `Rate request Ref: {deal_uuid}`
- IMAP poll every `MAIL_SYNC_INTERVAL_MS` (default 60s)
- `Ref:` → quote row + channel alert + **auto re-quote**
- Whitelist: `EMAIL_WHITELIST_DOMAINS`
- Rate limit: `MAIL_MAX_SEND_PER_MINUTE`
- Prod without SMTP: set `MAIL_REQUIRE_SMTP=true` (fail closed)

---

## 🗓️ Google Calendar

```env
GOOGLE_CALENDAR_ENABLED=true
GOOGLE_CALENDAR_ID=primary
# reuse MAIL_OAUTH_* or set GOOGLE_OAUTH_*
```

Worker job `sync_calendar` every minute. ICS fallback: `GET /calendar/export.ics`.

---

## 🔭 Observability

```bash
docker compose -f infra/docker-compose.yml --profile observability up -d
# Langfuse UI → http://localhost:3001
```

Set `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` / `LANGFUSE_HOST`.

---

## 📈 Playbook canary

1. Proposal lands in `playbook_versions` as `pending_approve`
2. Bot `/playbooks` → Canary / Reject
3. Metrics OK → `active`, old → `retired`
4. CEO digest shows 7d winrate/margin by lane

Playbook `body` merges into pricing policy (`target_margin_pct`, floor, discounts).

---

## 🧯 DLQ

```sql
SELECT * FROM dead_letter_jobs ORDER BY created_at DESC LIMIT 50;
```

---

## ⚖️ Customs & VAT

KP / `cost_breakdown` fields: `duty`, `vat`, `broker`, `certs`.  
Duty % from `hs_duty_rates` when available. Refresh: `python -m agents.hs_feed`.

See [PLAN_COMPLIANCE.md](PLAN_COMPLIANCE.md).

---

## 📞 Voice — SIP + Realtime

1. `SIP_PROVIDER=zadarma` or `beeline`
2. Mode A: REGISTER (`SIP_USERNAME` / `SIP_PASSWORD` + `SIP_PUBLIC_HOST`)  
   Mode B: `SIP_URI_MODE=1` + DID → `sip:did@host:5060`
3. Firewall: UDP `SIP_PORT` + RTP range
4. `OPENAI_API_KEY`, `VOICE_MANAGER_TRANSFER_NUMBER`
5. After-hours: `VOICE_AFTER_HOURS_MODE=message` (09–19 MSK default)
6. Bot: `/call`, `/takeover`

Start: `.\scripts\start.ps1 -WithVoiceGateway`

---

## 🚨 Incident cheatsheet

| Symptom | Fix |
|---------|-----|
| API 502 orchestrator | Check `:8000` / `ORCHESTRATOR_URL` |
| No TG replies | Session / work hours / rate limits |
| Email `smtp_not_configured` | Fill SMTP or unset `MAIL_REQUIRE_SMTP` in dev |
| `/internal` 401 | Align `INTERNAL_API_TOKEN` |
| Demo partners in KP | `ALLOW_MOCK_RATES=false` + real partner channels |
| Calendar silent | Enable flag + OAuth Calendar scope |
| pnpm junction errors | Delete `node_modules` → `pnpm install` |

---

<p align="center">🛰️ Runbook locked · stay calm · stay white-lane</p>
