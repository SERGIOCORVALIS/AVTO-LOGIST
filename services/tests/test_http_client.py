"""Tests for partner HTTPS SSL / timeout helpers."""

from __future__ import annotations

import httpx


def test_partner_ssl_verify_and_timeout(monkeypatch):
    from common import http_client as mod

    monkeypatch.setenv("PARTNER_SSL_VERIFY", "false")
    monkeypatch.setenv("PARTNER_HTTP_TIMEOUT_SEC", "30")
    assert mod.partner_ssl_verify() is False
    t = mod.partner_http_timeout()
    assert isinstance(t, httpx.Timeout)
    assert float(t.read) == 30.0


def test_cabinet_ssl_fallback(monkeypatch):
    from common import http_client as mod

    monkeypatch.delenv("PARTNER_SSL_VERIFY", raising=False)
    monkeypatch.setenv("CABINET_SSL_VERIFY", "false")
    assert mod.partner_ssl_verify() is False
