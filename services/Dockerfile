FROM python:3.12-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential libpq-dev \
    && rm -rf /var/lib/apt/lists/*

COPY services/pyproject.toml /app/services/pyproject.toml
COPY services/common /app/services/common
COPY services/agents /app/services/agents
COPY services/learning /app/services/learning
COPY services/orchestrator /app/services/orchestrator
COPY packages/prompts /app/packages/prompts

WORKDIR /app/services
RUN pip install --no-cache-dir -e .

ENV PROMPTS_DIR=/app/packages/prompts
EXPOSE 8000
CMD ["uvicorn", "orchestrator.app:app", "--host", "0.0.0.0", "--port", "8000"]
