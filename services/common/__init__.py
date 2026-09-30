from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from pydantic_settings import BaseSettings, SettingsConfigDict

_REPO_ROOT = Path(__file__).resolve().parents[2]
try:
    from dotenv import load_dotenv

    # Always load monorepo .env so ALL keys reach os.environ (not only Settings fields).
    load_dotenv(_REPO_ROOT / ".env", override=True)
except Exception:
    pass


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(_REPO_ROOT / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    database_url: str = "postgresql://alo:alo@127.0.0.1:5432/autologistics"
    redis_url: str = "redis://127.0.0.1:6379"
    api_url: str = "http://127.0.0.1:3000"
    openai_api_key: str = ""
    openai_model: str = "gpt-5.6-sol"
    openai_fast_model: str = "gpt-5.6-luna"
    openai_coding_model: str = "gpt-5.6-sol"
    openai_document_model: str = "gpt-5.6-sol"
    openai_transcribe_model: str = "gpt-transcribe"
    openai_realtime_model: str = "gpt-realtime-2.1"
    openai_embedding_model: str = "text-embedding-3-large"
    openai_base_url: str = "https://api.openai.com/v1"
    openai_reasoning_effort: str = "high"
    openai_timeout_sec: float = 120
    openai_max_completion_tokens: int = 32768
    gpt_daily_budget_usd: float = 0
    gpt_monthly_budget_usd: float = 0
    gpt_input_usd_per_1m: float = 3
    gpt_output_usd_per_1m: float = 12
    gpt_budget_redis: bool = True
    target_margin_pct: float = 18
    floor_margin_pct: float = 10
    max_discount_pct: float = 8
    escalate_amount_rub: float = 500_000
    require_human_kp_approve: bool = True
    min_gross_profit_rub: float = 3000
    ru_vat_pct: float = 22
    learning_enabled: bool = True
    canary_pct: int = 10
    academy_enabled: bool = True
    prompts_dir: str = ""


settings = Settings()


def prefer_ipv4_loopback(url: str) -> str:
    """Rewrite localhost → 127.0.0.1 so Windows does not try ::1 first."""
    if not url:
        return url
    return re.sub(r"(://|@)localhost(?=[:/?#]|$)", r"\g<1>127.0.0.1", url)


settings.database_url = prefer_ipv4_loopback(settings.database_url)
settings.redis_url = prefer_ipv4_loopback(settings.redis_url)
settings.api_url = prefer_ipv4_loopback(settings.api_url)


def prompts_root() -> Path:
    if settings.prompts_dir:
        return Path(settings.prompts_dir)
    # monorepo default
    return Path(__file__).resolve().parents[2] / "packages" / "prompts"


def load_prompt(*parts: str) -> str:
    path = prompts_root().joinpath(*parts)
    return path.read_text(encoding="utf-8")


def load_style_prompt(
    filename: str,
    *,
    max_chars: int | None = None,
    prefer_examples: bool = False,
) -> str:
    """Load style_*.md; optionally prioritize the «Примеры» section for RFQ few-shots."""
    text = load_prompt("gpt", filename)
    if prefer_examples:
        marker = "## Примеры"
        idx = text.find(marker)
        if idx >= 0:
            header = text[:idx].strip()
            examples = text[idx:].strip()
            # Keep short rules + examples (examples first for RFQ slice budget)
            text = f"{examples}\n\n---\n{header}"
    if max_chars is not None and max_chars > 0:
        text = text[:max_chars]
    return text


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
