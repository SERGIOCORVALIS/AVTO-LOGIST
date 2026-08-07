<pre>
╔══════════════════════════════════════════════════╗
║  📚 LEGAL SOURCES · EEC · FTS · LOCAL FEEDS      ║
╚══════════════════════════════════════════════════╝
</pre>

# 📚 Legal corpus sources

Replace / extend dumps under `dumps/` and HS rates under `hs_rates/`.

## Official portals

- https://customs.gov.ru/ — Federal Customs Service (Russia)
- https://www.eurasiancommission.org/ — Eurasian Economic Commission (EAEU HS)
- EEC Board decisions on import customs duty rates

## Local feeds

- `hs_rates/seed_cn_ru_common.json` — curated starter set for common CN→RU codes
- `HS_FEED_URL` — HTTP JSON/CSV refresh (`python -m agents.hs_feed`)
- `python -m agents.legal_corpus.import_dumps --src <dir>` — import txt/md dumps

## Disclaimer

Seed rates are working estimates for KP automation. Final HS classification and duty must be confirmed by a broker against current EEC/FTS decisions.
