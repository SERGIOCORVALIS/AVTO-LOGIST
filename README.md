# AutoLogistics OS

Автономная операционная система логистической компании **ООО «ЖД Трансинвест»**: перевозки **по России** и **международка** (Китай — частный случай; география не ограничена Китай→РФ). Каталог режимов и услуг, GPT-квалификатор по ТЗ.

Система ведёт диалог в Telegram (лички), **по телефону** (SIP: Zadarma / Билайн + OpenAI Realtime) и **по почте** как живой менеджер; считает габариты и маржу; собирает ставки (HTTP FIT + email RFQ); готовит таможенную/юридическую оценку (GPT); выставляет КП/договоры; эскалирует в staff room и **самообучается** на исходах и подсказках логистов.

---

## Что умеет продукт

| Контур | Назначение |
|--------|------------|
| **Клиентский Telegram** | User-аккаунт (GramJS): полный цикл **только в личках** (private DM) |
| **Голосовой канал** | SIP + OpenAI Realtime: приём, транскрипт, transfer |
| **Почта** | SMTP RFQ (GPT-черновик), IMAP ставки (LLM parse), клиент без Ref → GPT → SMTP |
| **Management Bot / staff room** | Peer: обычный язык + **GPT** (`TG_STAFF_GPT`); approve KP/RFQ, takeover, ops_hint |
| **Executive Channel** | Алерты + ежедневный CEO digest (09:30 MSK) |
| **Escalation / staff chat** | Спорные заказы; логист пишет как коллеге |
| **Кабинет** | Сделки, поставщики, клиенты/архив, парсеры, политика, PDF (`apps/web`) |
| **Каталог услуг** | РФ и международка: сборка / авто / контейнеры / ЖД / море / авиа + выкуп, растаможка… |
| **GPT-оркестратор** | Диалог, торг, план сделки, Structured Outputs |
| **Rate Hunter** | FESCO FIT / PEK·ДЛ + SMTP RFQ по mode (10–20) |
| **Learning Loop** | Калибровка, partner score, canary playbooks, staff-room coach |

### Жизненный цикл сделки

`intake → sizing → customs → quoting → pricing → negotiation → contract → execution → closed_won|closed_lost`

В любой момент возможен статус `awaiting_manager` (эскалация).

---

## Архитектура (кратко)

```text
Клиент: TG DM | Voice SIP | Email
        ↓
  tg-gateway / voice-gateway / workers (IMAP)
        ↓
  api (Fastify) → orchestrator (Python)
                    ├── Concierge / Negotiator / Academy (GPT)
                    ├── quote_pipeline + FESCO / carriers
                    ├── RFQ queues → workers SMTP (GPT draft)
                    └── Legal / Learning
        ↓
  Management Bot (staffPeer + staffPeerGpt) · Cabinet (web)
        ↓
  Postgres + Redis + MinIO
```

Подробнее: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/ENV_SETUP.md](docs/ENV_SETUP.md) · [docs/COMMANDS.md](docs/COMMANDS.md) · [docs/BUSINESS_LOGIC_TZ.md](docs/BUSINESS_LOGIC_TZ.md) · [docs/RUNBOOK.md](docs/RUNBOOK.md) · [docs/PLAN_COMPLIANCE.md](docs/PLAN_COMPLIANCE.md) · [logs/README.md](logs/README.md).

---

## Стек

| Слой | Технологии |
|------|------------|
| **apps/tg-gateway** | TypeScript, GramJS, grammY, BullMQ |
| **apps/voice-gateway** | TypeScript, Fastify, OpenAI Realtime, SIP/RTP |
| **apps/api** | Fastify, pg, Zod |
| **apps/web** | Vite cabinet (director/manager) |
| **apps/workers-ts** | BullMQ, Nodemailer, IMAP, OCR |
| **services/** | Python 3.11+, FastAPI, OpenAI SDK, psycopg |
| **packages/shared** | Типы, queues, openai, staffCopy, company |
| **packages/prompts** | System prompts (в т.ч. `staff_peer`, `style_*`) |
| **infra** | Docker Compose: Postgres+pgvector, Redis, MinIO, Langfuse |

---

## Требования

- Node.js **≥ 20**, pnpm **9+** (через corepack)
- Python **≥ 3.11**
- Docker Desktop (Postgres / Redis / MinIO)
- Аккаунты (по мере выхода из dev mode):
  - Telegram API + user-сессия + BotFather bot
  - OpenAI
  - Корпоративная почта **Gmail** и/или **Яндекс** (см. ниже)

---

## Быстрый старт (автоустановка)

### Windows (рекомендуется)

Двойной клик по **`install.bat`** в корне репозитория: поставит Node.js LTS, Python 3.12, Git и Docker Desktop (если их нет), создаст `.env`, установит зависимости и запустит API + orchestrator + workers.

```bat
install.bat
install.bat /gateway
install.bat /voice
install.bat /obs
install.bat /setup-only
install-docker.bat
install-docker.bat /rebuild
docker-rebuild.bat
docker-rebuild.bat /nocache
stop.bat
stop.bat /docker
```

Ключи OpenAI / Telegram / почта / SIP в `.env` нужно заполнить вручную. После первой установки Docker Desktop часто нужна перезагрузка Windows — затем снова запустите `install.bat` или `install-docker.bat`.

- **`install.bat`** — локальный режим (процессы на Windows + infra в Docker).  
- **`install-docker.bat`** — весь стек приложений в Docker (кабинет на `:8080`).  
- **`docker-rebuild.bat`** — пересборка всех образов и recreate контейнеров.

Или по шагам в PowerShell:

```powershell
# 1) Установка зависимостей + Docker infra (postgres/redis/minio)
.\scripts\setup.ps1

# 2) Запуск API + orchestrator + workers (фоном, логи в logs/)
.\scripts\start.ps1

# С Telegram gateway (после заполнения TG_* в .env):
.\scripts\start.ps1 -WithGateway

# С голосовым gateway (SIP Zadarma/Билайн + OpenAI Realtime):
.\scripts\start.ps1 -WithVoiceGateway

# 3) Полный Docker-стек приложений (пересборка образов)
.\scripts\docker-rebuild.ps1
# без кэша:
.\scripts\docker-rebuild.ps1 -NoCache

# Остановка локальных процессов (+ Docker при необходимости)
.\scripts\stop.ps1
.\scripts\stop.ps1 -DockerToo
```

Эквиваленты через npm-скрипты: `pnpm setup` · `pnpm start` · `pnpm docker:rebuild` · `pnpm stop`.

### Linux / macOS

```bash
chmod +x scripts/*.sh
./scripts/setup.sh
./scripts/start.sh
WITH_GATEWAY=1 ./scripts/start.sh
./scripts/docker-rebuild.sh
NO_CACHE=1 ./scripts/docker-rebuild.sh
DOCKER_TOO=1 ./scripts/stop.sh
```

### Что делают скрипты

| Скрипт | Действие |
|--------|----------|
| `install.bat` | Windows: winget (Node/Python/Git/Docker) + `setup` + `start`, ждёт `/health` |
| `install-docker.bat` | Windows: установка/настройка + полный Docker-стек (`compose up --build`) |
| `docker-rebuild.bat` | Windows: пересборка всех Docker-образов + recreate |
| `stop.bat` | Windows: остановка локальных процессов (`/docker` — ещё и Compose) |
| `setup` | `.env`, pnpm install, build shared, Python venv, `docker compose` infra up |
| `start` | infra + uvicorn:8000 + api + workers + **web** (+ gateway/voice по флагам) |
| `docker-rebuild` | `build --force-recreate` всего стека (api/orchestrator/workers + infra) |
| `stop` | Гасит фоновые PID из `logs/bootstrap/*.pid` |

### Ручной старт (по шагам)

#### 1. Клонирование и env

```bash
cd c:\AVTO-logist_RU
copy .env.example .env
# Заполните минимум: DATABASE_URL, REDIS_URL (дефолты ок для Docker)
# GPT / TG / MAIL / SIP — по мере выхода из dev
```

Все переменные подробно прокомментированы в [`.env.example`](.env.example).

#### 2. Инфраструктура

```bash
docker compose -f infra/docker-compose.yml up -d postgres redis minio
```

Схема БД применяется из `infra/init.sql` при первом старте Postgres.

Проверка: `GET http://localhost:3000/health` (после запуска API).

#### 3. Node-приложения

```bash
pnpm install
pnpm --filter @alo/shared build

pnpm dev:api        # http://localhost:3000
pnpm dev:web        # кабинет http://localhost:5173
pnpm dev:gateway    # Telegram I/O + Management Bot
pnpm dev:workers    # SLA / digest / email / OCR
pnpm dev:voice      # SIP + Realtime (опционально)
```

#### 4. Python-оркестратор

```bash
cd services
python -m venv .venv
.\.venv\Scripts\activate          # Windows
# source .venv/bin/activate       # macOS/Linux
pip install -e ".[dev]"
uvicorn orchestrator.app:app --reload --port 8000
```

#### 5. Telegram (user-аккаунт)

1. Приложение на https://my.telegram.org → `TG_API_ID`, `TG_API_HASH`
2. Логин:
   ```bash
   pnpm --filter @alo/tg-gateway login
   ```
3. Вставить `TG_STRING_SESSION` в `.env`
4. BotFather → `TG_BOT_TOKEN`; канал отчётов → `TG_EXEC_CHANNEL_ID`; менеджеры → `TG_MANAGER_IDS`

**Важно:** используйте отдельный рабочий аккаунт, не личный VIP. См. anti-ban в Runbook.

### Dev mode

Без ключей TG / OpenAI / SMTP система стартует:

- ответы клиенту пишутся в лог gateway;
- concierge/legal на эвристиках, если нет `OPENAI_API_KEY`;
- mock-ставки **только** при `ALLOW_MOCK_RATES=true` (в production запрещены).

### Production checklist

1. `ALO_ENV=production` и `ALLOW_MOCK_RATES=false`
2. Поставщики: `pnpm seed:suppliers` и/или `SUPPLIER_QUOTE_EMAILS` / `PARTNER_HTTP_*` / FESCO FIT
3. SMTP/IMAP + `MAIL_REQUIRE_SMTP=true`; флаги `MAIL_LLM_PARSE/DRAFT/INBOUND=true`
4. `TG_STAFF_GPT=on`, `TG_STAFF_PEER_MODE=on`, BotFather privacy **Disable**
5. `INTERNAL_API_TOKEN`, `JWT_SECRET`, `LICENSE_KEY`
6. `pnpm db:migrate` (миграции `001`–`014`)
7. Опционально: Calendar OAuth, Langfuse profile, `pnpm seed:associations`

---

## Реализованные улучшения (из рекомендаций)

- **Gmail/Yandex OAuth2** + Calendar sync + ICS export
- **IMAP** + GPT parse/draft/inbound client mail; OCR invoice → re-quote
- **Staff peer + GPT** (`staffPeerGpt`, `ops_hint`, forum topics)
- **FESCO FIT** + PEK/ДЛ adapters; file tariffs только fallback
- **Мультивалюта** CBR + Frankfurter, FX lock на оферте
- **Playbooks** + embeddings RAG + learning coach
- **Поставщики** Trans Russia seed + PSZhVS + associations parser + silent quality loop
- **Кабинет**: deals, partners, clients/archive, parsers, PDF КП/договор
- **Langfuse** + **CI** e2e smoke + GPT budgets
- **Voice** SIP after-hours

Подробнее: [docs/IMPROVEMENTS.md](docs/IMPROVEMENTS.md) · [docs/RUNBOOK.md](docs/RUNBOOK.md).

---

## Почта: Gmail и Яндекс.Почта

Система использует почту в двух направлениях:

1. **SMTP (исходящие)** — запросы ставок логистическим компаниям  
2. **IMAP (входящие)** — синхронизация ответов со ставками, привязка к `deal_id` по `Ref:` в теме/теле

Выберите провайдер через `MAIL_PROVIDER=gmail|yandex|custom`.

### Gmail

| Параметр | Значение |
|----------|----------|
| SMTP | `smtp.gmail.com:587` (STARTTLS) |
| IMAP | `imap.gmail.com:993` (SSL) |

**Настройка**

1. В Google-аккаунте включите 2FA.
2. Создайте [пароль приложения](https://myaccount.google.com/apppasswords) для «Почта».
3. В `.env`:
   ```env
   MAIL_PROVIDER=gmail
   MAIL_USER=your.company@gmail.com
   MAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx
   MAIL_FROM=ЖД Трансинвест <your.company@gmail.com>
   MAIL_SYNC_ENABLED=true
   ```
4. Для Workspace предпочтительнее OAuth2 (`MAIL_AUTH_MODE=oauth2`) — см. рекомендации ниже.

### Яндекс.Почта

| Параметр | Значение |
|----------|----------|
| SMTP | `smtp.yandex.ru:465` (SSL) или `:587` STARTTLS |
| IMAP | `imap.yandex.ru:993` |

**Настройка**

1. [Яндекс ID → Безопасность](https://id.yandex.ru/security) → пароли приложений.
2. В настройках почты включите доступ по IMAP.
3. В `.env`:
   ```env
   MAIL_PROVIDER=yandex
   MAIL_USER=your.company@yandex.ru
   MAIL_APP_PASSWORD=ваш_пароль_приложения
   MAIL_FROM=ЖД Трансинвест <your.company@yandex.ru>
   MAIL_SYNC_ENABLED=true
   YANDEX_SMTP_SECURE=true
   ```

### Как работает sync

- Воркер `alo:email` периодически читает IMAP-папку (`MAIL_IMAP_MAILBOX=INBOX`).
- Письма с `Ref: <deal_uuid>` матчятся к сделке.
- Текст/вложения сохраняются; цена/срок парсятся эвристикой (далее — LLM).
- Новая ставка → `quotes` + опциональный алерт в Executive Channel.
- Whitelist доменов: `EMAIL_WHITELIST_DOMAINS`; новый домен — approve первого письма.

Шаблоны пресетов и полный список переменных — в `.env.example` (секция Mail).

---

## Management Bot — команды и peer-режим

Пишите обычным языком в личку боту или в группу эскалаций (ответ на алерт / @mention):  
«статус», «эскалации», «карточка &lt;uuid&gt;», «утверди КП», «перехвати», «пауза».

| Команда | Действие |
|---------|----------|
| `/status` | Сводка сделок / маржа / эскалации |
| `/policy` | Текущая политика маржи |
| `/margin 18` | Целевая маржа % |
| `/floor 10` | Минимальная (floor) маржа % |
| `/deal <deal_id>` | Карточка + кнопки Утвердить КП / −3% / Перехватить / Отклонить |
| `/pause <deal_id>` | Пауза AI по сделке |
| `/resume <deal_id>` | Снять паузу |
| `/takeover <deal_id>` | Человек перехватывает чат |
| `/escalations` | Pending + inline Approve/Reject |
| `/playbooks` | Предложения самообучения → Canary/Reject |
| `/learn_on` `/learn_off` | Вкл/выкл learning loop |

Env: `TG_STAFF_PEER_MODE=on`, `TG_ESCALATION_CHAT_ID`, BotFather `/setprivacy` → Disable.  
Подробнее: [docs/COMMANDS.md](docs/COMMANDS.md) · [docs/ENV_SETUP.md §8](docs/ENV_SETUP.md#8-telegram-management-bot--каналы).
---

## Политика авто vs человек

**Автоматически:** квалификация, оценка габаритов (с оговоркой), сбор ставок, вилка КП в пределах политики, follow-up, digest, торг до floor.

**Только с approve:** маржа &lt; floor; скидка &gt; max; сумма &gt; `ESCALATE_AMOUNT_RUB`; высокий legal/customs uncertainty; договор с нестандартом; запрещённые товары; takeover.

**Hard block:** любые «серые» схемы (занижение инвойса, обход пошлин) → отказ клиенту + эскалация + запись в learning (без обучения на сером).

Дефолты: target **18%**, floor **10%**, max discount **8%**, порог суммы **500 000 ₽**.

---

## Тесты и evals

```bash
cd services
.\.venv\Scripts\python -m pytest tests/test_agents.py -q

# при запущенном orchestrator:
python ..\tests\evals\run_evals.py http://localhost:8000
```

---

## Структура репозитория

```text
apps/api              REST CRM, partners, clients, parsers, documents, KP PDF
apps/web              Staff cabinet (Vite)
apps/tg-gateway       GramJS DM + Management Bot (peer + GPT) + channels
apps/voice-gateway    SIP + OpenAI Realtime
apps/workers-ts       SLA, digest, SMTP/IMAP (GPT), OCR, DLQ
services/orchestrator Deal state machine + /process + ops endpoints
services/agents       Concierge, quote_pipeline, FESCO, academy, seed_*
services/learning     Outcomes, calibration, canary playbooks
packages/shared       Types, queues (alo-email), openai, staffCopy
packages/prompts      GPT prompts (staff_peer, style_*, academy, …)
infra/                docker-compose + migrations 001–014 + init.sql
docs/                 Architecture, Commands, Env, Runbook, TZ
tests/evals/          Золотые сценарии
data/                 suppliers_*.json, partner_tariffs, mail-archive
```

---

## Рекомендации по улучшению проекта

### Сделано (не дублировать работу)

- Production boot guards: JWT / internal token / mock rates / cabinet auth / partner channels  
- Миграции `001`–`014`, `pnpm db:migrate` (+ auto на `start`)  
- База поставщиков Trans Russia + PSZhVS + кабинет «Поставщики» + auto-silent + weekly review  
- FESCO FIT; PEK/ДЛ lane adapters; file tariffs только fallback  
- GPT во всех каналах: staff peer, RFQ draft, IMAP parse, client inbound email  
- Health: Postgres + Redis; API rate limit + security headers  
- PDF КП/договор; CI e2e RFQ smoke + golden evals nightly  
- Associations parser + client mail archive  

### P0 — перед жёстким production / пилотом

1. **Реальные секреты** — `JWT_SECRET`, `INTERNAL_API_TOKEN`, `CABINET_*`, `OPENAI_API_KEY`, TG session/bot.  
2. **Живой SMTP/IMAP** — `MAIL_*` (или OAuth: `node scripts/mail-oauth-url.cjs`).  
3. **FESCO / контейнер** — проверить FIT URL; при API-ключах ПЭК/ДЛ — `PARTNER_HTTP_*`.  
4. Пилот с `REQUIRE_HUMAN_KP_APPROVE=true` — утверждать КП в боте/кабинете.

### P1 — качество и прибыль

5. Разбор вкладки «не отвечают» + A/B playbooks (winrate, margin, time-to-quote).  
6. Observability Langfuse в prod + контроль `GPT_*_BUDGET_USD`.  
7. Дообучение staff-room (`ops_hint`) → устойчивые playbook proposals.

### P2 — масштаб

8. Горизонтальные workers + managed Redis.  
9. Пул TG-аккаунтов (`TG_ACCOUNTS_JSON`) / RBAC.  
10. E-sign поверх PDF договоров.

### Почта Gmail / Яндекс — лучшие практики

| Тема | Рекомендация |
|------|----------------|
| Аккаунт | Отдельный `quotes@company...`, не личная почта основателя |
| Gmail | App Password для MVP; OAuth2 для продакшена |
| Яндекс | Пароль приложения + IMAP включён; для домена — Яндекс 360 для бизнеса |
| Тема письма | Всегда `Запрос ставки Ref: {deal_id}` — ключ синхронизации |
| Вложения | PDF/Excel ставок → MinIO + parse job |
| Двухпровайдерность | `MAIL_PROVIDER` + опционально второй аккаунт `MAIL_SECONDARY_*` для резерва |
| Юридика | Хранить переписку с логистами как часть audit trail сделки |

### Чего избегать

- Не обещать клиенту фикс-цену по просроченной ставке (TTL quotes).  
- Не учить модель на «успешных серых» сделках.  
- Не слать массовые письма на неверифицированные домены без whitelist/approve.  
- Не гонять userbot TG без лимитов — риск бана сессии.

---

## Лицензия и ответственность

**Проприетарное ПО. Все права защищены.**  
Copyright (c) 2026 Pankov Sergey Vladimirovich.

По умолчанию лицензия **не выдаётся**. Без предварительного явного письменного разрешения автора запрещены: использование, запуск, копирование, изменение, распространение, продажа и предоставление доступа третьим лицам. Полный текст: [LICENSE](LICENSE).

### Техническая защита (trial + ключ)

- При первой установке/запуске записывается метка в `data/.alo_install.json`.
- **12 месяцев** система работает без ключа (пробный период).
- После истечения пробного периода при старте запрашивается `LICENSE_KEY` (или читается из `.env` / `data/.alo_license`).
- Без действительного ключа сервисы не запускаются.

Автор выдаёт ключи так:

```bash
pnpm license:mint -- --subject "ООО Клиент" --days 365
# или бессрочный:
pnpm license:mint -- --subject "ООО Клиент" --perpetual
```

Клиент кладёт ключ в `.env`:

```env
LICENSE_KEY=ALO1.....
```

Таможенные и юридические выводы — **предварительные**; финальные решения по ТН ВЭД и договорам при порогах риска принимает человек. Система не сопровождает незаконные схемы.

### Поддержка автора

- USDT (ERC20): `0x587d0B8B786BC8254862dFDd632E00C81752B50a`
- BTC: `1Hehwq6T9E6JhWu1u7e7PHAqxmQwQXWA9m`
