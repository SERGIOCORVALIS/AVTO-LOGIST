from types import SimpleNamespace

from common.gpt_budget import (
    BudgetExceeded,
    assert_within_budget,
    estimate_usd,
    record_usage,
    reset_memory,
    spent_today,
)


def test_estimate_usd_from_tokens(monkeypatch):
    monkeypatch.setenv("GPT_INPUT_USD_PER_1M", "1")
    monkeypatch.setenv("GPT_OUTPUT_USD_PER_1M", "2")
    # 1M prompt + 1M completion = 3 USD
    assert abs(estimate_usd(1_000_000, 1_000_000) - 3.0) < 1e-9


def test_daily_budget_blocks_then_records(monkeypatch):
    reset_memory()
    monkeypatch.setenv("GPT_BUDGET_REDIS", "false")
    monkeypatch.setenv("GPT_DAILY_BUDGET_USD", "0.0001")
    monkeypatch.setenv("GPT_MONTHLY_BUDGET_USD", "0")
    monkeypatch.setenv("GPT_INPUT_USD_PER_1M", "10")
    monkeypatch.setenv("GPT_OUTPUT_USD_PER_1M", "10")

    assert_within_budget()
    resp = SimpleNamespace(
        usage=SimpleNamespace(prompt_tokens=10_000, completion_tokens=10_000)
    )
    usd = record_usage(resp)
    assert usd > 0.0001
    assert spent_today() >= usd
    try:
        assert_within_budget()
        raised = False
    except BudgetExceeded:
        raised = True
    assert raised, "second call must be blocked"


def test_zero_budget_is_unlimited(monkeypatch):
    reset_memory()
    monkeypatch.setenv("GPT_BUDGET_REDIS", "false")
    monkeypatch.setenv("GPT_DAILY_BUDGET_USD", "0")
    monkeypatch.setenv("GPT_MONTHLY_BUDGET_USD", "0")
    assert_within_budget()
