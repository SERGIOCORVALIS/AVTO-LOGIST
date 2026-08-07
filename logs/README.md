<pre>
╔══════════════════════════════════════════════════════════════╗
║  📜 LOG PLANE · AutoLogistics OS · TAIL · AUDIT · ROTATE     ║
╚══════════════════════════════════════════════════════════════╝
</pre>

# 📜 Logs — AutoLogistics OS

Service telemetry lands here automatically during `setup` / `start`.

> 🧊 Treat logs as the **bottom slab** of the 3D stack — everything above writes down here.

---

## 🗂️ Tree

```text
logs/
  api/              ⚡ HTTP API (Fastify)
  gateway/          💬 Telegram gateway + management bot
  voice/            📞 SIP + OpenAI Realtime
  workers/          📬 SLA / digest / email / OCR / calendar
  orchestrator/     🧠 Python deal orchestrator
  bootstrap/        🧰 setup / start / stop / docker scripts
  audit/            🛡️ escalations, approve, grey-block, policy
```

Filenames: `YYYY-MM-DD.log` (daily rotate) + `current.log` (latest stream).

---

## 👀 Tail (Windows)

```powershell
Get-Content .\logs\api\current.log -Wait -Tail 50
Get-Content .\logs\orchestrator\current.log -Wait -Tail 50
Get-Content .\logs\audit\current.log -Wait -Tail 30
```

## 👀 Tail (Linux / macOS)

```bash
tail -f logs/api/current.log
tail -f logs/orchestrator/current.log
tail -f logs/audit/current.log
```

---

## ⚙️ Env

| Env | Meaning |
|-----|---------|
| `LOG_DIR` | Log root (default `./logs`) |
| `LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` |

Logs are **not committed** (see `.gitignore`) — only `README.md` and `.gitkeep`.

---

<p align="center">📜 Keep the audit plane warm</p>
