<pre>
╔══════════════════════════════════════════════════╗
║  ⚖️ LEGAL CORPUS · RAG FUEL · HS + COMPLIANCE    ║
╚══════════════════════════════════════════════════╝
</pre>

# ⚖️ Legal corpus overview

This folder feeds DeepSeek legal research (`load_legal_context`).

| Path | Role |
|------|------|
| `VAT_DUTY_NOTES.md` / `BATTERY_NOTES.md` | Operational notes |
| `hs_rates/` | Machine-readable duty table → `hs_duty_rates` |
| `dumps/` | Optional official text dumps (FTS / EEC) |

Prefer DB lookup (`hs_duty_rates`) for numeric duty/VAT; corpus text is for citations and compliance flags.

```bash
python -m agents.hs_feed
python -m agents.legal_corpus.import_dumps --src /path/to/dumps
```
