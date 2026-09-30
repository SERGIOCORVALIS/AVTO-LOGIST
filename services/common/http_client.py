"""Shared HTTPS client settings for partner / cabinet rate requests.

Russian operator portals often present corporate/self-signed chains.
Defaults: verify SSL (PARTNER_SSL_VERIFY / CABINET_SSL_VERIFY), longer timeout.
"""

from __future__ import annotations

import os

import httpx


def _env_bool(name: str, default: bool = True) -> bool:
    raw = (os.getenv(name) or "").strip().lower()
    if not raw:
        return default
    return raw in ("1", "true", "yes", "on")


def partner_ssl_verify() -> bool:
    """TLS certificate verification for PARTNER_HTTP_* / SUPPLIER_HTTP_* quotes."""
    if (os.getenv("PARTNER_SSL_VERIFY") or "").strip():
        return _env_bool("PARTNER_SSL_VERIFY", True)
    if (os.getenv("CABINET_SSL_VERIFY") or "").strip():
        return _env_bool("CABINET_SSL_VERIFY", True)
    return True


def partner_http_timeout() -> httpx.Timeout:
    """Connect/read timeout for live partner quote HTTPS calls."""
    raw = (
        os.getenv("PARTNER_HTTP_TIMEOUT_SEC")
        or os.getenv("CABINET_HTTP_TIMEOUT_SEC")
        or "45"
    ).strip()
    try:
        total = float(raw or 45)
    except ValueError:
        total = 45.0
    if total <= 0:
        total = 45.0
    connect = min(25.0, total)
    return httpx.Timeout(total, connect=connect)


def partner_http_client(**kwargs) -> httpx.Client:
    """httpx.Client with project SSL / timeout defaults (caller closes)."""
    verify = kwargs.pop("verify", partner_ssl_verify())
    timeout = kwargs.pop("timeout", partner_http_timeout())
    return httpx.Client(verify=verify, timeout=timeout, follow_redirects=True, **kwargs)


def partner_get(url: str, **kwargs) -> httpx.Response:
    verify = kwargs.pop("verify", partner_ssl_verify())
    timeout = kwargs.pop("timeout", partner_http_timeout())
    return httpx.get(url, verify=verify, timeout=timeout, follow_redirects=True, **kwargs)


def partner_post(url: str, **kwargs) -> httpx.Response:
    verify = kwargs.pop("verify", partner_ssl_verify())
    timeout = kwargs.pop("timeout", partner_http_timeout())
    return httpx.post(url, verify=verify, timeout=timeout, follow_redirects=True, **kwargs)
