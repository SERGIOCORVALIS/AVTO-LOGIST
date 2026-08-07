from common import detect_grey_scheme
from agents.cargo import estimate_cargo, _infer_category, search_web_analog
from agents.negotiator import price_offer
from agents.rates import compare_quotes, fetch_mock_quotes, negotiate_carrier
from agents.customs import compute_customs_clearance, format_customs_for_client
from common.fx import to_rub


def test_grey_scheme_detection():
    assert detect_grey_scheme("давайте занизим инвойс")
    assert detect_grey_scheme("under value the invoice")
    assert not detect_grey_scheme("нужна белая доставка с таможней")


def test_infer_category():
    assert _infer_category("200 powerbank") == "powerbank"
    assert _infer_category("футболки хлопок") == "textile"


def test_estimate_cargo():
    deal = {"cargo": {"name": "powerbank", "quantity": 200, "category": "powerbank"}}
    est = estimate_cargo(deal)
    assert est["chargeable_weight_kg"] > 0
    assert est["source"] in (
        "category_heuristic",
        "client",
        "web_analog",
        "past_deal_analog",
        "llm_analog",
    )


def test_pricing_floor():
    policy = {"target_margin_pct": 18, "floor_margin_pct": 10, "max_discount_pct": 8}
    offer = price_offer(100_000, policy, client_ask_discount_pct=50)
    assert offer["needs_approve"] is True
    assert offer["margin_pct"] >= 10


def test_compare_quotes():
    deal = {"cargo": {}, "route": {}}
    quotes = fetch_mock_quotes(deal, 50, "GZ -> MOW")
    ranked = compare_quotes(quotes)
    assert len(ranked) == 3
    assert ranked[0]["score"] >= ranked[-1]["score"]


def test_fx_to_rub():
    assert to_rub(100, "RUB") == 100
    assert to_rub(1, "USD") > 1


def test_customs_vat_with_invoice():
    deal = {
        "cargo": {
            "name": "powerbank",
            "category": "powerbank",
            "battery": True,
            "invoice_value": 10000,
            "invoice_currency": "USD",
        }
    }
    legal = {
        "hs_candidates": [
            {"code": "8507.60", "duty_rate": 5.0, "uncertainty": 0.4}
        ]
    }
    est = compute_customs_clearance(deal, legal, freight_rub=50000)
    assert est["missing_invoice"] is False
    assert est["duty_pct"] == 5.0
    assert est["vat_pct"] == 20.0
    assert est["duty_rub"] > 0
    assert est["vat_rub"] > 0
    cv = est["customs_value_rub"]
    expected_vat = round((cv + est["duty_rub"] + est["excise_rub"]) * 0.20, 2)
    assert abs(est["vat_rub"] - expected_vat) < 0.02
    assert est["clearance_total_rub"] >= est["duty_rub"] + est["vat_rub"]
    text = format_customs_for_client(est).lower()
    assert "ндс" in text or "vat" in text


def test_customs_without_invoice_no_fake_vat():
    deal = {"cargo": {"name": "goods", "category": "general"}}
    est = compute_customs_clearance(deal, {})
    assert est["missing_invoice"] is True
    assert est["duty_rub"] is None
    assert est["vat_rub"] is None
    assert est["broker_fee_rub"] > 0


def test_negotiate_carrier_does_not_fake_discount():
    quote = {
        "price": 100_000,
        "currency": "RUB",
        "source": "api:test",
        "partner": "demo_express",
        "route_summary": "GZ -> MOW",
        "reliability_score": 0.8,
        "eta_days_min": 8,
        "eta_days_max": 12,
    }
    out = negotiate_carrier(quote, aggression=0.04)
    assert out["price"] == 100_000
    assert out["negotiation"]["achieved"] is False
    assert out["negotiation"]["asked_price"] == 96000


def test_search_web_analog_returns_dims():
    hit = search_web_analog("powerbank 20000mah")
    assert hit is not None
    assert hit["kg"] > 0
    assert hit["l"] > 0


def test_compare_quotes_skips_errors():
    ranked = compare_quotes(
        [
            {"price": 10_000, "reliability_score": 0.9, "eta_days_min": 5, "eta_days_max": 7},
            {"price": 999999999, "error": "timeout", "reliability_score": 0},
        ]
    )
    assert len(ranked) == 1
    assert ranked[0]["price"] == 10_000


def test_playbook_merges_into_policy():
    from learning.loop import merge_playbook_into_policy

    policy = {"target_margin_pct": 18, "floor_margin_pct": 10, "max_discount_pct": 8}
    merged = merge_playbook_into_policy(
        policy,
        {
            "lane": "canary",
            "version": "v2",
            "body": {"target_margin_pct": 20, "target_margin_delta_pp": 1},
        },
    )
    assert merged["target_margin_pct"] == 21
    assert merged["playbook_lane"] == "canary"
    offer = price_offer(100_000, merged)
    assert offer["margin_pct"] >= 20


def test_allow_mock_rates_respects_env(monkeypatch):
    from agents.rates import allow_mock_rates, fetch_mock_quotes

    monkeypatch.setenv("ALLOW_MOCK_RATES", "false")
    monkeypatch.setenv("ALO_ENV", "production")
    assert allow_mock_rates() is False
    assert fetch_mock_quotes({}, 10, "A->B") == []

