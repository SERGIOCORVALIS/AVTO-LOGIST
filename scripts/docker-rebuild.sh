#!/usr/bin/env bash
# Rebuild & recreate Docker stack
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

NO_CACHE="${NO_CACHE:-0}"
WITH_OBS="${WITH_OBS:-0}"
INFRA_ONLY="${INFRA_ONLY:-0}"

if [[ ! -f .env ]]; then cp .env.example .env; fi

if [[ "$INFRA_ONLY" == "1" ]]; then
  ARGS=(-f infra/docker-compose.yml)
  [[ "$WITH_OBS" == "1" ]] && ARGS+=(--profile observability)
  docker compose "${ARGS[@]}" down
  docker compose "${ARGS[@]}" pull
  docker compose "${ARGS[@]}" up -d --force-recreate
  echo "Infra recreated."
  exit 0
fi

BUILD=(--env-file .env build)
[[ "$NO_CACHE" == "1" ]] && BUILD+=(--no-cache)

if [[ "$WITH_OBS" == "1" ]]; then
  docker compose --env-file .env --profile observability "${BUILD[@]}"
  docker compose --env-file .env --profile observability down
  docker compose --env-file .env --profile observability up -d --force-recreate --build
else
  docker compose "${BUILD[@]}"
  docker compose --env-file .env down
  docker compose --env-file .env up -d --force-recreate --build
fi

docker compose --env-file .env ps
echo "Health: curl -s http://localhost:3000/health && curl -s http://localhost:8000/health"
