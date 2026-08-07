<pre>
╔══════════════════════════════════════════════════╗
║  💱 VAT & CUSTOMS · AI CONTEXT NOTES             ║
╚══════════════════════════════════════════════════╝
</pre>

# 💱 VAT & customs payments (AI context)

Working guide for **preliminary** RF / EAEU import estimates (always confirm with a broker):

## Base
- Customs value (CV) — usually invoice value (+ freight/insurance when Incoterms require it).
- **Never** understate the invoice.

## Duty
- `duty_rub = CV * duty_pct / 100`
- `duty_pct` depends on the EAEU HS code (prefer `hs_duty_rates` DB).

## VAT
- Default import VAT in RF is often **20%** (0% / 10% only with proven grounds).
- `vat_rub = (CV + duty_rub + excise_rub) * vat_pct / 100`

## Other lines
- Excise — for excisable goods only.
- Broker / warehouse / inspection — separate lines.
- Certification / DoC / marking — separate lines.

Mark every KP figure as a **preliminary estimate** until HS + invoice are confirmed.
