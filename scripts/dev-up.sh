#!/usr/bin/env sh
set -e
cd "$(dirname "$0")/.."
docker compose -f infra/docker-compose.yml up -d postgres redis minio
echo "Infra up. Next: pnpm install && cd services && pip install -e . && uvicorn orchestrator.app:app --port 8000"
