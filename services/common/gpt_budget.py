"""Daily / monthly GPT spend caps. 0 = unlimited (default)."""

from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any

_memory_spend: dict[str, float] = {}


class BudgetExceeded(RuntimeError):
    """Raised before an LLM call when the configured USD cap is exhausted."""


def _use_redis() -> bool:
    raw = (os.getenv("GPT_BUDGET_REDIS") or "true").strip().lower()
    return raw in ("1", "true", "yes", "on")


def _env_float(name: str, default: float = 0.0) -> float:
    raw = (os.getenv(name) or "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def daily_budget_usd() -> float:
    return max(0.0, _env_float("GPT_DAILY_BUDGET_USD"))


def monthly_budget_usd() -> float:
    return max(0.0, _env_float("GPT_MONTHLY_BUDGET_USD"))


def input_usd_per_1m() -> float:
    return max(0.0, _env_float("GPT_INPUT_USD_PER_1M", 3.0))


def output_usd_per_1m() -> float:
    return max(0.0, _env_float("GPT_OUTPUT_USD_PER_1M", 12.0))


def estimate_usd(prompt_tokens: int, completion_tokens: int) -> float:
    return (
        prompt_tokens * input_usd_per_1m() + completion_tokens * output_usd_per_1m()
    ) / 1_000_000.0


def _day_key(now: datetime | None = None) -> str:
    stamp = now or datetime.now(timezone.utc)
    return stamp.strftime("gpt:spend:d:%Y-%m-%d")


def _month_key(now: datetime | None = None) -> str:
    stamp = now or datetime.now(timezone.utc)
    return stamp.strftime("gpt:spend:m:%Y-%m")


def reset_memory() -> None:
    _memory_spend.clear()


def _read(key: str) -> float:
    return float(_memory_spend.get(key, 0.0))


def _add(key: str, usd: float) -> float:
    if usd <= 0:
        return 0.0
    nxt = _read(key) + usd
    _memory_spend[key] = nxt
    if not _use_redis():
        return nxt
    try:
        import redis as redis_lib

        from common import settings

        r = redis_lib.from_url(settings.redis_url, socket_connect_timeout=1)
        try:
            val = r.incrbyfloat(key, usd)
            ttl = 40 * 24 * 3600 if key.startswith("gpt:spend:m:") else 3 * 24 * 3600
            r.expire(key, ttl)
            _memory_spend[key] = float(val)
            return float(val)
        finally:
            r.close()
    except Exception:
        return nxt


def spent_today() -> float:
    key = _day_key()
    if not _use_redis():
        return _read(key)
    try:
        import redis as redis_lib

        from common import settings

        r = redis_lib.from_url(settings.redis_url, socket_connect_timeout=1)
        try:
            raw = r.get(key)
            if raw is not None:
                return float(raw)
        finally:
            r.close()
    except Exception:
        pass
    return _read(key)


def spent_month() -> float:
    key = _month_key()
    if not _use_redis():
        return _read(key)
    try:
        import redis as redis_lib

        from common import settings

        r = redis_lib.from_url(settings.redis_url, socket_connect_timeout=1)
        try:
            raw = r.get(key)
            if raw is not None:
                return float(raw)
        finally:
            r.close()
    except Exception:
        pass
    return _read(key)


def assert_within_budget() -> None:
    daily = daily_budget_usd()
    monthly = monthly_budget_usd()
    if daily <= 0 and monthly <= 0:
        return
    if daily > 0 and spent_today() >= daily:
        raise BudgetExceeded(
            f"GPT daily budget exhausted ({spent_today():.4f} >= {daily} USD)"
        )
    if monthly > 0 and spent_month() >= monthly:
        raise BudgetExceeded(
            f"GPT monthly budget exhausted ({spent_month():.4f} >= {monthly} USD)"
        )


def record_usage(
    resp: Any,
    *,
    prompt_chars: int = 0,
    completion_chars: int = 0,
) -> float:
    prompt_tokens, completion_tokens = _usage_tokens(resp)
    if prompt_tokens <= 0 and prompt_chars:
        prompt_tokens = max(1, prompt_chars // 4)
    if completion_tokens <= 0 and completion_chars:
        completion_tokens = max(1, completion_chars // 4)
    usd = estimate_usd(prompt_tokens, completion_tokens)
    if usd <= 0:
        return 0.0
    _add(_day_key(), usd)
    _add(_month_key(), usd)
    return usd


def _usage_tokens(resp: Any) -> tuple[int, int]:
    usage = getattr(resp, "usage", None)
    if usage is None:
        return 0, 0
    prompt = getattr(usage, "prompt_tokens", None)
    completion = getattr(usage, "completion_tokens", None)
    if prompt is None and isinstance(usage, dict):
        prompt = usage.get("prompt_tokens")
        completion = usage.get("completion_tokens")
    return int(prompt or 0), int(completion or 0)
