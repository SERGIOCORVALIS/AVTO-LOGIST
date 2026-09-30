# Академия логиста → AutoLogistics OS

Учебник TRANSINVEST вшит в рантайм бота как операционный мозг логиста.

## Источники

| Артефакт | Путь |
|----------|------|
| Учебник | `TRANSINVEST_AI_Logist_TZ_v1/Академия_логиста_TRANSINVEST_версия_1.md` |
| Исполняемый слой | `services/agents/academy.py` |
| System prompt | `packages/prompts/gpt/academy.md` |
| ТЗ (приоритет чисел) | `TRANSINVEST_AI_Logist_TZ_v1/` + `services/agents/tz_policy.py` |

## Правило конфликта

**ТЗ Александры важнее** по марже (18/10), НДС 22%, RFQ 10–20, стопам (налив / частный переезд / санкции / серые схемы).  
Академия заполняет технологию: схемы маршрутов, плечи себестоимости, чек-листы RFQ/КП, DG, удалённые регионы. Цифры из лекций — benchmark, не тариф.

## Куда подключено

1. **Диалог** — `concierge` (+ `style_client.md`, `orchestrator.md`, staff_instructions) / `negotiator` / `customs` / `legal` / `voice_concierge` + `academy.md`
2. **Выбор схем** — `transport_options.suggest_modes` / `international_alternatives`
3. **Готовность к расчёту** — `readiness.classify_calculation` (MSDS, Incoterms, remote RU)
4. **RFQ email** — `procurement.sanitize_rfq_payload` → `academy_rfq` → `apps/workers-ts/src/email.ts`
5. **КП** — `quote_pipeline` + `negotiator` (включено / не включено / free time / scheme)
6. **Каталог LLM** — `catalog.compact_catalog_for_llm()["academy"]`
7. **Policy** — `academy_enabled`, `academy_in_kp`, `academy_in_rfq`, `academy_in_voice`
8. **Env** — `ACADEMY_ENABLED`, `ACADEMY_IN_KP`, `ACADEMY_IN_RFQ`, `ACADEMY_IN_PROMPTS`, `ACADEMY_IN_VOICE` (`.env` / `.env.example`)
9. **DB** — `infra/migrations/007_academy_policy.sql` + `init.sql`

## Проверка

```powershell
cd services
.\.venv\Scripts\python.exe -m pytest tests\test_business_logic.py -k academy -q
```

См. также: [ARCHITECTURE.md](ARCHITECTURE.md), [RUNBOOK.md](RUNBOOK.md), [IMPROVEMENTS.md](IMPROVEMENTS.md).
