"""CI/shell env must win over committed or local .env values."""

from __future__ import annotations

import os
from pathlib import Path


def test_dotenv_does_not_override_existing_env(monkeypatch, tmp_path: Path):
    """Mirrors services/common/__init__.py and secrets.py (override=False)."""
    from dotenv import load_dotenv

    env_file = tmp_path / ".env"
    env_file.write_text(
        "ALLOW_MOCK_RATES=false\nDATABASE_URL=postgresql://from-file:5434/db\n",
        encoding="utf-8",
    )

    monkeypatch.setenv("ALLOW_MOCK_RATES", "true")
    monkeypatch.setenv("DATABASE_URL", "postgresql://from-ci:5432/db")

    load_dotenv(env_file, override=False)

    assert os.environ["ALLOW_MOCK_RATES"] == "true"
    assert os.environ["DATABASE_URL"] == "postgresql://from-ci:5432/db"

    monkeypatch.delenv("NEW_FROM_FILE", raising=False)
    env_file.write_text("NEW_FROM_FILE=hello\n", encoding="utf-8")
    load_dotenv(env_file, override=False)
    assert os.environ["NEW_FROM_FILE"] == "hello"
