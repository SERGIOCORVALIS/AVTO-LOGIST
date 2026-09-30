"""Production boot checks shared by orchestrator (and tests)."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any


def _env_on(name: str) -> bool:
    return (os.getenv(name) or "").strip().lower() in ("1", "true", "yes", "on")


def _is_production() -> bool:
    return (os.getenv("ALO_ENV") or "").lower() == "production" or (
        os.getenv("NODE_ENV") or ""
    ).lower() == "production"


def _email_ok(value: str | None) -> bool:
    return bool(value and "@" in value)


def has_supplier_email_channels() -> bool:
    if _email_ok(os.getenv("SUPPLIER_QUOTE_EMAILS")):
        return True
    if _email_ok(os.getenv("PARTNER_QUOTE_EMAILS")):
        return True
    if _email_ok(os.getenv("SOURCING_QUOTE_EMAILS")):
        return True
    for key, val in os.environ.items():
        if key.startswith(("SUPPLIER_EMAIL_", "PARTNER_EMAIL_")) and _email_ok(val):
            return True
    return False


def has_mail_transport() -> bool:
    """True when workers can send/receive mail (MAIL_* or SMTP_*)."""
    provider = (os.getenv("MAIL_PROVIDER") or "custom").strip().lower()
    user = (
        os.getenv("MAIL_USER") or os.getenv("SMTP_USER") or os.getenv("IMAP_USER") or ""
    ).strip()
    password = (
        os.getenv("MAIL_APP_PASSWORD")
        or os.getenv("MAIL_PASSWORD")
        or os.getenv("SMTP_PASS")
        or os.getenv("IMAP_PASS")
        or ""
    ).strip()
    if provider in ("gmail", "yandex"):
        return bool(user and password)
    if (os.getenv("SMTP_HOST") or "").strip():
        return bool(user and password)
    return False


def has_db_partner_email_channels() -> bool:
    try:
        from common.db import list_approved_partner_emails

        return bool(list_approved_partner_emails(limit=1))
    except Exception:
        return False


def has_http_partner_channels() -> bool:
    for key, val in os.environ.items():
        if key.startswith(("SUPPLIER_HTTP_", "PARTNER_HTTP_")) and (val or "").startswith(
            "http"
        ):
            return True
    return False


def _tariffs_dir() -> Path:
    return Path(__file__).resolve().parents[2] / "data" / "partner_tariffs"


def list_active_tariff_files() -> list[str]:
    root = _tariffs_dir()
    if not root.is_dir():
        return []
    out: list[str] = []
    for path in root.glob("*.json"):
        if path.stem.startswith("example") or path.name.endswith(".example.json"):
            continue
        out.append(path.name)
    return sorted(out)


def has_file_tariff_channels() -> bool:
    if not _env_on("ALLOW_FILE_TARIFFS"):
        return False
    return bool(list_active_tariff_files())


def has_partner_channels() -> bool:
    return (
        has_supplier_email_channels()
        or has_db_partner_email_channels()
        or has_http_partner_channels()
        or has_file_tariff_channels()
    )


def inspect_boot_config() -> dict[str, Any]:
    return {
        "production": _is_production(),
        "partner_channels": {
            "email": has_supplier_email_channels() or has_db_partner_email_channels(),
            "http": has_http_partner_channels(),
            "file_tariffs": has_file_tariff_channels(),
            "tariff_files": list_active_tariff_files(),
        },
        "mail_transport": has_mail_transport(),
        "mock_rates": _env_on("ALLOW_MOCK_RATES"),
        "openai_configured": bool((os.getenv("OPENAI_API_KEY") or "").strip()),
        "openai_models": {
            "main": (os.getenv("OPENAI_MODEL") or "").strip(),
            "fast": (os.getenv("OPENAI_FAST_MODEL") or "").strip(),
            "coding": (os.getenv("OPENAI_CODING_MODEL") or "").strip(),
            "document": (os.getenv("OPENAI_DOCUMENT_MODEL") or "").strip(),
            "transcribe": (os.getenv("OPENAI_TRANSCRIBE_MODEL") or "").strip(),
            "realtime": (os.getenv("OPENAI_REALTIME_MODEL") or "").strip(),
            "embedding": (os.getenv("OPENAI_EMBEDDING_MODEL") or "").strip(),
            "reasoning_effort": (os.getenv("OPENAI_REASONING_EFFORT") or "").strip(),
            "timeout_sec": (os.getenv("OPENAI_TIMEOUT_SEC") or "").strip(),
            "max_completion_tokens": (os.getenv("OPENAI_MAX_COMPLETION_TOKENS") or "").strip(),
        },
    }


def assert_production_ready() -> dict[str, Any]:
    """Raise RuntimeError if production config is unsafe / incomplete."""
    report = inspect_boot_config()
    if not _is_production():
        return report

    token = (os.getenv("INTERNAL_API_TOKEN") or "").strip()
    if len(token) < 16:
        raise RuntimeError(
            "INTERNAL_API_TOKEN is required in production (min 16 chars)"
        )

    if _env_on("ALLOW_MOCK_RATES"):
        raise RuntimeError(
            "ALLOW_MOCK_RATES=true is forbidden in production — use supplier emails, "
            "PARTNER_HTTP_*, or ALLOW_FILE_TARIFFS + data/partner_tariffs/*.json"
        )

    if not has_partner_channels():
        raise RuntimeError(
            "Production requires partner channels: SUPPLIER_QUOTE_EMAILS / "
            "SUPPLIER_EMAIL_* / PARTNER_HTTP_* / or ALLOW_FILE_TARIFFS with baseline JSON"
        )

    if not (os.getenv("OPENAI_API_KEY") or "").strip():
        raise RuntimeError("OPENAI_API_KEY is required in production")

    return report
