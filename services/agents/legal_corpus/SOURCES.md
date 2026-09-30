# Legal corpus sources

Replace / extend dumps under `dumps/` and HS rates under `hs_rates/`.

## Official portals

- https://customs.gov.ru/ — ФТС России
- https://www.eurasiancommission.org/ — Евразийская экономическая комиссия (ТН ВЭД ЕАЭС)
- Решения Коллегии ЕЭК по ставкам ввозных таможенных пошлин

## Local feeds

- `hs_rates/seed_cn_ru_common.json` — стартовый курируемый набор частых CN→RU кодов
- `HS_FEED_URL` — HTTP JSON/CSV обновление (`python -m agents.hs_feed`)
- `python -m agents.legal_corpus.import_dumps --src <dir>` — импорт txt/md дампов

## Disclaimer

Ставки в seed — рабочие ориентиры для автоматизации КП; финальная классификация и пошлина подтверждаются брокером по актуальным решениям ЕЭК/ФТС.
