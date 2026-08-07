from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    model_config = {"env_file": ".env", "extra": "ignore"}

    database_url: str = "postgresql://alo:alo@localhost:5432/autologistics"
    redis_url: str = "redis://localhost:6379"
    api_url: str = "http://localhost:3000"
    openai_api_key: str = ""
    openai_model: str = "gpt-4o"
    openai_base_url: str = "https://api.openai.com/v1"
    deepseek_api_key: str = ""
    deepseek_model: str = "deepseek-chat"
    deepseek_base_url: str = "https://api.deepseek.com"
    target_margin_pct: float = 18
    floor_margin_pct: float = 10
    max_discount_pct: float = 8
    escalate_amount_rub: float = 500_000
    learning_enabled: bool = True
    canary_pct: int = 10
    prompts_dir: str = ""


settings = Settings()


def prompts_root() -> Path:
    if settings.prompts_dir:
        return Path(settings.prompts_dir)
    # monorepo default
    return Path(__file__).resolve().parents[2] / "packages" / "prompts"


def load_prompt(*parts: str) -> str:
    path = prompts_root().joinpath(*parts)
    return path.read_text(encoding="utf-8")


GREY_SCHEME_PATTERNS = [
    r"зани[жз]\w*\s+инвойс",
    r"серая\s+схем",
    r"без\s+таможн",
    r"обход\s+пошлин",
    r"чёрн\w*\s+схем",
    r"черн\w*\s+схем",
    r"не\s+декларир",
    r"double\s+invoic",
    r"under.?value",
]


def detect_grey_scheme(text: str) -> bool:
    low = text.lower()
    return any(re.search(p, low) for p in GREY_SCHEME_PATTERNS)


def extract_json(text: str) -> dict[str, Any]:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{[\s\S]*\}", text)
        if m:
            return json.loads(m.group(0))
        raise
