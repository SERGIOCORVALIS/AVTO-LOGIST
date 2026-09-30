# Legal corpus overview

This folder feeds GPT legal research (`load_legal_context`).

- `VAT_DUTY_NOTES.md` / `BATTERY_NOTES.md` — operational notes
- `hs_rates/` — machine-readable duty table imported into `hs_duty_rates`
- `dumps/` — optional official text dumps (FTS/EEC)

Prefer DB lookup (`hs_duty_rates`) for numeric duty/VAT; corpus text is for citations and compliance flags.
