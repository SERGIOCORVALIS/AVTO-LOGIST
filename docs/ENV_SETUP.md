# Подробная инструкция по заполнению `.env`

Этот документ объясняет **каждую** переменную окружения AutoLogistics OS:

- что означает;
- обязательна ли для старта;
- где зарегистрироваться;
- как получить значение (пошагово);
- как используется в системе.

**Шаблон (premium):** [`.env.example`](../.env.example) — единая нумерованная структура (~270 ключей).  
**Рабочий файл:** `.env` (копия шаблона + ваши секреты).  
Скопируйте: `copy .env.example .env` (Windows) или `cp .env.example .env` (Linux/macOS).  
**Никогда не коммитьте `.env` с реальными секретами.**

Бизнес-правила ТЗ: [BUSINESS_LOGIC_TZ.md](BUSINESS_LOGIC_TZ.md) · Академия: [ACADEMY.md](ACADEMY.md).

============================================================================================

## 0. Premium `.env` — как устроена настройка

### Структура файла (секции 1–16)

| # | Блок в `.env` / `.env.example` | Зачем при настройке |
|---|-------------------------------|---------------------|
| 1 | Core runtime | `NODE_ENV`, логи, `ALO_ENV`, лицензия |
| 2 | API / Orchestrator / Web | порты, JWT, учётки кабинета |
| 3 | Redis / Postgres / S3 | данные; на Windows Docker часто `POSTGRES_PORT=5434` |
| 4 | Rates / RFQ | email поставщиков; ПЭК/ДЛ ок; СДЭК не auto-RFQ |
| 5 | Company | юрлицо в договорах, голосе, подписи почты |
| 6 | Commercial policy (ТЗ v1) | маржа 18/10, прибыль 3000, НДС 22%, RFQ, Академия |
| 7 | OpenAI | GPT + Realtime + embeddings |
| 8 | Proxy PROXY6 | Telegram/GPT; SIP **не** через этот прокси |
| 9–10 | Telegram user + Management Bot | клиенты и approve |
| 11 | Mail | Gmail / Яндекс / custom |
| 12 | Voice SIP | Zadarma / Билайн |
| 13 | Langfuse | опционально |
| 14 | Cabinцы / HTTP partners | login ≠ quote API |
| 15 | Google Calendar | опционально |
| 16 | Python / Doppler | `PROMPTS_DIR`, секреты |

Правила оформления:

- Одна строка = `KEY=value` (без пробела вокруг `=`).
- Комментарии — **только** отдельной строкой `# ...`. Не пишите `VALUE=1 # комментарий`: dotenv съест `#` как часть значения.
- Дубликатов ключей быть не должно (последний победит — путаница при настройке).
- `.env` и `.env.example` должны иметь **одинаковый набор ключей**; секреты в example пустые.

### Как система читает весь файл

| Кто | Как |
|-----|-----|
| Node (`api`, `workers`, `tg-gateway`, `voice`) | `loadRootEnv()` из `@alo/shared` — грузит **корневой** `.env` целиком |
| Python orchestrator | `python-dotenv` + `Settings` — все ключи в `os.environ`; коммерция ещё через `tz_policy.policy_from_env()` |
| `.\scripts\start.ps1` | прокидывает **все** ключи `.env` в дочерние процессы (+ `ALO_ROOT`) |
| Docker Compose | `docker compose --env-file .env ...` |
| Приоритет коммерции | дефолты кода ← `.env` ← `policy_config` (кабинет директора / `/policy`) |

После смены `.env` нужен **перезапуск** сервисов (`stop.ps1` → `start.ps1`), иначе старые значения останутся в памяти процессов.

### Команды обслуживания `.env`

```powershell
# Аудит: дубли, битые URL, пустые критичные ключи → logs/env-audit.json
node scripts/audit-env.mjs

# Пересобрать premium-структуру обоих файлов (секреты из текущего .env сохраняются)
# Бэкап: logs/env.premium-bak , logs/env.example.premium-bak
node scripts/write-premium-env.mjs

# Подтянуть .env в текущую PowerShell-сессию
.\scripts\load-secrets.ps1
```

### Быстрый чеклист «настройка понятна»

1. `copy .env.example .env` (если файла ещё нет).
2. Заполнить минимум: `DATABASE_URL`, `REDIS_URL` (часто уже ок).
3. Дальше по порядку раздела 2: OpenAI → Bot → User TG → Mail → SIP.
4. Блок **6 Commercial** — оставить дефолты ТЗ или подправить; тонкая настройка потом в кабинете директора.
5. `node scripts/audit-env.mjs` — `missingInEnv` / `duplicatesEnv` пустые.
6. `.\scripts\start.ps1` → health API `:3000` и orchestrator `:8000`.

============================================================================================

## Оглавление

============================================================================================
0. [Premium `.env` — как устроена настройка](#0-premium-env--как-устроена-настройка)
1. [Минимальный старт (локально)](#1-минимальный-старт-локально)
2. [Порядок подключения сервисов](#2-порядок-подключения-сервисов)
3. [Core: runtime, БД, Redis, S3](#3-core-runtime-бд-redis-s3)
3a. [Компания / юрлицо](#3a-компания--юрлицо)
4. [Коммерческая политика](#4-коммерческая-политика)
5. [OpenAI (GPT + Realtime)](#5-openai-gpt--realtime)
6. [Legal / таможня / договоры (GPT)](#6-legal--таможня--договоры-gpt)
7. [Telegram: user-аккаунт (клиенты)](#7-telegram-user-аккаунт-клиенты)
8. [Telegram: Management Bot + каналы](#8-telegram-management-bot--каналы)
    - [8.5 Peer-режим с логистом](#85-peer-режим-с-логистом-группа--канал)
9. [Почта: Gmail / Яндекс / custom](#9-почта-gmail--яндекс--custom)
10. [Голос: SIP (Zadarma / Билайн) + Voice Gateway](#10-голос-sip-zadarma--билайн--voice-gateway)
    - [10.0 Выбор провайдера](#100-быстрый-выбор-zadarma-или-билайн)
    - [10.1 Zadarma пошагово](#101-пошагово-zadarma)
    - [10.2 Билайн пошагово](#102-пошагово-билайн-бизнес)
    - [10.3 Режимы REGISTER / SIP URI](#103-два-режима-подключения-оба-провайдера)
    - [10.4 Переменные SIP](#104-переменные-sip--подробно)
    - [10.5 Персона голоса](#105-персона-голоса-openai-realtime)
    - [10.6 Сеть и Docker](#106-сеть-docker-и-миграции-бд)
    - [10.7 Проверка](#107-проверка-что-всё-работает)
    - [10.8 Минимальный `.env`](#108-готовый-минимальный-env-скопируйте-и-заполните)
11. [Observability (Langfuse)](#11-observability-langfuse)
12. [Партнёры HTTP / Doppler / прочее](#12-партнёры-http--doppler--прочее)
13. [Чеклист готовности](#13-чеклист-готовности)
14. [Типичные ошибки](#14-типичные-ошибки)

============================================================================================

## 1. Минимальный старт (локально)

После `.\scripts\setup.ps1` Docker поднимает Postgres / Redis / MinIO.  
Файл `.env` создаётся из premium-шаблона `.env.example` (если его ещё нет).

Для **проверки API + orchestrator + workers** достаточно:

| Переменная | Значение из примера | Зачем |
|------------|---------------------|--------|
| `DATABASE_URL` | `postgresql://alo:alo@localhost:5432/autologistics` | CRM, сделки |
| `POSTGRES_PORT` | `5432` (или `5434`, если 5432 занят) | Публикация порта Docker Postgres |
| `REDIS_URL` | `redis://localhost:6379` | Очереди BullMQ |
| `API_URL` | `http://localhost:3000` | Связь сервисов |
| `ORCHESTRATOR_URL` | `http://localhost:8000` | Deal loop |
| `S3_*` | значения MinIO из примера | Файлы (можно оставить) |

Остальное (Telegram, LLM, почта, голос) — **по мере нужды**. Без `OPENAI_API_KEY` система работает в heuristic/dev mode (упрощённый диалог, без «живого» GPT).

```powershell
copy .env.example .env
# при конфликте порта Postgres: в .env поставьте POSTGRES_PORT=5434
# и DATABASE_URL=postgresql://alo:alo@localhost:5434/autologistics
.\scripts\setup.ps1
node scripts/audit-env.mjs
.\scripts\start.ps1
# Проверка:
curl http://localhost:3000/health
curl http://localhost:8000/health
```

============================================================================================

## 2. Порядок подключения сервисов

Рекомендуемый порядок (от простого к сложному):

```text
1. Core (БД/Redis)          ← уже в .env.example
2. OpenAI                   ← диалог, котировки, таможня/договоры, голос
3. Telegram Bot + Channel   ← управление и алерты
4. Telegram User account    ← общение с клиентами в TG
5. Mail (Gmail/Yandex)      ← запросы ставок перевозчикам
6. SIP (Zadarma/Билайн) + Voice ← приём звонков
7. Langfuse / Doppler       ← опционально
```

============================================================================================

## 3. Core: runtime, БД, Redis, S3

### `NODE_ENV`

| | |
|--|--|
| **Что** | Режим Node: `development` / `production` / `test` |
| **Где взять** | Сами задаёте |
| **По умолчанию** | `development` |
| **Как работает** | Влияет на логирование и поведение библиотек |

### `LOG_LEVEL` / `LOG_DIR`

| | |
|--|--|
| **Что** | Уровень логов (`debug`\|`info`\|`warn`\|`error`) и папка `./logs` |
| **Где взять** | Сами |
| **Как работает** | Сервисы пишут структурированные логи в `logs/api`, `logs/gateway`, `logs/voice` и т.д. |

См. [logs/README.md](../logs/README.md).

### `LICENSE_KEY`

| | |
|--|--|
| **Что** | Лицензионный ключ AutoLogistics OS (проприетарное ПО) |
| **Где взять** | У автора (Панков С.В.) по письменному соглашению |
| **Пробный период** | 12 месяцев с первой установки/запуска (`data/.alo_install.json`) |
| **Как работает** | Пока trial активен — ключ не обязателен. После истечения без валидного ключа сервисы не стартуют. Ключ можно положить в `.env` или в `data/.alo_license`. Автор генерирует: `pnpm license:mint -- --subject "Клиент" --days 365` |

### `API_PORT` / `API_HOST` / `API_URL`

| | |
|--|--|
| **Что** | Порт/хост HTTP API и URL, по которому gateway/workers ходят в API |
| **Локально** | `3000`, `0.0.0.0`, `http://localhost:3000` |
| **Docker** | Внутри сети Compose API доступен как `http://api:3000` (задаётся в `docker-compose.yml`) |

### `ORCHESTRATOR_URL`

| | |
|--|--|
| **Что** | URL Python FastAPI оркестратора сделок |
| **Локально** | `http://localhost:8000` |
| **Как работает** | API проксирует `POST /orchestrator/process` → `POST {ORCHESTRATOR_URL}/process` |

### `REDIS_URL`

| | |
|--|--|
| **Что** | Подключение к Redis для очередей |
| **Откуда** | Локальный контейнер из `infra/docker-compose.yml` (пароль не нужен) |
| **Продакшен** | Managed Redis (Selectel, Yandex Cloud, Redis Cloud и т.п.) — вставьте URI вида `redis://:password@host:6379` |
| **Как работает** | Очереди: inbound/outbound Telegram, email, SLA, digest, voice alerts, DLQ |

Документация Redis: https://redis.io/docs/

### `DATABASE_URL`

| | |
|--|--|
| **Что** | Postgres + расширение pgvector |
| **Локально** | `postgresql://alo:alo@localhost:5432/autologistics` (создаётся Docker) |
| **Схема** | [`infra/init.sql`](../infra/init.sql); голос — [`002_voice.sql`](../infra/migrations/002_voice.sql), [`003_provider_call_id.sql`](../infra/migrations/003_provider_call_id.sql) |
| **Продакшен** | Yandex Managed PostgreSQL / Selectel / Neon / Supabase — скопируйте connection string |
| **Как работает** | Сделки, сообщения, котировки, эскалации, `call_sessions` |

Если БД уже была создана **до** голосового модуля, примените миграцию:

```powershell
# пример через docker
docker exec -i <postgres_container> psql -U alo -d autologistics < infra/migrations/002_voice.sql
```

### `S3_ENDPOINT` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` / `S3_BUCKET` / `S3_REGION`

| | |
|--|--|
| **Что** | Object storage для инвойсов, договоров, вложений |
| **Локально** | MinIO: `http://localhost:9000`, user/pass `minioadmin`, bucket `alo-files` |
| **UI MinIO** | Обычно http://localhost:9001 (если включён в compose) |
| **Продакшен** | AWS S3, Yandex Object Storage, Selectel — endpoint + ключи из консоли |
| **MinIO docs** | https://min.io/docs/minio/linux/index.html |

============================================================================================

## 3a. Компания / юрлицо

Клиентские каналы (голос, почта, Telegram-консьерж, черновики договоров) используют реквизиты **ООО «ЖД Трансинвест»**.  
Имя продукта **AutoLogistics OS** остаётся внутренним (API, digests, management bot).

Код: `packages/shared/src/company.ts`, `services/common/company.py`.  
Значения по умолчанию зашиты в код; через `COMPANY_*` можно переопределить без правки исходников.

| Переменная | Значение по умолчанию |
|------------|------------------------|
| `COMPANY_LEGAL_NAME` | `ООО «ЖД Трансинвест»` |
| `COMPANY_SHORT_NAME` | `ЖД Трансинвест` |
| `COMPANY_OGRN` | `1205400060260` |
| `COMPANY_OGRN_DATE` | `16.12.2020` |
| `COMPANY_REGISTRATION_DATE` | `16.12.2020` |
| `COMPANY_INN` / `COMPANY_KPP` | `5401401513` / `540601001` |
| `COMPANY_LEGAL_ADDRESS` | Новосибирск, Октябрьская ул, зд. 42, офис 308 |
| `COMPANY_DIRECTOR_TITLE` / `COMPANY_DIRECTOR_NAME` | Директор / Тарасова Александра Викторовна |
| `COMPANY_DIRECTOR_SINCE` | `16.12.2020` |
| `COMPANY_STATUS` | `микропредприятие` |
| `COMPANY_OKVED_CODE` / `COMPANY_OKVED_NAME` | `52.29` / вспомогательная деятельность, связанная с перевозками |
| `COMPANY_TAX_AUTHORITY` | Межрайонная ИФНС № 22 по Новосибирской области |
| `COMPANY_OKPO` / `OKATO` / `OKTMO` / `OKFS` / `OKOGU` / `OKOPF` | коды статистики (см. `.env.example`) |
| `COMPANY_PHONE` / `COMPANY_EMAIL` / `COMPANY_WEBSITE` | контакты (пока пусто — заполните сами) |

**Где используется:** приветствие и system prompt голоса (`VOICE_COMPANY_NAME` или `COMPANY_SHORT_NAME`), подпись и From почты, блок «Экспедитор» в договорах, контекст concierge/legal LLM.

============================================================================================

## 4. Коммерческая политика

Эти значения — стартовые; в runtime их перекрывает `policy_config` (кабинет директора / Management Bot `/policy`).  
Код чтения: `services/agents/tz_policy.py` → `policy_from_env()` / `merge_tz_policy()`.

| Переменная | Значение | Смысл |
|------------|----------|--------|
| `TARGET_MARGIN_PCT` | `18` | Целевая маржа в КП, % |
| `FLOOR_MARGIN_PCT` | `10` | Ниже — approve директора |
| `MAX_DISCOUNT_PCT` | `8` | Макс. скидка без approve |
| `MIN_GROSS_PROFIT_RUB` | `3000` | Прибыль ниже — эскалация |
| `ESCALATE_AMOUNT_RUB` | `500000` | Сумма КП → эскалация |
| `FIRST_REPLY_SLA_SEC` | `120` | SLA первого ответа, сек |
| `QUOTE_SLA_HOURS` | `2` | SLA выдачи расчёта, часы |
| `LEARNING_ENABLED` | `true` | Самообучение |
| `CANARY_PCT` | `10` | % canary-playbook |
| `RU_VAT_PCT` | `22` | НДС РФ (сопоставление ставок без НДС) |
| `DEFAULT_VAT_PCT` | `22` | Alias → `ru_vat_pct` (если оба заданы — побеждает `RU_VAT_PCT`) |
| `INTL_FREIGHT_VAT_PCT` | `0` | НДС на международный фрахт |
| `CLIENT_RU_SELLS_WITH_VAT` | `true` | РФ: продажа клиенту с НДС |
| `BROKER_COST_RUB` | `15000` | Себестоимость брокера |
| `BROKER_CLIENT_PRICE_RUB` | `20000` | Фикс клиенту за растаможку |
| `BROKER_DT_ITEM_LIMIT` | `4` | Позиций в ДТ до базовой ставки |
| `CERTIFICATION_MARKUP_PCT` | `5` | Наценка на сертификацию |
| `BUYOUT_COMMISSION_PCT` | `5` | Комиссия выкупа |
| `BUYOUT_FX_MARKUP_RUB` | `0.45` | Надбавка к курсу CNY→RUB |
| `PREPAY_PREFERRED_PCT` | `100` | Целевая предоплата |
| `PREPAY_MIN_PCT_UNDER_1M` | `50` | Мин. предоплата при сумме &lt; порога |
| `STAGED_PAYMENT_THRESHOLD_RUB` | `1000000` | Порог поэтапной оплаты |
| `RFQ_TARGET_MIN` / `MAX` / `COUNT` | `10` / `20` / `15` | Ориентир числа рыночных расчётов |
| `IMPORTER_SCHEME` | `manual` | manual \| client \| transinvest |
| `CUSTOMS_CONFIRMED_AUTONOMY_THRESHOLD` | `500` | Автономия по подтверждённым ТН ВЭД |
| `HS_ALWAYS_PRELIMINARY_FOR_CLIENT` | `true` | Клиенту всегда «предварительный» ТН ВЭД |
| `FOLLOWUP_DEFAULT_HOURS` | `24,72,168` | Напоминания после КП |
| `FOLLOWUP_URGENT_HOURS` | `2` | Срочный follow-up |
| `FOLLOWUP_OPERATIONAL_SILENCE_HOURS` | `2.5` | Тишина в исполнении → пинг |
| `SHIPMENT_URGENT_DAYS` | `14` | Горизонт «срочной» отгрузки |
| `VIP_VOLUME_MIN` / `MAX` | `5` / `50` | Пороги VIP по объёму |
| `LONG_ROUTE_COMPARE_KM` | `2100` | Сравнение авто vs контейнер |
| `NIGHT_EXPRESS_ENABLED` | `true` | Ночной экспресс в продукте |
| `ACADEMY_ENABLED` | `true` | Мастер-флаг Академии логиста |
| `ACADEMY_IN_KP` | `true` | КП: включено/не включено, free time, scheme |
| `ACADEMY_IN_RFQ` | `true` | Чек-лист Академии в письмах поставщикам |
| `ACADEMY_IN_PROMPTS` | `true` | Подмешивать `academy.md` в concierge/legal |
| `ACADEMY_IN_VOICE` | `true` | Дайджест Академии в голосовом system prompt |

**Академия логиста:** учебник `TRANSINVEST_AI_Logist_TZ_v1/Академия_логиста_TRANSINVEST_версия_1.md` → `services/agents/academy.py` + `packages/prompts/gpt/academy.md`. Числа маржи/НДС/RFQ — из таблицы выше (ТЗ важнее цифр из лекций).  
Приоритет: **defaults ← `.env` ← `policy_config`**. Миграция флагов: `infra/migrations/007_academy_policy.sql`.

Где править при настройке:

1. Сначала значения в блоке **§6** файла `.env` (старт системы).
2. Потом — кабинет директора → «Политика робота» или Management Bot `/margin` `/floor` `/policy` (перекрывает env для runtime).
3. Штрафы перевозчика: `CARRIER_PENALTY_CLIENT_RUB` / `CARRIER_PENALTY_SUPPLIER_RUB` (пусто = не заданы).

Сводка бизнес-логики: [BUSINESS_LOGIC_TZ.md](BUSINESS_LOGIC_TZ.md).

**Где взять:** сами задаёте под коммерческую политику.  
**Как работает:** оркестратор читает `merge_tz_policy(policy_config)`: дефолты ← `.env` ← БД.

============================================================================================

## 5. OpenAI (GPT + Realtime)

Нужен для «живого» диалога в Telegram, парсинга писем, голосового агента (Realtime).

### Регистрация

1. Сайт: https://platform.openai.com/signup  
2. Войдите / создайте аккаунт.  
3. Пополните баланс (Billing): https://platform.openai.com/settings/organization/billing  
4. API Keys: https://platform.openai.com/api-keys → **Create new secret key**  
5. Документация API: https://platform.openai.com/docs  
6. Realtime API: https://platform.openai.com/docs/guides/realtime  

### Переменные

| Переменная | Пример | Обязательно? | Описание |
|------------|--------|--------------|----------|
| `OPENAI_API_KEY` | `sk-proj-...` | Для GPT/голоса — да | Секретный ключ. Хранить только в `.env` |
| `OPENAI_MODEL` | `gpt-5.6-sol` | Нет | Главный мозг: concierge / negotiator. Можно список через запятую |
| `OPENAI_FAST_MODEL` | `gpt-5.6-luna` | Нет | Быстрые задачи: оценка габаритов, парсинг писем |
| `OPENAI_CODING_MODEL` | `gpt-5.6-sol` | Нет | Кодирование (резерв, тот же стек) |
| `OPENAI_DOCUMENT_MODEL` | `gpt-5.6-sol` | Нет | Документы / сложный анализ: legal, customs, OCR, vision |
| `OPENAI_REASONING_EFFORT` | `high` | Нет | Для gpt-5*: `none` / `low` / `medium` / `high` |
| `OPENAI_TRANSCRIBE_MODEL` | `gpt-transcribe` | Нет | Расшифровка голосовых в Telegram и input transcription в Realtime |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Нет | Смените при Azure OpenAI / прокси |
| `OPENAI_REALTIME_MODEL` | `gpt-realtime-2.1` | Для голоса | Модель Realtime WebSocket |
| `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-large` | Нет | RAG / долговременная память (pgvector) |
| `OPENAI_TIMEOUT_SEC` | `120` | Нет | Таймаут HTTP-клиента OpenAI |
| `OPENAI_MAX_COMPLETION_TOKENS` | `32768` | Нет | Потолок ответа для reasoning-моделей |
| `GPT_DAILY_BUDGET_USD` | `0` | Нет | Дневной лимит USD, `0` = без лимита |
| `GPT_MONTHLY_BUDGET_USD` | `0` | Нет | Месячный лимит USD, `0` = без лимита |
| `GPT_BUDGET_REDIS` | `true` | Нет | Счётчик spend в Redis |

**Как работает:**

- Telegram / email → HTTP Chat Completions: concierge и negotiator берут `OPENAI_MODEL`; legal/таможня/OCR/фото — `OPENAI_DOCUMENT_MODEL`; быстрые извлечения — `OPENAI_FAST_MODEL`. Голосовые в личке → `OPENAI_TRANSCRIBE_MODEL`, затем concierge.
- Звонки → WebSocket Realtime (`OPENAI_REALTIME_MODEL`) в `apps/voice-gateway`, транскрипт входа — тот же `OPENAI_TRANSCRIBE_MODEL`.
- Без ключа: heuristic-ответы (dev), голос **не заработает**.

**Стоимость:** Realtime дороже обычного chat — следите за usage: https://platform.openai.com/usage  

============================================================================================

## 6. Legal / таможня / договоры (GPT)

Legal-агент (ТН ВЭД, compliance, черновики договоров) использует **тот же OpenAI**, что и concierge: `OPENAI_API_KEY` + `OPENAI_DOCUMENT_MODEL` (fallback `OPENAI_MODEL`). Промпт: [`packages/prompts/gpt/legal.md`](../packages/prompts/gpt/legal.md). Корпус: `services/agents/legal_corpus/`.

Без ключа OpenAI — heuristic legal + упрощённый черновик договора.

`DEEPSEEK_*` больше не читается.

---

## 7. Telegram: user-аккаунт (клиенты)

Это **не бот**, а обычный Telegram-аккаунт сотрудника, через который система пишет клиентам (GramJS).

### Регистрация API (my.telegram.org)

1. Откройте https://my.telegram.org  
2. Войдите номером телефона **того аккаунта**, который будет менеджером.  
3. **API development tools** → Create application.  
4. Заполните App title / Short name (любые).  
5. Получите:
   - `api_id` → `TG_API_ID`
   - `api_hash` → `TG_API_HASH`

Документация Telegram API: https://core.telegram.org/api  

### Получение `TG_STRING_SESSION`

```powershell
# В .env уже должны быть TG_API_ID и TG_API_HASH
pnpm --filter @alo/tg-gateway login
```

Скрипт запросит код из Telegram → выдаст длинную string-session → вставьте в `TG_STRING_SESSION`.

| Переменная | Описание |
|------------|----------|
| `TG_API_ID` | Число из my.telegram.org |
| `TG_API_HASH` | Строка из my.telegram.org |
| `TG_STRING_SESSION` | Сессия после `login` (**секрет!**) |
| `TG_WORK_HOURS_START` / `END` | Часы автоответов (например 9–21) |
| `TG_TZ` | Таймзона, `Europe/Moscow` |
| `TG_STRICT_HOURS` | `true` = вне часов не слать автоответы |
| `TG_MIN_REPLY_DELAY_MS` / `MAX` | Пауза «как человек» |
| `TG_MAX_MSGS_PER_MINUTE` | Антифлуд |

**Важно:** используйте **отдельный** рабочий аккаунт, не личный VIP. При утечке сессии — сразу перелогиньтесь (`login` заново).

### Несколько аккаунтов (опционально)

```env
TG_ACCOUNTS_JSON=[{"id":"mgr1","api_id":123456,"api_hash":"...","session":"...","manager_user_id":111,"label":"Anna"}]
TG_DEFAULT_ACCOUNT_ID=mgr1
```

Если `TG_ACCOUNTS_JSON` задан — одиночный `TG_STRING_SESSION` перекрывается.

============================================================================================

## 8. Telegram: Management Bot + каналы

### 8.1. Создать бота (BotFather)

1. В Telegram найдите [@BotFather](https://t.me/BotFather)  
2. `/newbot` → имя и username.  
3. Скопируйте токен → `TG_BOT_TOKEN`  
4. Docs bots: https://core.telegram.org/bots  

### 8.2. Узнать свой Telegram user id (для менеджеров)

Способы:

- Написать [@userinfobot](https://t.me/userinfobot) или [@getmyid_bot](https://t.me/getmyid_bot)  
- Или любой бот «get id»

Вставьте в:

```env
TG_MANAGER_IDS=123456789,987654321
```

Пустой список = доступ к командам бота **у всех**, кто ему напишет (только для dev).

### 8.3. Executive Channel (отчёты / digest)

1. Создайте **канал** в Telegram (например «ALO Exec»).  
2. Добавьте бота **администратором** (право писать сообщения).  
3. Узнайте ID канала:
   - Перешлите пост канала боту [@userinfobot](https://t.me/userinfobot) / [@getidsbot](https://t.me/getidsbot), **или**
   - Добавьте бота, напишите что-нибудь, посмотрите `chat.id` в логах gateway (часто вида `-100xxxxxxxxxx`).
4. Вставьте:

```env
TG_EXEC_CHANNEL_ID=-1001234567890
```

### 8.4. Escalation chat (спорные заказы)

1. Создайте **группу** менеджеров.  
2. Добавьте бота админом.  
3. Получите ID группы (аналогично, обычно `-100...` или `-4...`).  
4. Вставьте:

```env
TG_ESCALATION_CHAT_ID=-1009876543210
```

Если пусто — эскалации уходят в `TG_EXEC_CHANNEL_ID`.

### 8.5. Peer-режим с логистом (группа / канал)

Бот не только шлёт алерты, а **понимает обычный текст** менеджера как коллега.

```env
TG_STAFF_PEER_MODE=on
TG_STAFF_BOT_NAMES=бот,логист,alo,ало
TG_STAFF_GPT=on
TG_STAFF_FORUM=on
TG_STAFF_HISTORY_INGEST=on
TG_STAFF_HISTORY_LIMIT=300
MAIL_LLM_PARSE=true
MAIL_LLM_DRAFT=true
MAIL_LLM_INBOUND=true
```

| Режим | Поведение |
|-------|-----------|
| `on` (рекомендуется) | В DM — любой текст; в **staff-группе** (`TG_STAFF_CHAT_ID`) — весь текст менеджеров; в прочих группах — алерт/@mention/триггер/uuid |
| `all` | Любой текст в escalation/exec (может шуметь от болтовни) |
| `off` | Только слэш-команды |

**Forum-темы** (`TG_STAFF_FORUM=on`): включите Topics в группе, бот — админ с `manage_topics`. При старте создаются/находятся темы **Общее**, **Эскалации**, **RFQ**, **Обучение**. Алерты и RFQ/обучение роутятся в нужную тему; ответы — с `message_thread_id`. История тем читается один раз при boot (`TG_STAFF_HISTORY_INGEST`) или по `/staff_sync`.

**GPT во всех каналах общения:** сотрудники (Management Bot peer), клиенты (concierge TG/voice/email), поставщики (черновик RFQ `MAIL_LLM_DRAFT` + разбор ставок `MAIL_LLM_PARSE`), входящая почта клиентов без Ref (`MAIL_LLM_INBOUND` → orchestrator → SMTP-ответ).

**Примеры в группе эскалаций** (ответьте на алерт бота):

- «утверди КП» / «одобри»
- «перехвати» / «беру сам»
- «карточка» / «что там?»
- «пауза» / «верни бота»
- «скидка −3%»
- «Текст: …» / «отправляй» / «обе сделки»

В личке боту: «статус», «эскалации», «карточка Иванов», `/deal <uuid>`.

**Настройка BotFather (обязательно для группы):**

1. `/setprivacy` → выбрать бота → **Disable**  
2. Бот — админ группы `TG_ESCALATION_CHAT_ID` / `TG_STAFF_CHAT_ID` и канала `TG_EXEC_CHANNEL_ID` (права: сообщения + **manage topics**)  
3. В группе включены **Topics**  
4. Ваш numeric id в `TG_MANAGER_IDS`  
5. User-сессия (`TG_STRING_SESSION`) — участник staff-группы (мост для privacy mode + list/history тем)

Клиентский GramJS **не** обрабатывает группы/каналы как клиентские чаты (защита от флуда exec-канала). Рабочий контур с людьми — Management Bot + staff user-bridge.

| Переменная | Обязательно для продакшена? |
|------------|-----------------------------|
| `TG_BOT_TOKEN` | Да (управление) |
| `TG_MANAGER_IDS` | Да |
| `TG_EXEC_CHANNEL_ID` | Да (алерты/digest) |
| `TG_ESCALATION_CHAT_ID` / `TG_STAFF_CHAT_ID` | Желательно |
| `TG_STAFF_PEER_MODE` | `on` (рекомендуется) |
| `TG_STAFF_FORUM` | `on` (темы) |
| `TG_STAFF_BOT_NAMES` | опционально |

Полный список фраз и команд: [COMMANDS.md §2](COMMANDS.md#2-management-bot-telegram).

============================================================================================

## 9. Почта: Gmail / Яндекс / custom

Система шлёт перевозчикам запросы ставок (SMTP) и читает ответы (IMAP).

### Общие переменные

| Переменная | Описание |
|------------|----------|
| `MAIL_PROVIDER` | `gmail` \| `yandex` \| `custom` |
| `MAIL_AUTH_MODE` | `app_password` (проще) или `oauth2` (prod Gmail) |
| `MAIL_USER` | Email ящика |
| `MAIL_APP_PASSWORD` | Пароль **приложения**, не основной пароль |
| `MAIL_FROM` | Отображаемое имя: `ЖД Трансинвест <quotes@company.com>` (или полное юр. имя) |
| `MAIL_SYNC_ENABLED` | `true` — опрос IMAP |
| `MAIL_SYNC_INTERVAL_MS` | Интервал, мс (`60000` = 1 мин) |
| `MAIL_LLM_PARSE` | Парсить ставки через GPT (нужен OpenAI) |
| `MAIL_LLM_DRAFT` | GPT-черновик исходящего RFQ в стиле архива |
| `MAIL_LLM_INBOUND` | Письма клиентов без Ref → GPT-диалог + SMTP-ответ |
| `MAIL_MAX_SEND_PER_MINUTE` | Лимит исходящих |
| `MAIL_IMAP_MAILBOX` | Обычно `INBOX` |
| `MAIL_IMAP_ON_PROCESSED` | `leave` \| `archive` \| `label:...` |
| `MAIL_SUBJECT_PREFIX` | Префикс темы; к нему добавляется `Ref: {deal_id}` |
| `EMAIL_WHITELIST_DOMAINS` | Домены партнёров без ручного approve первого письма |

Пресеты хостов `GMAIL_*` / `YANDEX_*` в `.env.example` обычно **не трогайте** — workers подставят сами при `MAIL_PROVIDER=gmail|yandex`.

============================================================================================

### 9.A. Gmail (App Password) — быстрый старт

**Сайты:**

- Аккаунт Google: https://myaccount.google.com/  
- Включить 2FA: https://myaccount.google.com/signinoptions/two-step-verification  
- Пароли приложений: https://myaccount.google.com/apppasswords  
- Справка Gmail SMTP: https://support.google.com/mail/answer/7126229  

**Шаги:**

1. Включите двухфакторную аутентификацию на Google-аккаунте.  
2. Создайте App Password (тип «Почта» / «Другое»).  
3. Скопируйте 16 символов (можно с пробелами).  
4. В `.env`:

```env
MAIL_PROVIDER=gmail
MAIL_AUTH_MODE=app_password
MAIL_USER=quotes@gmail.com
MAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx
MAIL_FROM=ЖД Трансинвест <quotes@gmail.com>
MAIL_SYNC_ENABLED=true
MAIL_LLM_PARSE=true
```

**Как работает:** SMTP `smtp.gmail.com:587` исходящие; IMAP `imap.gmail.com:993` входящие с `Ref: deal_uuid`.

============================================================================================

### 9.B. Gmail OAuth2 (рекомендуется для Workspace / prod)

**Сайты:**

- Google Cloud Console: https://console.cloud.google.com/  
- OAuth consent screen + Credentials → OAuth client ID  
- Gmail API: https://developers.google.com/gmail/api/guides  

**Кратко:**

1. Создайте проект в Cloud Console.  
2. Включите **Gmail API**.  
3. OAuth consent screen (тип Internal для Workspace или External).  
4. Credentials → OAuth 2.0 Client ID (тип Desktop или Web).  
5. Получите `client_id`, `client_secret`, через OAuth Playground / свой скрипт — `refresh_token` со scope `https://mail.google.com/`.  
6. В `.env`:

```env
MAIL_PROVIDER=gmail
MAIL_AUTH_MODE=oauth2
MAIL_USER=quotes@company.com
MAIL_OAUTH_CLIENT_ID=....apps.googleusercontent.com
MAIL_OAUTH_CLIENT_SECRET=...
MAIL_OAUTH_REFRESH_TOKEN=...
MAIL_OAUTH_TOKEN_URL=https://oauth2.googleapis.com/token
```

============================================================================================

### 9.C. Яндекс Почта / Яндекс 360

**Сайты:**

- Яндекс ID безопасность: https://id.yandex.ru/security  
- Пароли приложений: https://id.yandex.ru/security/app-passwords  
- Настройки почты (включить IMAP): https://mail.yandex.ru → Настройки → Почтовые программы  
- Справка IMAP/SMTP: https://yandex.ru/support/mail/mail-clients.html  

**Шаги:**

1. Войдите в Яндекс ID → создайте пароль приложения для почты.  
2. В настройках ящика включите **IMAP**.  
3. В `.env`:

```env
MAIL_PROVIDER=yandex
MAIL_USER=quotes@yandex.ru
MAIL_APP_PASSWORD=ваш_пароль_приложения
MAIL_FROM=ЖД Трансинвест <quotes@yandex.ru>
MAIL_SYNC_ENABLED=true
```

Хосты по умолчанию: SMTP `smtp.yandex.ru:465` (SSL), IMAP `imap.yandex.ru:993`.

============================================================================================

### 9.C.1. Архив клиентских ящиков (локальная БД клиентов)

Чтобы закрыть старые платные ящики (`m5`, `m13`, `a1`, `m1` @zhdtransinvest.ru), сначала выгружаем всю историю локально, затем парсим в Postgres.

| Переменная | Описание |
|------------|----------|
| `ARCHIVE_MAILBOXES_JSON` | JSON-массив ящиков: `{id, user, password, host?, port?}` |
| `ARCHIVE_MAIL_DIR` | Корень локального архива (по умолчанию `data/mail-archive`) |
| `ARCHIVE_OWN_DOMAINS` | Свои домены (не считать клиентами), через запятую |

```env
ARCHIVE_MAIL_DIR=data/mail-archive
ARCHIVE_OWN_DOMAINS=zhdtransinvest.ru,transinvest.ru
ARCHIVE_MAILBOXES_JSON=[{"id":"m5","user":"m5@zhdtransinvest.ru","password":"...","host":"imap.yandex.ru","port":993},{"id":"m13","user":"m13@zhdtransinvest.ru","password":"..."},{"id":"a1","user":"a1@zhdtransinvest.ru","password":"..."},{"id":"m1","user":"m1@zhdtransinvest.ru","password":"..."}]
```

Команды:

```bash
pnpm --filter @alo/workers-ts exec tsx ../../scripts/mail-archive-dump.ts
pnpm db:migrate
pnpm --filter @alo/workers-ts exec tsx ../../scripts/mail-archive-ingest.ts
pnpm --filter @alo/workers-ts exec tsx ../../scripts/mail-archive-style.ts
```

Не смешивать с боевым `MAIL_USER` (RFQ-ставки). Ящики закрывать только после сверки счётчиков dump-отчёта в `logs/mail/`.

============================================================================================

### 9.D. Custom SMTP/IMAP

Если свой корпоративный сервер:

```env
MAIL_PROVIDER=custom
SMTP_HOST=mail.company.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=quotes@company.com
SMTP_PASS=...
SMTP_FROM=ЖД Трансинвест <quotes@company.com>
IMAP_HOST=mail.company.com
IMAP_PORT=993
IMAP_SECURE=true
IMAP_USER=quotes@company.com
IMAP_PASS=...
```

============================================================================================

## 10. Голос: SIP (Zadarma / Билайн) + Voice Gateway

Сервис [`apps/voice-gateway`](../apps/voice-gateway) принимает **входящие звонки** на российский номер, разговаривает с клиентом через **OpenAI Realtime** и ведёт ту же сделку (`channel=voice`), что и Telegram.

```text
Клиент звонит на ваш DID (номер РФ)
        │
        ▼
  Zadarma или Билайн бизнес   ← кто «держит» номер в PSTN
        │  SIP (сигнализация) + RTP (звук, G.711)
        ▼
  voice-gateway (:3010 HTTP + :5060 UDP)
        │  OpenAI Realtime (речь) + tools
        ▼
  API / orchestrator          ← расчёт, таможня, КП
        │
        ▼  при escalate или /takeover
  перевод (SIP REFER) на VOICE_MANAGER_TRANSFER_NUMBER
```

**Без голоса система работает.** Этот раздел нужен только если хотите принимать звонки.

### Что понадобится до настройки

| Нужно | Зачем |
|-------|--------|
| `OPENAI_API_KEY` | Голос агента (Realtime). Без ключа звонок не заговорит |
| Аккаунт **Zadarma** или **Билайн бизнес** + **номер РФ** | Входящие с городской/мобильной сети |
| SIP-логин и пароль из кабинета провайдера | Регистрация вашего сервера на транке |
| **Публичный IP** сервера (или проброс портов с роутера) | Провайдер шлёт SIP/RTP на ваш хост |
| Открытый **UDP 5060** и диапазон RTP (см. ниже) | Иначе «звонок есть, звука нет» |

Локально на ноутбуке без белого IP голос обычно **не завести** (нужен VPS или port-forward + стабильный IP). HTTP-туннель (ngrok) для SIP/RTP **не подходит**.

### 10.0. Быстрый выбор: Zadarma или Билайн?

| | Zadarma | Билайн бизнес |
|--|---------|----------------|
| Когда брать | Быстрый старт, виртуальный номер, понятный SIP | Уже есть корпоративная телефония / Облачная АТС Билайн |
| Значение `SIP_PROVIDER` | `zadarma` | `beeline` (или `beeline_business`) |
| Домен по умолчанию | `sip.zadarma.com` | `sip.beeline.ru` (часто в ЛК другой — см. ниже) |
| Сложность | Проще | Чуть сложнее (proxy, auth `user@domain`) |
| Порт SIP | 5060 (обычно) | Часто **только 5060** |

В `.env` достаточно одной строки:

```env
SIP_PROVIDER=zadarma
# или
SIP_PROVIDER=beeline
```

Допустимые алиасы для Билайн: `beeline`, `beeline_business`, `beeline-business`.

---

### 10.1. Пошагово: Zadarma

1. Зарегистрируйтесь: https://zadarma.com/ → кабинет https://my.zadarma.com/  
2. Купите / подключите **виртуальный номер РФ**.  
3. Откройте **Settings → SIP Connection** — скопируйте **SIP login** и **password**.  
4. Направьте номер на этот SIP-аккаунт (в настройках номера / PBX).  
5. В `.env`:

```env
SIP_PROVIDER=zadarma
SIP_USERNAME=ВашSipLogin
SIP_PASSWORD=ВашSipPassword
SIP_PUBLIC_HOST=203.0.113.10
SIP_URI_MODE=0
VOICE_DID_NUMBER=+74951234567
VOICE_MANAGER_TRANSFER_NUMBER=+79001234567
OPENAI_API_KEY=sk-...
```

`SIP_DOMAIN` можно не писать — подставится `sip.zadarma.com`.

6. Откройте на файрволе UDP **5060** и RTP (например **10000–10200**).  
7. Запуск: `.\scripts\start.ps1 -WithVoiceGateway`  
8. Проверка: `curl http://localhost:3010/health` → должно быть `"sip": { "active": true, "provider": "zadarma", ... }`  
9. Позвоните на DID — должна ответить «Анна» (или ваше `VOICE_AGENT_NAME`).

Документация Zadarma SIP: https://zadarma.com/en/support/faq/voip/

---

### 10.2. Пошагово: Билайн бизнес

1. Войдите в кабинет **Облачной АТС / SIP-телефонии** Билайн бизнес.  
2. Найдите карточку SIP-сотрудника или транка. Обычно там есть поля:

| Поле в ЛК Билайн | Куда в `.env` |
|------------------|---------------|
| SIP User ID / логин | `SIP_USERNAME` |
| Пароль | `SIP_PASSWORD` |
| Domain | `SIP_DOMAIN` (часто `sip.beeline.ru`, `ip.beeline.ru`, `mpbx.sip.beeline.ru`) |
| Authorization User ID | `SIP_AUTH_USERNAME` (часто `логин@домен`) |
| SIP proxy / Outbound proxy | `SIP_OUTBOUND_PROXY` (например `msk.sip.beeline.ru`) |

3. Пример `.env`:

```env
SIP_PROVIDER=beeline
SIP_DOMAIN=sip.beeline.ru
SIP_USERNAME=74951234567
SIP_PASSWORD=секрет_из_лк
# Если в ЛК Auth = 74951234567@sip.beeline.ru — можно не указывать:
# система сама сделает user@domain при SIP_PROVIDER=beeline
# SIP_AUTH_USERNAME=74951234567@sip.beeline.ru
SIP_OUTBOUND_PROXY=msk.sip.beeline.ru
SIP_PUBLIC_HOST=203.0.113.10
SIP_PORT=5060
SIP_URI_MODE=0
VOICE_DID_NUMBER=+74951234567
VOICE_MANAGER_TRANSFER_NUMBER=+79001234567
OPENAI_API_KEY=sk-...
```

4. Важно для Билайн:
   - порт SIP почти всегда **5060** (`SIP_PORT=5060`);
   - без верного `SIP_OUTBOUND_PROXY` REGISTER/звонки часто не проходят;
   - домен берите **точно как в ЛК**, не угадывайте.

5. Дальше как у Zadarma: firewall → `start -WithVoiceGateway` → `/health` → тестовый звонок.

Обзор услуги: https://moskva.beeline.ru/business/telephony/cloud-ats/sip-telefoniya/

---

### 10.3. Два режима подключения (оба провайдера)

#### Режим A — REGISTER (рекомендуется для старта)

Ваш `voice-gateway` сам регистрируется у провайдера логином/паролем (как софтфон).

| Переменная | Значение |
|------------|----------|
| `SIP_URI_MODE` | `0` |
| `SIP_USERNAME` / `SIP_PASSWORD` | из кабинета |
| `SIP_PUBLIC_HOST` | ваш публичный IP (**обязательно**) |

Плюс: не нужен отдельный «forward на SIP URI» в сложных схемах.  
Минус: нужна успешная регистрация (в логах ищите `REGISTER ok`).

#### Режим B — SIP URI (белый IP, без REGISTER)

Провайдер шлёт входящие INVITE сразу на ваш сервер. Логин для REGISTER не обязателен.

| Переменная | Значение |
|------------|----------|
| `SIP_URI_MODE` | `1` |
| `SIP_PUBLIC_HOST` | белый IP |
| В кабинете провайдера | Forwarding номера на `sip:НОМЕР@ВАШ_IP:5060` |

Плюс: меньше «магии» REGISTER.  
Минус: нужен стабильный белый IP; у Билайн настройки forwarding смотрите в ЛК.

---

### 10.4. Переменные SIP — подробно

#### `SIP_PROVIDER`

| | |
|--|--|
| **Что** | Какой пресет транка использовать |
| **Обязательно для голоса** | Да |
| **Значения** | `zadarma` · `beeline` · `beeline_business` |
| **По умолчанию** | `zadarma` |
| **Как работает** | Подставляет домен, срок REGISTER, правила auth; всё можно переопределить другими `SIP_*` |

#### `SIP_ENABLED`

| | |
|--|--|
| **Что** | Принудительно включить/выключить SIP-стек |
| **По умолчанию** | Включается сам, если заданы `SIP_PUBLIC_HOST` и (логин+пароль **или** `SIP_URI_MODE=1`) |
| **Значения** | `1` / `true` / `0` / `false` |
| **Когда ставить `0`** | Нужен HTTP gateway без телефонии |

#### `SIP_DOMAIN`

| | |
|--|--|
| **Что** | SIP-домен / realm провайдера |
| **По умолчанию** | Из пресета (`sip.zadarma.com` или `sip.beeline.ru`) |
| **Когда менять** | В ЛК указан другой домен (`ip.beeline.ru`, `mpbx.sip.beeline.ru`, …) |

#### `SIP_USERNAME` / `SIP_PASSWORD`

| | |
|--|--|
| **Что** | Логин и пароль SIP-учётки |
| **Обязательно** | В режиме A (REGISTER) — да |
| **Где взять** | Zadarma: Settings → SIP Connection; Билайн: карточка SIP в Облачной АТС |
| **Секрет** | Да — не коммитьте в git |

#### `SIP_AUTH_USERNAME`

| | |
|--|--|
| **Что** | Имя пользователя для Digest-авторизации (может отличаться от `SIP_USERNAME`) |
| **Нужно** | Чаще для Билайн |
| **Авто** | При `SIP_PROVIDER=beeline`, если логин без `@`, система подставит `логин@SIP_DOMAIN` |
| **Пример** | `74951234567@sip.beeline.ru` |

#### `SIP_OUTBOUND_PROXY`

| | |
|--|--|
| **Что** | Хост, через который слать SIP (**без** префикса `sip:`) |
| **Нужно** | Почти всегда для Билайн; для Zadarma обычно пусто |
| **Пример** | `msk.sip.beeline.ru` или то, что в ЛК как SIP proxy |
| **Как работает** | В REGISTER добавляется Route на этот proxy |

#### `SIP_URI_MODE`

| | |
|--|--|
| **Что** | `0` = REGISTER; `1` = только слушать INVITE (SIP URI) |
| **По умолчанию** | `0` |

#### `SIP_PUBLIC_HOST` / `SIP_LOCAL_IP`

| | |
|--|--|
| **Что** | `SIP_PUBLIC_HOST` — IP/hostname в Contact и SDP (должен быть доступен провайдеру из интернета) |
| **Обязательно** | Да для голоса |
| **Пример** | `203.0.113.10` (публичный IPv4 сервера) |
| **Типичная ошибка** | Указать `127.0.0.1` или LAN — звонок «молчаливый» или не поднимется |
| **`SIP_LOCAL_IP`** | Опционально; если пусто — берётся `SIP_PUBLIC_HOST` |

#### `SIP_BIND_HOST` / `SIP_PORT`

| | |
|--|--|
| **`SIP_BIND_HOST`** | На каком интерфейсе слушать (`0.0.0.0` = все) |
| **`SIP_PORT`** | UDP-порт SIP, почти всегда `5060` (Билайн часто не работает на другом) |

#### `SIP_RTP_PORT_MIN` / `SIP_RTP_PORT_MAX`

| | |
|--|--|
| **Что** | Диапазон UDP-портов под звук (RTP) |
| **По умолчанию в коде** | `10000`–`20000` |
| **В Docker** | Лучше узкий диапазон, напр. `10000`–`10200` (так в `docker-compose.yml`) |
| **Firewall** | Все порты диапазона должны быть открыты **UDP** наружу |

#### `SIP_CODEC`

| | |
|--|--|
| **Что** | `pcma` (A-law, предпочтительно в РФ) или `pcmu` (µ-law) |
| **По умолчанию** | Из пресета (`pcma`) |
| **Пустое значение** | = пресет провайдера |

#### `SIP_ALLOWED_IPS`

| | |
|--|--|
| **Что** | Белый список IP, с которых принимать SIP (через запятую) |
| **По умолчанию** | Пусто = принимать отовсюду (удобно для старта) |
| **Прод** | Можно ограничить IP провайдера, если известны |

#### `SIP_REGISTER_EXPIRES` / `SIP_KEEPALIVE_URI` / `SIP_MAX_CONCURRENT_CALLS`

| Переменная | Смысл |
|------------|--------|
| `SIP_REGISTER_EXPIRES` | Как часто обновлять REGISTER (сек). Пусто = пресет (Zadarma 600, Билайн 3600) |
| `SIP_KEEPALIVE_URI` | Куда слать OPTIONS keepalive. Пусто = proxy или domain |
| `SIP_MAX_CONCURRENT_CALLS` | Лимит одновременных звонков (по умолчанию 20) |

#### `VOICE_DID_NUMBER`

| | |
|--|--|
| **Что** | Ваш публичный номер в E.164 (`+7495…`) |
| **Обязательно** | Нет (справочно / для логов и операторов) |
| **Формат** | С `+` и кодом страны |

#### `VOICE_MANAGER_TRANSFER_NUMBER`

| | |
|--|--|
| **Что** | Куда переводить звонок живому менеджеру (escalate, команда `/takeover`) |
| **Обязательно для transfer** | Да |
| **Формат** | E.164, например `+79001234567` (мобильный или номер сотрудника) |
| **Как работает** | `voice-gateway` шлёт SIP REFER на `sip:номер@SIP_DOMAIN` через текущий транк |

#### `VOICE_GATEWAY_PORT` / `VOICE_GATEWAY_HOST` / `VOICE_GATEWAY_URL` / `VOICE_GATEWAY_PUBLIC_URL`

| Переменная | Смысл |
|------------|--------|
| `VOICE_GATEWAY_PORT` | HTTP-порт gateway, по умолчанию `3010` (`/health`, `/internal/takeover`) |
| `VOICE_GATEWAY_HOST` | Обычно `0.0.0.0` |
| `VOICE_GATEWAY_URL` | Внутренний URL для Management Bot (`http://localhost:3010`) |
| `VOICE_GATEWAY_PUBLIC_URL` | Публичный HTTPS для справок/мониторинга (**на SIP/RTP не влияет**) |

---

### 10.5. Персона голоса (OpenAI Realtime)

Эти переменные не про телефонию, а про «кто говорит» с клиентом.

#### `OPENAI_REALTIME_MODEL`

| | |
|--|--|
| **Что** | Модель Realtime API |
| **Пример** | `gpt-realtime-2.1` (fallback: `gpt-realtime`) |
| **Нужен также** | `OPENAI_API_KEY` из [§5](#5-openai-gpt--realtime) |

#### `VOICE_PERSONA`

| | |
|--|--|
| **Что** | Тембр голоса Realtime. Для качества: `marin` (жен.), `cedar` (муж.) |
| **По умолчанию** | `marin` |

#### `VOICE_COMPANY_NAME` / `VOICE_AGENT_NAME` / `VOICE_GREETING`

| Переменная | Пример | Смысл |
|------------|--------|--------|
| `VOICE_COMPANY_NAME` | `ЖД Трансинвест` | Название в приветствии (иначе берётся `COMPANY_SHORT_NAME`) |
| `VOICE_AGENT_NAME` | `Анна` | Как представляется бот |
| `VOICE_GREETING` | (пусто) | Свой текст; если пусто — шаблон «Здравствуйте, {компания}, меня зовут {агент}…» |

#### `VOICE_RECORDING_DISCLAIMER` / `VOICE_AFTER_HOURS_MODE` / `VOICE_MAX_CALL_MINUTES`

| Переменная | Смысл |
|------------|--------|
| `VOICE_RECORDING_DISCLAIMER` | `true` — учитывать в промпте, что разговор может записываться |
| `VOICE_AFTER_HOURS_MODE` | Зарезервировано (`message` / `voicemail` / `queue`) |
| `VOICE_MAX_CALL_MINUTES` | Жёсткий лимит длительности (экономия Realtime); по умолчанию `30` |

Промпт голосового агента: [`packages/prompts/gpt/voice_concierge.md`](../packages/prompts/gpt/voice_concierge.md).

---

### 10.6. Сеть, Docker и миграции БД

**Firewall (минимум):**

```text
UDP  SIP_PORT          (обычно 5060)     — сигнализация
UDP  SIP_RTP_PORT_MIN … MAX              — звук
TCP  VOICE_GATEWAY_PORT (обычно 3010)    — health / takeover из бота
```

**Docker:** сервис `voice-gateway` в [`docker-compose.yml`](../docker-compose.yml) пробрасывает `5060/udp` и узкий RTP-диапазон. На хосте `SIP_PUBLIC_HOST` должен быть IP машины/VPS, а не `127.0.0.1`.

**Миграции** (если БД уже существовала до голосового канала):

1. [`infra/migrations/002_voice.sql`](../infra/migrations/002_voice.sql) — таблица `call_sessions`, поле `channel` у deals  
2. [`infra/migrations/003_provider_call_id.sql`](../infra/migrations/003_provider_call_id.sql) — колонка `provider_call_id` (вместо старого `voximplant_call_id`)

Пример:

```powershell
docker exec -i <postgres_container> psql -U alo -d autologistics < infra/migrations/002_voice.sql
docker exec -i <postgres_container> psql -U alo -d autologistics < infra/migrations/003_provider_call_id.sql
```

Новая установка через [`infra/init.sql`](../infra/init.sql) уже содержит актуальные имена колонок.

---

### 10.7. Проверка, что всё работает

```powershell
.\scripts\start.ps1 -WithVoiceGateway
curl http://localhost:3010/health
```

Ожидаемый фрагмент ответа:

```json
{
  "ok": true,
  "service": "voice-gateway",
  "sip": {
    "active": true,
    "provider": "zadarma",
    "providerLabel": "Zadarma",
    "domain": "sip.zadarma.com",
    "publicHost": "203.0.113.10"
  }
}
```

Дальше:

1. Позвоните на `VOICE_DID_NUMBER` — услышите приветствие.  
2. Скажите задачу доставки — должен появиться/обновиться deal с `channel=voice`.  
3. В Management Bot: `/call <deal_id>` — транскрипт; `/takeover <deal_id>` — перевод на `VOICE_MANAGER_TRANSFER_NUMBER`.  
4. Логи: `logs/voice/` (см. [logs/README.md](../logs/README.md)).

Голосовой контур — только `apps/voice-gateway` (SIP + Realtime). Legacy Voximplant URL удалены.

---

### 10.8. Готовый минимальный `.env` (скопируйте и заполните)

**Вариант Zadarma:**

```env
SIP_PROVIDER=zadarma
SIP_USERNAME=
SIP_PASSWORD=
SIP_PUBLIC_HOST=
SIP_URI_MODE=0
SIP_RTP_PORT_MIN=10000
SIP_RTP_PORT_MAX=10200
VOICE_DID_NUMBER=+7
VOICE_MANAGER_TRANSFER_NUMBER=+7
VOICE_GATEWAY_PORT=3010
VOICE_GATEWAY_URL=http://localhost:3010
VOICE_COMPANY_NAME=ЖД Трансинвест
VOICE_AGENT_NAME=Анна
OPENAI_API_KEY=
OPENAI_REALTIME_MODEL=gpt-realtime-2.1
```

**Вариант Билайн:**

```env
SIP_PROVIDER=beeline
SIP_DOMAIN=
SIP_USERNAME=
SIP_PASSWORD=
# SIP_AUTH_USERNAME=
SIP_OUTBOUND_PROXY=
SIP_PUBLIC_HOST=
SIP_PORT=5060
SIP_URI_MODE=0
SIP_RTP_PORT_MIN=10000
SIP_RTP_PORT_MAX=10200d
VOICE_DID_NUMBER=+7

VOICE_MANAGER_TRANSFER_NUMBER=+7
VOICE_GATEWAY_PORT=3010
VOICE_GATEWAY_URL=http://localhost:3010
OPENAI_API_KEY=
OPENAI_REALTIME_MODEL=gpt-realtime-2.1
```

============================================================================================

## 11. Observability (Langfuse)

Опционально: трейсинг LLM.

**Сайты:**

- Langfuse Cloud: https://langfuse.com/  
- Self-host docs: https://langfuse.com/docs/deployment/self-host  
- В проекте: `docker compose -f infra/docker-compose.yml --profile observability up -d` → UI обычно http://localhost:3001  

| Переменная | Описание |
|------------|----------|
| `LANGFUSE_PUBLIC_KEY` | Public key из проекта Langfuse |
| `LANGFUSE_SECRET_KEY` | Secret key |
| `LANGFUSE_HOST` | `http://localhost:3001` или cloud URL |

Можно оставить пустым — система работает без трейсинга.

============================================================================================

## 12. Партнёры HTTP / Calendar / HS / Doppler

### HTTP / JSON тарифы

```env
ALO_ENV=production
ALLOW_MOCK_RATES=false
ALLOW_FILE_TARIFFS=true
JWT_SECRET=  # openssl rand -hex 32 — обязателен
CABINET_AUTH_REQUIRED=true
INTERNAL_API_TOKEN=long-random-secret
PARTNER_QUOTE_EMAILS=rates@partner1.com
# PARTNER_HTTP_ACME=https://api.partner.example
# PARTNER_KEY_ACME=secret
HS_FEED_URL=
```

**Production boot guard** (API + orchestrator): без `JWT_SECRET` / `INTERNAL_API_TOKEN` (API), без каналов ставок или с `ALLOW_MOCK_RATES=true` процесс **не стартует**.  
Каналы ставок (достаточно одного): `SUPPLIER_QUOTE_EMAILS` / `SUPPLIER_EMAIL_*` / `PARTNER_HTTP_*` / или `ALLOW_FILE_TARIFFS=true` + JSON в `data/partner_tariffs/` (не `example_*`).  
Baseline-файлы: `ru_ltl_baseline.json`, `cn_ru_ltl_baseline.json`, `cn_air_baseline.json`.  
Миграции: `pnpm db:migrate` (таблица `schema_migrations`, файлы `infra/migrations/001–014`).  
`/health` проверяет Postgres + Redis (HTTP 503 при сбое).

Качество RFQ / «не отвечают»:

```env
SUPPLIER_SILENT_AFTER_STREAK=3
SUPPLIER_SILENT_AFTER_HOURS=72
SEED_SUPPLIERS_ON_BOOT=true
```

После исходящего RFQ растёт `no_reply_streak`; ответ IMAP сбрасывает streak и снимает `auto:`-silent.  
Кабинет директора → **Поставщики**: вкладки В RFQ / Не отвечают / Ушли / Пауза.
Имя после `PARTNER_HTTP_` / `PARTNER_KEY_` = код партнёра.  
HTTPS-ставки/кабинеты с этой машины: `PARTNER_SSL_VERIFY` / `CABINET_SSL_VERIFY` (по умолчанию `true`; для корпоративных self-signed цепочек iSales/Keycloak — `false`), `PARTNER_HTTP_TIMEOUT_SEC` / `CABINET_HTTP_TIMEOUT_SEC`.  
`CABINET_HTTP_FESCO` / `CABINET_HTTP_ISALES` / `CABINET_HTTP_DHL` — URL логина кабинета (не quote API); `CABINET_PLAYWRIGHT=true` открывает их через Chromium с теми же SSL/timeout.  
**FESCO FIT API (рекомендуется для контейнерных расчётов):** `PARTNER_HTTP_FESCO=https://api.fesco.com/api/v1/lk/calc/fit`, `FESCO_OFFERS_URL=https://my.fesco.com/api/v2/lk/offers/fit`, `PARTNER_KEY_FESCO` (JWT, опционально для public offers), `FESCO_API_BASE` / `FESCO_OWNER` при необходимости, опционально `FESCO_HTTP_PROXY` если TLS режется. Адаптер: `services/agents/fesco_adapter.py`.  
JSON-тарифы: `data/partner_tariffs/<code>.json` (файлы `example_*.json` игнорируются). Поля `corridor` и `modes[]` фильтруют ставку по продукту.  
Каталог услуг: `data/service_catalog.json` (коридоры `ru_domestic` / `cn_import` / `international`).  
СДЭК — не авто-RFQ как quote API (`PARTNER_CDEK_*` игнор).  
ПЭК, Деловые Линии, Байкал-Сервис и др. **могут быть поставщиками сборки** (конкурент может быть поставщиком — ТЗ v1).  
В production mock запрещён; без каналов ставок сервис не поднимется (раньше была только эскалация `missing_partner_channels`).

### PEK / ДЛ live API

Адаптер: `services/agents/carrier_adapters.py` (`CarrierHttpAdapter`).

```env
PARTNER_HTTP_PEK=https://api.pecom.ru/v1/quote
PARTNER_KEY_PEK=your-api-key
PARTNER_HTTP_DELLIN=https://api.dellin.ru/v2/calculator
PARTNER_KEY_DELLIN=your-api-key
```

**Исходящий POST JSON** (универсальная форма; реальный API может отличаться — уточните у перевозчика):

```json
{
  "kg": 120,
  "weight_kg": 120,
  "route": "Москва → Санкт-Петербург",
  "origin": "москва",
  "destination": "спб",
  "corridor": "ru_domestic",
  "transport_mode": "ltl",
  "carrier": "pek"
}
```

**Ожидаемый ответ** (любое из полей цены/ETA распознаётся):

```json
{
  "price": 12500,
  "currency": "RUB",
  "eta_days_min": 3,
  "eta_days_max": 5,
  "reliability_score": 0.8,
  "valid_until": "2026-08-24T12:00:00Z"
}
```

При `404/405` на POST адаптер пробует GET с query `kg`, `route`.  
Без URL — fallback на `data/partner_tariffs/pek_ru_ltl.json` / `dellin_ru_ltl.json`.  
Тесты фикстур: `services/tests/test_carrier_adapters.py`.

### База поставщиков Trans Russia 2026

Файл `TRANSINVEST_AI_Logist_TZ_v1/Транс раша 2026.xlsx` импортирован в:

- `data/suppliers_trans_russia_2026.json` — канонический каталог (~120 компаний, ~147 email)
- таблицы `partners` / `suppliers` / `partner_contacts` (контакты сразу verified для RFQ)

```bash
pnpm seed:suppliers
# или
cd services && .venv/Scripts/python -m agents.seed_suppliers
```

При старте orchestrator сид идемпотентен (`SEED_SUPPLIERS_ON_BOOT=true`).  
RFQ выбирает до `rfq_target_max` email с фильтром по `transport_mode` / corridor; молчащие (`silent`) и ушедшие (`left_market`) не получают рассылку.  
Автопометка silent: `SUPPLIER_SILENT_AFTER_STREAK` / `SUPPLIER_SILENT_AFTER_HOURS` (workers SLA job).

Миграции бизнес-логики ТЗ: `infra/migrations/006_business_logic_tz.sql`  
(supplier DB, clients/ABC, rate_benchmarks, cashflow, execution_playbooks, follow_ups, volume_lanes).

HS feed: `python -m agents.hs_feed` загружает `services/agents/legal_corpus/hs_rates/*.json` в таблицу `hs_duty_rates`.  
Миграция на существующей БД: `infra/migrations/001_hs_duty_rates.sql`.

### Google Calendar

```env
GOOGLE_CALENDAR_ENABLED=true
GOOGLE_CALENDAR_ID=primary
# или переиспользовать MAIL_OAUTH_* (refresh token со scope calendar.events)
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
GOOGLE_OAUTH_REFRESH_TOKEN=
```

События пишутся в `calendar_events` и синкаются воркером (`sync_calendar` каждую минуту).  
ICS без Google: `GET http://localhost:3000/calendar/export.ics`.

### Doppler (секреты в проде)

1. Сайт: https://www.doppler.com/  
2. Создайте проект / config.  
3. Установите CLI, получите service token.  
4. `DOPPLER_TOKEN=...` + файл из `doppler.yaml.example`.  
5. Загрузка: `.\scripts\load-secrets.ps1`

### `PROMPTS_DIR`

Путь к промптам (обычно не нужен локально). В Docker задаётся `/app/packages/prompts`.

============================================================================================

## 13. Чеклист готовности

### Уровень 0 — файл окружения

- [ ] `.env` скопирован из premium-шаблона `.env.example`
- [ ] `node scripts/audit-env.mjs` → нет `missingInEnv` / `duplicatesEnv` / `formatIssues`
- [ ] Секреты только в `.env` (не в git)
- [ ] После правок `.env` сервисы перезапущены

### Уровень A — «поднять стек»

- [ ] Docker infra: Postgres, Redis, MinIO
- [ ] `DATABASE_URL` совпадает с `POSTGRES_PORT`
- [ ] `.\scripts\start.ps1` → `/health` на `:3000` и `:8000`

### Уровень B — «умный диалог»

- [ ] `OPENAI_API_KEY`

### Уровень C — «Telegram ops»

- [ ] `TG_BOT_TOKEN`, `TG_MANAGER_IDS`
- [ ] `TG_EXEC_CHANNEL_ID` (+ бот админ канала)
- [ ] `TG_ESCALATION_CHAT_ID` (+ бот админ группы)
- [ ] BotFather `/setprivacy` → **Disable** (peer-режим в группе)
- [ ] `TG_STAFF_PEER_MODE=on`
- [ ] `TG_API_ID` / `TG_API_HASH` / `TG_STRING_SESSION` + `start -WithGateway`

### Уровень D — «почта ставок»

- [ ] `MAIL_PROVIDER` + `MAIL_USER` + `MAIL_APP_PASSWORD` (или OAuth)
- [ ] IMAP включён у провайдера

### Уровень E — «звонки»

- [ ] `SIP_PROVIDER=zadarma` или `beeline` + номер РФ у провайдера
- [ ] `SIP_PUBLIC_HOST` + (`SIP_USERNAME`/`SIP_PASSWORD` или `SIP_URI_MODE=1`)
- [ ] Для Билайн: `SIP_DOMAIN` / `SIP_OUTBOUND_PROXY` / `SIP_AUTH_USERNAME` из ЛК
- [ ] Firewall: UDP SIP + RTP range
- [ ] `OPENAI_API_KEY` + `OPENAI_REALTIME_MODEL`
- [ ] `VOICE_MANAGER_TRANSFER_NUMBER`
- [ ] `.\scripts\start.ps1 -WithVoiceGateway`
- [ ] Миграции `002_voice.sql` и `003_provider_call_id.sql` при необходимости

============================================================================================

## 14. Типичные ошибки

| Симптом | Причина | Что сделать |
|---------|---------|-------------|
| Переменные из `.env` «не видны» | Сервисы не перезапускали / старый процесс | `.\scripts\stop.ps1` → `.\scripts\start.ps1` |
| Значение с `#` внутри (битый bool/порт) | Комментарий в той же строке, что `KEY=value` | Вынести `#` на отдельную строку; `node scripts/write-premium-env.mjs` |
| Два разных значения одного ключа | Дубликат в `.env` | `node scripts/audit-env.mjs` → убрать дубль; premium-пересборка |
| API 502 orchestrator | Оркестратор не запущен | `start.ps1`, смотреть `logs/orchestrator` |
| Postgres connection refused | Порт 5432 занят / неверный `DATABASE_URL` | `POSTGRES_PORT=5434` и тот же порт в `DATABASE_URL` |
| TG gateway не стартует | Нет session / api_id | `my.telegram.org` + `login` |
| Bot «Access denied» / «Нет доступа» | Нет вашего id в `TG_MANAGER_IDS` | Узнать id у @userinfobot |
| Бот в группе молчит на обычный текст | Privacy Mode / peer off | BotFather `/setprivacy` → Disable; `TG_STAFF_PEER_MODE=on`; ответьте на алерт или @mention |
| Алерты есть, ответить «утверди» не получается | Нет uuid в ответе / не reply | Ответьте **reply** на алерт со сделкой или укажите uuid |
| Письма не уходят | App password / 2FA | Gmail app passwords; Яндекс — пароль приложения + IMAP |
| `sip.active: false` в /health | Нет `SIP_PUBLIC_HOST` или логина | Заполните `SIP_PUBLIC_HOST` + `SIP_USERNAME`/`SIP_PASSWORD` (или `SIP_URI_MODE=1`) |
| Звонок молчит / нет RTP | NAT / неверный `SIP_PUBLIC_HOST` / закрыт UDP RTP | Белый IP или port-forward **SIP+RTP**; `SIP_PUBLIC_HOST` = внешний IP, не 127.0.0.1 |
| REGISTER 401/403 (Zadarma) | Неверный login/password | Кабинет → Settings → SIP Connection; пересоздайте пароль |
| REGISTER fail (Билайн) | Неверный domain / proxy / auth | Сверьте `SIP_DOMAIN`, `SIP_OUTBOUND_PROXY`, `SIP_AUTH_USERNAME` с ЛК; порт 5060 |
| Звонок сбрасывается сразу | Нет `OPENAI_API_KEY` / Realtime ошибка | Ключ OpenAI + логи `logs/voice/` |
| Transfer не доходит до менеджера | Пустой `VOICE_MANAGER_TRANSFER_NUMBER` | Задайте E.164 `+7900...`; проверьте, что транк умеет REFER/исходящие |
| Нет колонок call_sessions / provider_call_id | Старая БД | `002_voice.sql` + `003_provider_call_id.sql` |
| Дорогой Realtime | Длинные звонки | `VOICE_MAX_CALL_MINUTES` |
| Маржа/НДС «не те» после правки `.env` | Перекрыто `policy_config` в БД | Кабинет директора / `/policy` или правка `policy_config` |

============================================================================================

## Быстрые ссылки (сводка)

| Сервис | Регистрация / кабинет | Документация |
|--------|----------------------|--------------|
| OpenAI | https://platform.openai.com/signup | https://platform.openai.com/docs |
| OpenAI Keys | https://platform.openai.com/api-keys | Realtime: https://platform.openai.com/docs/guides/realtime |
| Telegram API | https://my.telegram.org | https://core.telegram.org/api |
| BotFather | https://t.me/BotFather | https://core.telegram.org/bots |
| Gmail App Passwords | https://myaccount.google.com/apppasswords | https://support.google.com/mail/answer/7126229 |
| Google Cloud OAuth | https://console.cloud.google.com/ | https://developers.google.com/gmail/api |
| Яндекс пароли приложений | https://id.yandex.ru/security/app-passwords | https://yandex.ru/support/mail/mail-clients.html |
| Zadarma | https://my.zadarma.com/ | https://zadarma.com/en/support/ |
| Билайн бизнес (SIP) | кабинет Облачной АТС | https://moskva.beeline.ru/business/telephony/cloud-ats/sip-telefoniya/ |
| Cloudflare Tunnel | https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/ | — |
| ngrok | https://ngrok.com/ | — |
| Langfuse | https://langfuse.com/ | https://langfuse.com/docs |
| Doppler | https://www.doppler.com/ | — |
| Redis | — | https://redis.io/docs/ |
| MinIO | — | https://min.io/docs/minio/linux/index.html |

============================================================================================

## Связанные документы

- [RUNBOOK.md](RUNBOOK.md) — запуск, почта, голос (кратко)
- [COMMANDS.md](COMMANDS.md) — CLI и команды бота
- [ARCHITECTURE.md](ARCHITECTURE.md) — схема сервисов
- [BUSINESS_LOGIC_TZ.md](BUSINESS_LOGIC_TZ.md) — коммерция ТЗ v1
- [ACADEMY.md](ACADEMY.md) — Академия логиста
- [PLAN_COMPLIANCE.md](PLAN_COMPLIANCE.md) — покрытие плана
- [`.env.example`](../.env.example) — premium-шаблон переменных
- Скрипты: `scripts/audit-env.mjs`, `scripts/write-premium-env.mjs`, `scripts/load-secrets.ps1`
