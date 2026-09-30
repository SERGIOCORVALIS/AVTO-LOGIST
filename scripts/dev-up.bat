@echo off
cd /d %~dp0\..
docker compose --env-file .env -f infra/docker-compose.yml up -d postgres redis minio
echo Infra started. Install: pnpm install ^&^& cd services ^&^& pip install -e .
