# Implemented improvements checklist

## P0
- [x] IMAP sync + Message-ID idempotency
- [x] LLM quote extract (`MAIL_LLM_PARSE`)
- [x] Gmail OAuth2 path (`MAIL_AUTH_MODE=oauth2`)
- [x] Management Bot deal card `/deal` + KP actions
- [x] HTTP partner adapter interface (`PARTNER_HTTP_*`)
- [x] Legal corpus loader for DeepSeek

## P1
- [x] A/B playbook metrics in CEO digest
- [x] Calibration on close (existing learning loop + actual weight)
- [x] Multi-currency → RUB (`common/fx.py`)
- [x] Attachments endpoint + OCR stub
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
