# Справочник команд — AutoLogistics OS

Полное описание CLI-скриптов, pnpm, Management Bot, HTTP API и переменных окружения.

См. также: [ENV_SETUP.md](ENV_SETUP.md) (заполнение `.env`) · [RUNBOOK.md](RUNBOOK.md) · [ARCHITECTURE.md](ARCHITECTURE.md) · [logs/README.md](../logs/README.md)

---

## 1. Скрипты установки и запуска

### Windows — один клик (`install.bat`)

| Команда | Описание |
|---------|----------|
| `install.bat` | Поставит Node LTS / Python 3.12 / Git / Docker Desktop (через winget, если нет), затем `setup` + `start`. Если в `.env` есть `TG_STRING_SESSION` / `SIP_PUBLIC_HOST` — поднимет gateway / voice автоматически |
| `install.bat /gateway` | То же + Telegram gateway |
| `install.bat /voice` | То же + Voice gateway |
| `install.bat /obs` | Setup с профилем Langfuse (`-WithObservability`) |
| `install.bat /setup-only` | Только установка зависимостей, без запуска сервисов |
| `install-docker.bat` | Установка/настройка и запуск **всего стека в Docker** (compose up --build + migrate) |
| `install-docker.bat /rebuild` | То же с полной пересборкой образов |
| `install-docker.bat /nocache` | Пересборка без кэша Docker |
| `install-docker.bat /obs` | + профиль Langfuse |
| `install-docker.bat /setup-only` | Только host deps (pnpm/shared), без `compose up` |
| `docker-rebuild.bat` | Пересборка всех Docker-образов + `force-recreate` |
| `docker-rebuild.bat /nocache` | Пересборка без кэша |
| `docker-rebuild.bat /obs` | + observability |
| `docker-rebuild.bat /infra` | Только postgres/redis/minio |
| `stop.bat` | Остановка локальных процессов |
| `stop.bat /docker` | + `docker compose down` |

Нужен Windows 10 1809+ с [winget / App Installer](https://aka.ms/getwinget). Секреты в `.env` не заполняются. После первой установки Docker Desktop часто требуется перезагрузка — затем снова `install.bat`.

### Windows (PowerShell)

| Команда | Описание |
|---------|----------|
| `.\scripts\bootstrap-windows.ps1` | То же, что `install.bat` (системные пакеты + setup + start) |
| `.\scripts\setup.ps1` | Установка: premium `.env` из `.env.example` (если нет), pnpm, shared build, Python venv, Docker infra |
| `node scripts/audit-env.mjs` | Проверка `.env` / `.env.example`: дубли, пустые критичные, формат → `logs/env-audit.json` |
| `node scripts/write-premium-env.mjs` | Пересобрать одинаковую структуру обоих файлов (секреты из `.env` сохраняются) |
| `pnpm install` | После clone/rename репозитория — пересобрать `node_modules` (иначе junctions могут указывать на старый путь) |
| `pnpm --filter @alo/shared build; pnpm -r run typecheck` | Сборка shared + проверка TypeScript |
| `.\scripts\setup.ps1 -WithObservability` | То же + Langfuse profile |
| `.\scripts\setup.ps1 -SkipDocker` | Без Docker (только deps) |
| `.\scripts\start.ps1` | Старт API + orchestrator + workers; логи → `logs/` |
| `.\scripts\start.ps1 -WithGateway` | + Telegram gateway |
| `.\scripts\start.ps1 -WithVoiceGateway` | + Voice gateway (SIP Zadarma/Билайн + OpenAI Realtime) |
| `.\scripts\start.ps1 -DockerStack` | Весь стек в Docker (`compose up --build`) |
| `.\scripts\stop.ps1` | Остановка фоновых процессов по PID |
| `.\scripts\stop.ps1 -DockerToo` | + `docker compose down` |
| `.\scripts\stop.ps1 -DockerOnly` | Только Docker |
| `.\scripts\docker-rebuild.ps1` | Пересборка образов + `force-recreate` |
| `.\scripts\docker-rebuild.ps1 -NoCache` | Сборка без кэша |
| `.\scripts\docker-rebuild.ps1 -InfraOnly` | Только postgres/redis/minio |
| `.\scripts\docker-rebuild.ps1 -WithObservability` | Со стеком Langfuse |
| `.\scripts\load-secrets.ps1` | Загрузка секретов Doppler или `.env` в сессию |
| `.\scripts\dev-up.bat` | Быстрый старт infra |

### Linux / macOS (bash)

| Команда | Описание |
|---------|----------|
| `./scripts/setup.sh` | Установка deps + infra |
| `WITH_OBS=1 ./scripts/setup.sh` | + observability |
| `SKIP_DOCKER=1 ./scripts/setup.sh` | Без Docker |
| `./scripts/start.sh` | Локальный старт сервисов |
| `WITH_GATEWAY=1 ./scripts/start.sh` | + gateway |
| `WITH_VOICE=1 ./scripts/start.sh` | + voice-gateway |
| `DOCKER_STACK=1 ./scripts/start.sh` | Docker stack |
| `./scripts/stop.sh` | Стоп процессов |
| `DOCKER_TOO=1 ./scripts/stop.sh` | + Docker down |
| `./scripts/docker-rebuild.sh` | Rebuild стека |
| `NO_CACHE=1 ./scripts/docker-rebuild.sh` | Без кэша |
| `INFRA_ONLY=1 ./scripts/docker-rebuild.sh` | Только infra |
| `WITH_OBS=1 ./scripts/docker-rebuild.sh` | + Langfuse |

### pnpm / Make

| Команда | Описание |
|---------|----------|
| `pnpm setup` | → `scripts/setup.ps1` |
| `pnpm start` | → `scripts/start.ps1` |
| `pnpm start:gateway` | start + gateway |
| `pnpm start:voice` | start + voice-gateway |
| `pnpm dev:voice` | Voice gateway watch |
| `pnpm stop` | stop |
| `pnpm docker:up` | `compose up -d --build` |
| `pnpm docker:rebuild` | rebuild script |
| `pnpm docker:rebuild:nocache` | rebuild -NoCache |
| `pnpm docker:infra` | только infra compose |
| `pnpm docker:down` | stop -DockerOnly |
| `pnpm build` | build всех TS-пакетов |
| `pnpm typecheck` | typecheck |
| `pnpm dev:api` | API watch |
| `pnpm dev:gateway` | Gateway watch |
| `pnpm dev:workers` | Workers watch |
| `pnpm test` | unit-тесты shared + api + workers |
| `pnpm test:py` | pytest agents |
| `pnpm db:migrate` | SQL-миграции `infra/migrations/001–014` |
| `pnpm mail:archive-dump` | Выгрузка ARCHIVE_MAILBOXES_JSON → `data/mail-archive` |
| `pnpm mail:archive-ingest` | Парсинг архива → clients / calc_requests |
| `pnpm mail:archive-style` | Стиль из исходящих → prompts + playbook_versions |
| `pnpm seed:suppliers` | сид Trans Russia 2026 → partners/suppliers |
| `pnpm --filter @alo/tg-gateway login` | Получить `TG_STRING_SESSION` |
| `make setup` / `make start` / `make rebuild` / `make health` / `make test` | Обёртки Make |

---

## 2. Management Bot (Telegram)

Доступ: только `TG_MANAGER_IDS` (если список пуст — доступен всем, кто пишет боту).

Код: `managementBot.ts` + `staffPeer.ts` + `staffPeerGpt.ts` (`apps/tg-gateway/src`).  
Каналы: DM менеджера, группа `TG_ESCALATION_CHAT_ID`, копии алертов в `TG_EXEC_CHANNEL_ID`.

### 2.1. Peer-режим (обычный язык)

При `TG_STAFF_PEER_MODE=on` (по умолчанию) бот отвечает **как коллега**, без обязательных слэш-команд.  
При `TG_STAFF_GPT=on` (по умолчанию) свободный текст и вопросы разбирает **GPT** (`staffPeerGpt.ts` + `packages/prompts/gpt/staff_peer.md`); быстрые фразы («статус», «утверди КП») остаются на regex.

| Фраза / действие | Эффект |
|------------------|--------|
| «статус», «сводка» | Краткая сводка (открытые, awaiting, takeover, эскалации) |
| «эскалации», «что висит» | Pending-эскалации + кнопки |
| «ждут менеджера» | Список `awaiting_manager` |
| «карточка &lt;uuid&gt;», «что по сделке …» | Карточка + кнопки |
| Ответ на алерт: «утверди КП» / «одобри» | `approve-kp` (часто `contract` или release_to_client) |
| «отправь RFQ» / «можно слать» | `approve_rfq` / flush RFQ |
| «работай по этой» / set active | `set_active` на сделку |
| «Текст RFQ: …» / «только на a@b.ru» / схема ПСЖВС | `ops_hint` → обучение + патч сделки |
| Бытовой обмен без обращения к боту | `observe` — молчит, пишет в learning |
| Ответ на алерт: «перехвати» / «беру сам» | takeover + пауза ИИ |
| «пауза» / «верни бота» | pause / resume |
| «скидка −3%» | Cut −3% по сделке из ответа |
| Свободный вопрос по сделке/логистике | GPT `colleague_reply` |
| «что умеешь», «привет» | Краткая справка peer-режима |

В **группе** `TG_STAFF_CHAT_ID` бот слушает **весь** текст менеджеров (обучение + ops); в других группах — ответ на алерт, @mention, слово из `TG_STAFF_BOT_NAMES`, явная команда, uuid.  
`off` — только слэш-команды.

**Forum-темы** (при `TG_STAFF_FORUM=on`): `Общее` · `Эскалации` · `RFQ` · `Обучение`. Алерты → Эскалации, RFQ-подсказки → RFQ, обучение → Обучение. Ответы уходят в ту же тему (`message_thread_id`).  
`/staff_sync` — перечитать историю всех тем в `staff_room_training` (без авто-отправки RFQ).

**BotFather:** `/setprivacy` → **Disable**, иначе без reply/@mention сообщения в группе не доходят (MTProto user-bridge компенсирует, если сессия в группе).

### 2.2. Слэш-команды

| Команда | Аргументы | Описание |
|---------|-----------|----------|
| `/start` | — | Приветствие + peer-справка |
| `/help` | — | Peer-примеры + полный список команд |
| `/status` | — | JSON-сводка: сделки по статусам, avg margin, pending эскалации |
| `/policy` | — | Текущие ключи политики (маржа, floor, НДС, прибыль, RFQ…) |
| `/margin` | `<число>` | Установить `target_margin_pct` (пример: `/margin 18`) |
| `/floor` | `<число>` | Установить `floor_margin_pct` (пример: `/floor 10`) |
| `/deal` | `<uuid>` | Карточка сделки: статус, груз, маршрут, цена, маржа, риски |
| `/pause` | `<uuid>` | Пауза AI-ответов по сделке |
| `/resume` | `<uuid>` | Снять паузу и takeover |
| `/takeover` | `<uuid>` | Человек ведёт чат; AI молчит; при активном звонке — transfer менеджеру |
| `/call` | `<uuid>` | Активный звонок по сделке + последние реплики транскрипта |
| `/escalations` | — | Список pending + кнопки Согласовать / Отклонить |
| `/playbooks` | — | Предложения самообучения + Canary / Reject |
| `/accounts` | — | Список user-аккаунтов Telegram (multi-account) |
| `/learn_on` | — | Включить learning loop |
| `/learn_off` | — | Выключить learning loop |
| `/staff_sync` | — | Перечитать историю всех forum-тем staff-группы в learning |

### 2.3. Inline-кнопки

**Эскалация** (`/escalations` или peer «эскалации»):
- `Согласовать` — вернуть сделку в предыдущий статус / negotiation
- `Отклонить` — `cancelled`

**Playbook** (`/playbooks`):
- `Canary` — 10% трафика на новую политику
- `Reject` — отклонить предложение

**/deal** (и peer «карточка»):
- `Утвердить КП` — статус `contract`, снять escalate
- `Скидка −3%` — снизить оферту на 3%, пересчитать маржу
- `Перехватить` — пауза AI + takeover
- `Отклонить` — отмена сделки

### 2.4. Env peer-режима

| Переменная | Значения | Смысл |
|------------|----------|--------|
| `TG_STAFF_PEER_MODE` | `on` \| `all` \| `off` | Вкл. свободный текст / весь чат / только `/команды` |
| `TG_STAFF_BOT_NAMES` | `бот,логист,alo,ало` | Триггеры обращения в группе |
| `TG_STAFF_GPT` | `on` \| `off` | GPT-разбор неоднозначных фраз и Q&A в peer-режиме |
| `TG_STAFF_FORUM` | `on` \| `off` | Фиксированные темы Общее/Эскалации/RFQ/Обучение |
| `TG_STAFF_HISTORY_INGEST` | `on` \| `off` | Boot-ingest истории тем в learning |
| `TG_STAFF_HISTORY_LIMIT` | число | Лимит сообщений на тему при ingest |
| `TG_STAFF_TOPIC_*` | int | Опционально: id тем GENERAL / ESCALATIONS / RFQ / COACHING |

---

## 3. HTTP API

База: `API_URL` (default `http://localhost:3000`).

Дополнительно (кабинет): `POST /auth/login`, `GET /partners` (+ silent/pause/left), `GET /clients`, `GET /parsers`, `GET /documents`, `POST /deals/:id/approve-kp`, `GET /deals/:id/kp.pdf`, `GET /deals/:id/contract.pdf`, `GET /calendar/export.ics`.

Оркестратор (`ORCHESTRATOR_URL:8000`): `POST /process`, `POST /deals/{id}/apply-ops-hint`, `set-active`, `flush-rfq`, `GET .../quote-compare`.


| Метод | Путь | Описание |
|-------|------|----------|
| `GET` | `/health` | Liveness |
| `GET` | `/stats/summary` | Сводка для `/status` |
| `GET` | `/deals` | Список сделок (`?status=&limit=&q=` / `search=` — имя клиента, груз, маршрут, uuid) |
| `POST` | `/deals` | Создать сделку |
| `GET` | `/deals/:id` | Карточка |
| `PATCH` | `/deals/:id` | Обновить поля |
| `GET` | `/deals/by-chat/:chatId` | Активная сделка чата |
| `POST` | `/deals/:id/messages` | Сохранить сообщение |
| `GET` | `/deals/:id/messages` | История |
| `POST` | `/deals/:id/escalate` | Создать эскалацию |
| `POST` | `/deals/:id/attachments` | Вложение (base64) → `data/uploads` + metadata |
| `GET` | `/escalations?status=pending` | Список эскалаций |
| `POST` | `/escalations/:id/decide` | `{ decision: approved\|rejected }` |
| `GET` | `/policy` | Политика |
| `PUT` | `/policy` | Обновить ключи |
| `GET` | `/playbooks` | Версии playbook |
| `POST` | `/playbooks/:id/decide` | `{ decision: canary\|active\|rejected\|retired }` |
| `POST` | `/orchestrator/process` | Прокси в Python `/process` (channel: telegram\|voice\|email) |
| `GET` | `/calls/deal/:dealId` | Активный и недавние звонки по сделке |
| `GET` | `/calls/:sessionId` | Сессия звонка |
| `POST` | `/calls/:sessionId/end` | Завершить сессию |

### Voice gateway (`:3010`)

| Метод | Путь | Описание |
|-------|------|----------|
| `GET` | `/health` | Liveness + статус SIP стека |
| `POST` | `/internal/takeover/:dealId` | SIP REFER активного звонка менеджеру |
| `GET` | `/health` | Voice gateway liveness |
| `POST` | `/internal/takeover/:dealId` | Transfer / pause AI на звонке |

### Orchestrator (`:8000`)

| Метод | Путь | Описание |
|-------|------|----------|
| `GET` | `/health` | Liveness |
| `POST` | `/process` | Обработка inbound-сообщения (deal loop); `channel=voice` + `external_id` для телефона |
| `GET` | `/deals/:id/status` | Статус сделки для voice tools |
| `POST` | `/deals/:id/close` | Закрытие + learning (`actual_weight_kg` и т.д.) |

---

## 4. Docker

| Команда | Описание |
|---------|----------|
| `docker compose -f infra/docker-compose.yml up -d` | postgres, redis, minio |
| `docker compose -f infra/docker-compose.yml --profile observability up -d` | + Langfuse |
| `docker compose --env-file .env up -d --build` | Полный стек приложений |
| `docker compose --env-file .env up -d --force-recreate --build` | Пересборка как в `docker-rebuild` |
| `docker compose ps` | Статус контейнеров |
| `docker compose logs -f api orchestrator workers` | Логи контейнеров |

---

## 5. Логи (папка `logs/`)

| Путь | Содержимое |
|------|------------|
| `logs/api/` | HTTP API |
| `logs/gateway/` | Telegram I/O |
| `logs/workers/` | SLA, email, digest |
| `logs/orchestrator/` | Python deal loop |
| `logs/bootstrap/` | setup/start/stop |
| `logs/audit/` | Эскалации, grey-block, approve, смена политики |

Файлы: `YYYY-MM-DD.log` + `current.log`.

```powershell
Get-Content .\logs\audit\current.log -Wait -Tail 40
Get-Content .\logs\orchestrator\current.log -Wait -Tail 50
```

Env: `LOG_DIR` (корень), `LOG_LEVEL` (`debug|info|warn|error`).

---

## 6. Секреты и `.env`

| Способ | Команда / настройка |
|--------|---------------------|
| Шаблон | `.env.example` (premium, секции 1–16) |
| Рабочий файл | `copy .env.example .env` |
| Аудит | `node scripts/audit-env.mjs` → `logs/env-audit.json` |
| Пересборка структуры | `node scripts/write-premium-env.mjs` (бэкап в `logs/`) |
| Doppler | `doppler setup` + `doppler.yaml` из `doppler.yaml.example` |
| Загрузка в сессию | `.\scripts\load-secrets.ps1` |
| Node runtime | `loadRootEnv()` из `@alo/shared` (весь корневой `.env`) |
| `start.ps1` | инжектит **все** ключи `.env` в дочерние процессы |
| Python | `load_dotenv` + `tz_policy.policy_from_env()` |

Правило: комментарии только отдельной строкой `# ...`, не `KEY=value # comment`.  
Документация по настройке: [ENV_SETUP.md §0](ENV_SETUP.md#0-premium-env--как-устроена-настройка).

---

## 7. Multi Telegram accounts

Один аккаунт (классика):
```env
TG_API_ID=...
TG_API_HASH=...
TG_STRING_SESSION=...
```

Несколько менеджеров:
```env
TG_ACCOUNTS_JSON=[{"id":"mgr1","api_id":123,"api_hash":"...","session":"...","manager_user_id":111,"label":"Anna"},{"id":"mgr2","api_id":123,"api_hash":"...","session":"...","label":"Boris"}]
```

Роутер: sticky chat→account, round-robin для новых чатов. Список: `/accounts`.

---

## 8. Почта (кратко)

| Env | Описание |
|-----|----------|
| `MAIL_PROVIDER` | `gmail` \| `yandex` \| `custom` |
| `MAIL_AUTH_MODE` | `app_password` \| `oauth2` |
| `MAIL_SYNC_ENABLED` | IMAP poll on/off |
| `MAIL_LLM_PARSE` | LLM-извлечение цены из писем |
| `MAIL_LLM_DRAFT` | GPT-черновик исходящего RFQ (`style_supplier`) |
| `MAIL_LLM_INBOUND` | Клиентские письма без Ref → orchestrator + SMTP |
| `MAIL_MAX_SEND_PER_MINUTE` | Антиспам исходящих |

Подробности — README § «Почта» и RUNBOOK.

---

## 9. Тесты и evals

| Команда | Описание |
|---------|----------|
| `cd services && .venv\Scripts\python -m pytest tests/test_agents.py -q` | Юнит-тесты агентов |
| `python tests/evals/run_evals.py http://localhost:8000` | Золотые сценарии против live orchestrator |
