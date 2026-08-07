#!/usr/bin/env bash
# Full install: pnpm, Python venv, Docker infra
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

WITH_OBS="${WITH_OBS:-0}"
SKIP_DOCKER="${SKIP_DOCKER:-0}"

echo "==> AutoLogistics OS setup ($ROOT)"

need() { command -v "$1" >/dev/null || { echo "Missing: $1"; exit 1; }; }
need node
need python3
need docker

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from .env.example"
fi

echo "==> pnpm"
corepack enable || true
corepack prepare pnpm@9.15.0 --activate
pnpm install
pnpm --filter @alo/shared build

echo "==> Python venv"
python3 -m venv services/.venv
# shellcheck disable=SC1091
source services/.venv/bin/activate
pip install --upgrade pip
pip install -e "./services[dev]"

if [[ "$SKIP_DOCKER" != "1" ]]; then
  echo "==> Docker infra"
  if [[ "$WITH_OBS" == "1" ]]; then
    docker compose -f infra/docker-compose.yml --profile observability pull
    docker compose -f infra/docker-compose.yml --profile observability up -d
  else
    docker compose -f infra/docker-compose.yml pull
    docker compose -f infra/docker-compose.yml up -d
  fi
  echo "Waiting for Postgres..."
  for i in $(seq 1 30); do
    if docker compose -f infra/docker-compose.yml exec -T postgres pg_isready -U alo -d autologistics; then
      break
    fi
    sleep 2
  done
fi

echo "Setup complete. Next: ./scripts/start.sh"
echo "Docker rebuild: ./scripts/docker-rebuild.sh"
