#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
DOCKER_TOO="${DOCKER_TOO:-0}"

echo "==> Stopping local processes"
for dir in "$ROOT/logs/bootstrap" "$ROOT/data/logs"; do
  [[ -d "$dir" ]] || continue
  for f in "$dir"/*.pid; do
    [[ -f "$f" ]] || continue
    pid=$(cat "$f" || true)
    if [[ -n "${pid:-}" ]]; then
      kill "$pid" 2>/dev/null || true
      pkill -P "$pid" 2>/dev/null || true
    fi
    rm -f "$f"
  done
done

if [[ "$DOCKER_TOO" == "1" ]]; then
  docker compose --env-file .env down 2>/dev/null || true
  docker compose -f infra/docker-compose.yml down 2>/dev/null || true
fi
echo "Stopped."
