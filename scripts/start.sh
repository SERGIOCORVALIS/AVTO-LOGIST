#!/usr/bin/env bash
# Start local stack (infra + api + orchestrator + workers)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export LOG_DIR="${LOG_DIR:-$ROOT/logs}"
mkdir -p "$LOG_DIR"/{api,gateway,workers,orchestrator,voice,bootstrap,audit}

WITH_GATEWAY="${WITH_GATEWAY:-0}"
WITH_VOICE="${WITH_VOICE:-0}"
DOCKER_STACK="${DOCKER_STACK:-0}"

if [[ ! -f .env ]]; then cp .env.example .env; fi

if [[ "$DOCKER_STACK" == "1" ]]; then
  docker compose --env-file .env up -d --build
  echo "Docker stack up. API :3000 Orchestrator :8000"
  exit 0
fi

docker compose -f infra/docker-compose.yml up -d

if [[ ! -x services/.venv/bin/uvicorn ]]; then
  SKIP_DOCKER=1 ./scripts/setup.sh
fi

pnpm --filter @alo/shared build >/dev/null

start_bg() {
  local name="$1"; shift
  echo "Starting $name..."
  nohup env LOG_DIR="$LOG_DIR" "$@" >"$LOG_DIR/bootstrap/${name}.out.log" 2>"$LOG_DIR/bootstrap/${name}.err.log" &
  echo $! >"$LOG_DIR/bootstrap/${name}.pid"
  echo "  pid=$(cat "$LOG_DIR/bootstrap/${name}.pid")"
}

start_bg orchestrator services/.venv/bin/uvicorn orchestrator.app:app --host 0.0.0.0 --port 8000 --reload
sleep 2
start_bg api pnpm --filter @alo/api dev
start_bg workers pnpm --filter @alo/workers-ts dev
if [[ "$WITH_GATEWAY" == "1" ]]; then
  start_bg gateway pnpm --filter @alo/tg-gateway dev
fi
if [[ "$WITH_VOICE" == "1" ]]; then
  start_bg voice pnpm --filter @alo/voice-gateway dev
fi

echo "Started. Structured logs: $LOG_DIR"
echo "  Commands: docs/COMMANDS.md"
echo "  Stop: ./scripts/stop.sh"
echo "  API http://localhost:3000/health"
echo "  Orchestrator http://localhost:8000/health"
if [[ "$WITH_VOICE" == "1" ]]; then
  echo "  Voice http://localhost:3010/health"
fi
