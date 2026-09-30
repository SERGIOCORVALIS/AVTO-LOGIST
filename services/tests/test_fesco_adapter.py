"""Unit tests for FESCO FIT adapter (mocked HTTP)."""

from __future__ import annotations

import json

from agents.fesco_adapter import FescoFitAdapter, _match_location, _offer_total_rub


def test_match_location_vladivostok():
    locs = [
        {"id": "1", "name": "Москва", "country": "Россия"},
        {"id": "2", "name": "Владивосток", "country": "Россия", "nameLatin": "Vladivostok"},
    ]
    hit = _match_location(locs, "vladivostok")
    assert hit and hit["id"] == "2"


def test_offer_total_from_segments():
    offer = {
        "Segments": [
            {"Containers": [{"Price": 1000, "Currency": "RUB"}]},
            {"Containers": [{"Price": 500, "Currency": "RUB"}]},
        ]
    }
    assert _offer_total_rub(offer) == 1500.0


def test_fesco_quote_happy_path(monkeypatch):
    calls: list[str] = []

    class FakeResp:
        def __init__(self, payload):
            self._payload = payload
            self.status_code = 200

        def raise_for_status(self):
            return None

        def json(self):
            return self._payload

    def fake_get(url, **_kwargs):
        calls.append(url)
        if "/from?" in url:
            return FakeResp(
                {
                    "data": [
                        {"id": "from1", "name": "Москва", "country": "Россия"},
                    ]
                }
            )
        if "/to?" in url:
            return FakeResp(
                {
                    "data": [
                        {"id": "to1", "name": "Владивосток", "country": "Россия"},
                    ]
                }
            )
        if "/wte?" in url:
            return FakeResp(
                {
                    "data": [
                        {"id": "wte40", "name": "40' HC", "size": "40"},
                    ]
                }
            )
        if "offers/fit" in url:
            return FakeResp(
                {
                    "data": [
                        {
                            "RouteID": "R1",
                            "DateTo": "2026-12-01",
                            "Segments": [
                                {"Containers": [{"Price": 185000, "Currency": "RUB"}]}
                            ],
                            "Services": [],
                        }
                    ]
                }
            )
        raise AssertionError(url)

    monkeypatch.setenv("PARTNER_HTTP_FESCO", "https://api.fesco.com/api/v1/lk/calc/fit")
    monkeypatch.setenv("FESCO_OFFERS_URL", "https://my.fesco.com/api/v2/lk/offers/fit")
    monkeypatch.setenv("PARTNER_KEY_FESCO", "test-jwt")
    monkeypatch.setattr("agents.fesco_adapter.partner_get", fake_get)

    q = FescoFitAdapter().quote(
        1000,
        "Москва → Владивосток",
        {"transport_mode": "container", "cargo_summary": "40ft контейнер"},
    )
    assert q["source"] == "api:fesco"
    assert q["price"] == 185000
    assert q["partner"] == "fesco"
    assert any("/from?" in u for u in calls)
    assert any("offers/fit" in u for u in calls)


def test_build_fesco_in_all_adapters(monkeypatch):
    monkeypatch.setenv("PARTNER_HTTP_FESCO", "https://api.fesco.com/api/v1/lk/calc/fit")
    monkeypatch.setenv("PARTNER_KEY_FESCO", "x")
    monkeypatch.setenv("ALLOW_MOCK_RATES", "false")
    from agents.adapters import all_adapters
    from agents.fesco_adapter import FescoFitAdapter

    codes = [a.code for a in all_adapters()]
    assert "fesco" in codes
    assert sum(1 for a in all_adapters() if isinstance(a, FescoFitAdapter)) == 1
