from common.boot_guard import inspect_boot_config
from common.llm import (
    embedding_model,
    model_for,
    openai_reasoning_effort,
    openai_timeout_sec,
    realtime_model,
    transcribe_model,
    _max_completion_tokens,
)


def test_openai_env_roles_and_limits(monkeypatch):
    monkeypatch.setenv("OPENAI_MODEL", "gpt-5.6-sol")
    monkeypatch.setenv("OPENAI_FAST_MODEL", "gpt-5.6-luna")
    monkeypatch.setenv("OPENAI_CODING_MODEL", "gpt-5.6-sol")
    monkeypatch.setenv("OPENAI_DOCUMENT_MODEL", "gpt-5.6-sol")
    monkeypatch.setenv("OPENAI_TRANSCRIBE_MODEL", "gpt-transcribe")
    monkeypatch.setenv("OPENAI_REALTIME_MODEL", "gpt-realtime-2.1")
    monkeypatch.setenv("OPENAI_EMBEDDING_MODEL", "text-embedding-3-large")
    monkeypatch.setenv("OPENAI_REASONING_EFFORT", "high")
    monkeypatch.setenv("OPENAI_TIMEOUT_SEC", "120")
    monkeypatch.setenv("OPENAI_MAX_COMPLETION_TOKENS", "32768")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")

    assert model_for("main") == "gpt-5.6-sol"
    assert model_for("fast") == "gpt-5.6-luna"
    assert model_for("coding") == "gpt-5.6-sol"
    assert model_for("document") == "gpt-5.6-sol"
    assert transcribe_model() == "gpt-transcribe"
    assert realtime_model() == "gpt-realtime-2.1"
    assert embedding_model() == "text-embedding-3-large"
    assert openai_reasoning_effort() == "high"
    assert openai_timeout_sec() == 120.0
    assert _max_completion_tokens() == 32768

    report = inspect_boot_config()
    assert report["openai_configured"] is True
    assert report["openai_models"]["main"] == "gpt-5.6-sol"
    assert report["openai_models"]["fast"] == "gpt-5.6-luna"
    assert report["openai_models"]["transcribe"] == "gpt-transcribe"
    assert report["openai_models"]["reasoning_effort"] == "high"


def test_settings_exposes_all_openai_fields():
    from common import settings

    for name in (
        "openai_model",
        "openai_fast_model",
        "openai_coding_model",
        "openai_document_model",
        "openai_transcribe_model",
        "openai_realtime_model",
        "openai_embedding_model",
        "openai_base_url",
        "openai_reasoning_effort",
        "openai_timeout_sec",
        "openai_max_completion_tokens",
        "gpt_daily_budget_usd",
        "gpt_monthly_budget_usd",
        "gpt_budget_redis",
    ):
        assert hasattr(settings, name), name
