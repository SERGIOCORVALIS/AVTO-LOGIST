import os

from common.boot_guard import (
    assert_production_ready,
    has_file_tariff_channels,
    has_partner_channels,
    list_active_tariff_files,
)


def test_baseline_tariffs_on_disk():
    files = list_active_tariff_files()
    assert "ru_ltl_baseline.json" in files
    assert "cn_air_baseline.json" in files
    assert "cn_ru_ltl_baseline.json" in files


def test_file_tariffs_channel(monkeypatch):
    monkeypatch.setenv("ALLOW_FILE_TARIFFS", "true")
    assert has_file_tariff_channels() is True
    assert has_partner_channels() is True


def test_assert_production_blocks_mock(monkeypatch):
    monkeypatch.setenv("ALO_ENV", "production")
    monkeypatch.setenv("INTERNAL_API_TOKEN", "x" * 32)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setenv("ALLOW_MOCK_RATES", "true")
    monkeypatch.setenv("ALLOW_FILE_TARIFFS", "true")
    try:
        assert_production_ready()
        raised = False
    except RuntimeError as exc:
        raised = True
        assert "ALLOW_MOCK_RATES" in str(exc)
    assert raised


def test_assert_production_ok_with_file_tariffs(monkeypatch):
    monkeypatch.setenv("ALO_ENV", "production")
    monkeypatch.setenv("INTERNAL_API_TOKEN", "x" * 32)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setenv("ALLOW_MOCK_RATES", "false")
    monkeypatch.setenv("ALLOW_FILE_TARIFFS", "true")
    for key in list(os.environ):
        if key.startswith(("SUPPLIER_EMAIL_", "PARTNER_EMAIL_", "SUPPLIER_HTTP_", "PARTNER_HTTP_")):
            monkeypatch.delenv(key, raising=False)
    monkeypatch.delenv("SUPPLIER_QUOTE_EMAILS", raising=False)
    monkeypatch.delenv("PARTNER_QUOTE_EMAILS", raising=False)
    report = assert_production_ready()
    assert report["partner_channels"]["file_tariffs"] is True


def test_has_mail_transport_yandex(monkeypatch):
    monkeypatch.setenv("MAIL_PROVIDER", "yandex")
    monkeypatch.setenv("MAIL_USER", "ops@example.com")
    monkeypatch.setenv("MAIL_APP_PASSWORD", "secret")
    from common.boot_guard import has_mail_transport, inspect_boot_config

    assert has_mail_transport() is True
    report = inspect_boot_config()
    assert report["mail_transport"] is True


def test_prefer_ipv4_loopback():
    from common import prefer_ipv4_loopback

    assert (
        prefer_ipv4_loopback("postgresql://alo:alo@localhost:5434/db")
        == "postgresql://alo:alo@127.0.0.1:5434/db"
    )
    assert prefer_ipv4_loopback("redis://localhost:6379") == "redis://127.0.0.1:6379"
