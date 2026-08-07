<pre>
╔══════════════════════════════════════════════════════════════╗
║  ✅ PLAN COMPLIANCE · 100% CODE-COMPLETE · SCOPE C + GCAL    ║
╚══════════════════════════════════════════════════════════════╝
</pre>

# 🗺️ Plan Compliance — AutoLogistics OS

**Audit date:** 2026-08-07  
**Scope:** Full production path including Google Calendar

> 🧊 Every contour below sits on the same 3D stack: channels → queues → agents → data.

---

## 📊 Coverage matrix

| 🧩 Block | Status | Notes |
|----------|--------|-------|
| 💬 Telegram client (GramJS) | ✅ DONE | `apps/tg-gateway` |
| 🎛️ Management Bot + escalations | ✅ DONE | + `TG_ESCALATION_CHAT_ID` |
| 📡 Executive Channel | ✅ DONE | digest + alerts |
| 📦 Cargo dims / weight | ✅ DONE | client / past-deal / LLM / DDG + OCR → re-quote |
| ⚖️ Customs HS / duty / VAT | ✅ DONE | `hs_duty_rates` feed + customs/legal wiring |
| 📬 Rate hunting API + email | ✅ DONE | CDEK / HTTP / JSON tariffs + auto enqueue |
| 💰 Pricing / floor / negotiation | ✅ DONE | playbook → policy; email counter-offers |
| 📜 DeepSeek contracts | ✅ DONE | corpus RAG + duty/VAT clauses |
| 🗓️ Calendar / SLA | ✅ DONE | BullMQ + Google Calendar + ICS export |
| 📈 Learning | ✅ DONE | calibration / playbooks / embeddings |
| 🚫 Grey hard block | ✅ DONE | |
| 🧾 Audit / logs | ✅ DONE | `logs/` |
| 📧 Gmail / Yandex | ✅ DONE | |
| 👥 Multi-TG | ✅ DONE | |
| 📞 Voice SIP + Realtime | ✅ DONE | after-hours message mode |
| 🔭 Observability | ✅ DONE | Langfuse (`LANGFUSE_*`) |
| 🧰 Bootstrap / CI | ✅ DONE | typecheck + pytest + compose e2e |

### 🏆 Score

**100% of the product plan (code-complete).**  
For live production, fill `.env` keys: Google Calendar OAuth scope, SMTP/IMAP, optional CDEK, OpenAI/DeepSeek, Langfuse.

---

## 🧮 Customs formula

```text
        ┌─────────────────────────────────────┐
   CV = │ invoice → RUB                       │
        └──────────────┬──────────────────────┘
                       ▼
        duty = CV × duty_pct     ← hs_duty_rates / HS candidate
        VAT  = (CV + duty + excise) × vat_pct
        clearance = duty + VAT + excise + broker + certs
        cost = freight + clearance + local + insurance + ops + risk
```

Without invoice: `duty_rub` / `vat_rub` = **null**. Category heuristic → `must_approve`.

---

## 🔐 Production env keys

| Key | Purpose |
|-----|---------|
| `ALO_ENV=production` | Enables prod defaults |
| `ALLOW_MOCK_RATES=false` | No demo carriers in client KP |
| `PARTNER_QUOTE_EMAILS` / `PARTNER_CDEK_*` / `PARTNER_HTTP_*` | Real rate path |
| `GOOGLE_CALENDAR_ENABLED` + `GOOGLE_CALENDAR_ID` | SLA events in Google |
| `INTERNAL_API_TOKEN` | Lock `/internal/*` |
| `HS_FEED_URL` + `python -m agents.hs_feed` | Duty table refresh |

---

<p align="center">✨ Plan closed · ship with keys · stay white-lane ✨</p>
