# Logs — AutoLogistics OS

Папка для отслеживания работы сервисов. Файлы создаются при `setup` / `start`.

## Структура

```text
logs/
  api/              HTTP API (Fastify)
  gateway/          Telegram gateway + Management Bot
  voice/            Voice gateway (SIP + OpenAI Realtime)
  workers/          SLA / digest / email / IMAP / OCR
  orchestrator/     Python deal orchestrator
  bootstrap/        setup/start/stop/docker + *.pid фоновых процессов
  audit/            эскалации, approve, grey-block, staff peer
  mail/             (опционально) отчёты mail-archive-*
  env-audit.json    результат `node scripts/audit-env.mjs`
```

Имена: `YYYY-MM-DD.log` + `current.log` (последний поток).

## Просмотр (Windows)

```powershell
Get-Content .\logs\api\current.log -Wait -Tail 50
Get-Content .\logs\orchestrator\current.log -Wait -Tail 50
Get-Content .\logs\gateway\current.log -Wait -Tail 50
Get-Content .\logs\workers\current.log -Wait -Tail 50
Get-Content .\logs\audit\current.log -Wait -Tail 30
```

## Просмотр (Linux/macOS)

```bash
tail -f logs/api/current.log
tail -f logs/orchestrator/current.log
tail -f logs/audit/current.log
```

## Переменные

| Env | Описание |
|-----|----------|
| `LOG_DIR` | Корень логов (default: `./logs`) |
| `LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` |

`start.ps1` / `start.sh` пишут PID в `logs/bootstrap/*.pid`; `stop` читает их.

Логи **не коммитятся** (кроме `README.md` и `.gitkeep`).
