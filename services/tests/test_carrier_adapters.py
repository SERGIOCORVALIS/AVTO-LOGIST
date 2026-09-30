"""Fixture tests for PEK / Delovye Linii carrier adapters (no live API keys)."""
from __future__ import annotations

import json
from pathlib import Path

import httpx

from agents.carrier_adapters import CarrierHttpAdapter, LaneTariffFileAdapter


def test_lane_tariff_file_moscow_spb():
    path = Path(__file__).resolve().parents[2] / "data" / "partner_tariffs" / "pek_ru_ltl.json"
    adapter = LaneTariffFileAdapter("pek", path)
    q = adapter.quote(100, "Москва → Санкт-Петербург", {"transport_mode": "ltl"})
    assert q["source"] == "file:pek"
    assert q["price"] > 0
    assert q["currency"] == "RUB"
    assert q["eta_days_min"] is not None


def test_carrier_http_adapter_parses_post_json(monkeypatch):
    calls: list[dict] = []

    class FakeResponse:
        status_code = 200

        @staticmethod
        def json():
            return {
                "price": 12500,
                "currency": "RUB",
                "eta_days_min": 3,
                "eta_days_max": 5,
                "reliability_score": 0.8,
            }

        @staticmethod
        def raise_for_status():
            return None

    def fake_post(url, json=None, headers=None, **_kwargs):
        calls.append({"url": url, "json": json, "headers": headers})
        return FakeResponse()

    monkeypatch.setattr("common.http_client.partner_post", fake_post)
    adapter = CarrierHttpAdapter("pek", "https://api.example/pek", "test-key")
    q = adapter.quote(50, "Москва → Екатеринбург", {"transport_mode": "ltl"})
    assert q["source"] == "api:pek"
    assert q["price"] == 12500
    assert calls[0]["json"]["kg"] == 50
    assert calls[0]["headers"]["Authorization"] == "Bearer test-key"


def test_carrier_http_fallback_get_on_404(monkeypatch):
    class NotFound:
        status_code = 404

        @staticmethod
        def raise_for_status():
            raise httpx.HTTPStatusError("404", request=None, response=None)

    class Ok:
        status_code = 200

        @staticmethod
        def json():
            return {"total": 9900, "currency": "RUB", "eta": [4, 6]}

        @staticmethod
        def raise_for_status():
            return None

    def fake_post(*_a, **_k):
        return NotFound()

    def fake_get(url, params=None, headers=None, **_kwargs):
        return Ok()

    monkeypatch.setattr("common.http_client.partner_post", fake_post)
    monkeypatch.setattr("common.http_client.partner_get", fake_get)
    adapter = CarrierHttpAdapter("dellin", "https://api.example/dellin")
    q = adapter.quote(20, "Москва -> Новосибирск")
    assert q["price"] == 9900
    assert q["source"] == "api:dellin"


def test_build_carrier_adapters_prefers_http(monkeypatch, tmp_path):
    from agents import carrier_adapters as mod

    monkeypatch.setenv("PARTNER_HTTP_PEK", "https://live.pek/quote")
    monkeypatch.setenv("PARTNER_KEY_PEK", "k1")
    adapters = mod.build_carrier_adapters()
    codes = [getattr(a, "code", None) for a in adapters]
    assert "pek" in codes
    pek = next(a for a in adapters if a.code == "pek")
    assert isinstance(pek, CarrierHttpAdapter)


def test_pek_lane_fixture_shape():
    path = Path(__file__).resolve().parents[2] / "data" / "partner_tariffs" / "pek_ru_ltl.json"
    cfg = json.loads(path.read_text(encoding="utf-8"))
    assert cfg["code"] == "pek"
    assert "lanes" in cfg
    assert cfg["base_per_kg"] > 0
