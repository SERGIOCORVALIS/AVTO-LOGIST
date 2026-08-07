.PHONY: setup start stop rebuild infra health test

setup:
	pwsh -File scripts/setup.ps1

start:
	pwsh -File scripts/start.ps1

start-gateway:
	pwsh -File scripts/start.ps1 -WithGateway

stop:
	pwsh -File scripts/stop.ps1

rebuild:
	pwsh -File scripts/docker-rebuild.ps1

infra:
	docker compose -f infra/docker-compose.yml up -d

health:
	curl -sf http://localhost:3000/health && curl -sf http://localhost:8000/health && echo OK

test:
	cd services && .venv/Scripts/python -m pytest tests/test_agents.py -q || \
	cd services && .venv/bin/python -m pytest tests/test_agents.py -q
