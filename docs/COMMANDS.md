<pre>
╔══════════════════════════════════════════════════════════════╗
║  ⌨️  COMMAND CENTER · CLI · BOT · HTTP · DOCKER              ║
╚══════════════════════════════════════════════════════════════╝
</pre>

# ⌨️ Commands — AutoLogistics OS

Full CLI, Management Bot, HTTP API, and env quick-refs.

📚 Also: [ENV_SETUP.md](ENV_SETUP.md) · [RUNBOOK.md](RUNBOOK.md) · [ARCHITECTURE.md](ARCHITECTURE.md) · [logs/README.md](../logs/README.md)

---

## 1️⃣ Install & run scripts

### 🪟 Windows (PowerShell)

| Command | Description |
|---------|-------------|
| `.\scripts\setup.ps1` | Full install: `.env`, pnpm, shared build, Python venv, Docker infra |
| `pnpm install` | Reinstall after clone/rename (fixes stale junctions) |
| `pnpm --filter @alo/shared build; pnpm -r run typecheck` | Shared build + TS check |
| `.\scripts\setup.ps1 -WithObservability` | + Langfuse profile |
| `.\scripts\setup.ps1 -SkipDocker` | Deps only |
| `.\scripts\start.ps1` | API + orchestrator + workers → `logs/` |
| `.\scripts\start.ps1 -WithGateway` | + Telegram gateway |
| `.\scripts\start.ps1 -WithVoiceGateway` | + Voice gateway (SIP + Realtime) |
| `.\scripts\start.ps1 -DockerStack` | Full compose stack |
| `.\scripts\stop.ps1` | Stop background PIDs |
| `.\scripts\stop.ps1 -DockerToo` | + `docker compose down` |
| `.\scripts\docker-rebuild.ps1` | Rebuild + force-recreate |
| `.\scripts\docker-rebuild.ps1 -NoCache` | No cache |
| `.\scripts\docker-rebuild.ps1 -InfraOnly` | postgres/redis/minio only |
| `.\scripts\load-secrets.ps1` | Doppler or `.env` into session |

### 🐧 Linux / macOS

| Command | Description |
|---------|-------------|
| `./scripts/setup.sh` | Install deps + infra |
| `WITH_OBS=1 ./scripts/setup.sh` | + observability |
| `SKIP_DOCKER=1 ./scripts/setup.sh` | No Docker |
| `./scripts/start.sh` | Local services |
| `WITH_GATEWAY=1 ./scripts/start.sh` | + gateway |
| `DOCKER_STACK=1 ./scripts/start.sh` | Docker stack |
| `./scripts/stop.sh` | Stop processes |
| `DOCKER_TOO=1 ./scripts/stop.sh` | + Docker down |
| `./scripts/docker-rebuild.sh` | Rebuild stack |

### 📦 pnpm / Make

| Command | Description |
|---------|-------------|
| `pnpm setup` / `pnpm start` / `pnpm stop` | Script wrappers |
| `pnpm start:gateway` / `pnpm start:voice` | + channel gateways |
| `pnpm dev:api` / `dev:gateway` / `dev:workers` / `dev:voice` | Watch mode |
| `pnpm docker:up` / `docker:rebuild` / `docker:infra` | Compose helpers |
| `pnpm build` / `pnpm typecheck` / `pnpm test:py` | Quality gates |
| `pnpm --filter @alo/tg-gateway login` | Obtain `TG_STRING_SESSION` |

---

## 2️⃣ Management Bot (Telegram)

Access: `TG_MANAGER_IDS` only (empty list = open to anyone who DMs the bot).

| Command | Args | Description |
|---------|------|-------------|
| `/start` `/help` | — | Welcome + command list |
| `/status` | — | Deals by status, avg margin, pending escalations |
| `/policy` | — | Current policy keys |
| `/margin` `/floor` | `<n>` | Set target / floor margin % |
| `/deal` | `<uuid>` | Deal card + inline actions |
| `/pause` `/resume` | `<uuid>` | AI mute / unmute |
| `/takeover` | `<uuid>` | Human owns chat; active call → SIP REFER |
| `/call` | `<uuid>` | Live call + recent transcript |
| `/escalations` | — | Pending Approve / Reject |
| `/playbooks` | — | Learning proposals Canary / Reject |
| `/accounts` | — | Multi-TG account list |
| `/learn_on` `/learn_off` | — | Toggle learning loop |

### 🎛️ Inline buttons

- **Escalation:** Approve → resume negotiation · Reject → `cancelled`
- **Playbook:** Canary 10% · Reject proposal
- **/deal:** Approve KP · Cut −3% · Takeover · Reject

---

## 3️⃣ HTTP API

Base: `API_URL` (default `http://localhost:3000`).

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Liveness |
| `GET` | `/stats/summary` | Ops summary |
| `GET/POST` | `/deals` | List / create |
| `GET/PATCH` | `/deals/:id` | Card / update |
| `POST` | `/deals/:id/attachments` | Base64 upload → S3/local + OCR queue |
| `GET` | `/calendar/export.ics` | SLA calendar feed |
| `POST` | `/internal/jobs/*` | Email / OCR / calendar enqueue (`x-internal-token`) |
| `POST` | `/orchestrator/process` | Proxy to Python deal loop |
| `GET` | `/calls/deal/:dealId` | Active / recent calls |
| `GET/PUT` | `/policy` | Commercial policy |
| `GET/POST` | `/playbooks…` | Playbook versions / decide |
| `GET/POST` | `/escalations…` | List / decide |

### 📞 Voice gateway (`:3010`)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Liveness + SIP stack |
| `POST` | `/internal/takeover/:dealId` | SIP REFER to manager |

### 🧠 Orchestrator (`:8000`)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Liveness |
| `POST` | `/process` | Inbound deal loop (`channel=telegram\|voice\|email`) |
| `GET` | `/deals/:id/status` | Status for voice tools |
| `POST` | `/deals/:id/close` | Close + learning (**requires** `actual_weight_kg`) |

---

## 4️⃣ Docker

| Command | Description |
|---------|-------------|
| `docker compose -f infra/docker-compose.yml up -d` | postgres, redis, minio |
| `… --profile observability up -d` | + Langfuse |
| `docker compose --env-file .env up -d --build` | Full app stack |
| `docker compose logs -f api orchestrator workers` | Follow logs |

---

## 5️⃣ Logs (`logs/`)

| Path | Content |
|------|---------|
| `logs/api/` | HTTP API |
| `logs/gateway/` | Telegram I/O |
| `logs/voice/` | SIP + Realtime |
| `logs/workers/` | SLA, email, OCR, calendar |
| `logs/orchestrator/` | Python deal loop |
| `logs/audit/` | Escalations, grey-block, approve |

```powershell
Get-Content .\logs\audit\current.log -Wait -Tail 40
```

Env: `LOG_DIR`, `LOG_LEVEL` (`debug|info|warn|error`).

---

## 6️⃣ Secrets

| Method | How |
|--------|-----|
| `.env` | `copy .env.example .env` |
| Doppler | `doppler.yaml` + `.\scripts\load-secrets.ps1` |
| Node preload | `scripts/load-secrets.cjs` |
| Python | `common.secrets.load_secrets()` |

---

## 7️⃣ Multi Telegram accounts

```env
TG_ACCOUNTS_JSON=[{"id":"mgr1","api_id":123,"api_hash":"...","session":"...","manager_user_id":111,"label":"Anna"}]
```

Router: sticky chat→account, round-robin for new chats. List via `/accounts`.

---

## 8️⃣ Mail (quick)

| Env | Meaning |
|-----|---------|
| `MAIL_PROVIDER` | `gmail` \| `yandex` \| `custom` |
| `MAIL_AUTH_MODE` | `app_password` \| `oauth2` |
| `MAIL_SYNC_ENABLED` | IMAP poll on/off |
| `MAIL_LLM_PARSE` | LLM price extract |
| `MAIL_MAX_SEND_PER_MINUTE` | Outbound anti-spam |

---

## 9️⃣ Tests

| Command | Description |
|---------|-------------|
| `pnpm test:py` | Agent unit tests |
| `pnpm -r run typecheck` | All TS packages |
| `python tests/evals/run_evals.py http://localhost:8000` | Golden scenarios vs live orch |

---

<p align="center">⌨️ Command Center online · ship with confidence</p>
