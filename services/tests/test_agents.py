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
        "partial_client",
        "web_analog",
        "past_deal_analog",
        "llm_analog",
    )


def test_pricing_floor():
    policy = {"target_margin_pct": 18, "floor_margin_pct": 10, "max_discount_pct": 8}
    offer = price_offer(100_000, policy, client_ask_discount_pct=50)
    assert offer["needs_approve"] is True
    assert offer["margin_pct"] >= 10


def test_compare_quotes(monkeypatch):
    monkeypatch.setenv("ALLOW_MOCK_RATES", "true")
    deal = {"cargo": {}, "route": {}}
    quotes = fetch_mock_quotes(deal, 50, "GZ -> MOW")
    ranked = compare_quotes(quotes)
    assert len(ranked) == 3
    assert ranked[0]["score"] >= ranked[-1]["score"]


def test_fx_to_rub():
    assert to_rub(100, "RUB") == 100
    assert to_rub(1, "USD") > 1


def test_customs_keeps_gpt_duty_and_vat():
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
        ],
        "duties_estimate": {
            "customs_value_rub": 800_000,
            "invoice_value_rub": 800_000,
            "duty_pct": 5.0,
            "duty_rub": 40_000,
            "vat_pct": 20.0,
            "vat_rub": 168_000,
            "vat_base_rub": 840_000,
            "excise_rub": 0,
            "broker_fee_rub": 8_000,
            "cert_fee_rub": 15_000,
            "clearance_total_rub": 231_000,
            "missing_invoice": False,
            "formula": "duty=CV*duty_pct/100; vat=(CV+duty+excise)*vat_pct/100",
            "battery": True,
            "restricted": False,
            "source": "gpt:legal",
        },
    }
    est = compute_customs_clearance(deal, legal, freight_rub=50000, use_gpt=False)
    assert est["missing_invoice"] is False
    assert est["duty_pct"] == 5.0
    assert est["vat_pct"] == 20.0
    assert est["duty_rub"] == 40_000
    assert est["vat_rub"] == 168_000
    assert est["clearance_total_rub"] == 231_000
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
            "body": {
                "target_margin_pct": 20,
                "target_margin_delta_pp": 1,
                "tone": "commercial",
                "always_ask_client": ["weight_kg"],
                "client_do_not_say": ["маржа"],
            },
        },
    )
    assert merged["target_margin_pct"] == 21
    assert merged["playbook_lane"] == "canary"
    assert merged["comm_tone"] == "commercial"
    assert merged["always_ask_client"] == ["weight_kg"]
    assert merged["client_do_not_say"] == ["маржа"]
    offer = price_offer(100_000, merged)
    assert offer["margin_pct"] >= 20


def test_allow_mock_rates_respects_env(monkeypatch):
    from agents.rates import allow_mock_rates, fetch_mock_quotes 

    monkeypatch.setenv("ALLOW_MOCK_RATES", "false")
    monkeypatch.setenv("ALO_ENV", "production")
    assert allow_mock_rates() is False
    assert fetch_mock_quotes({}, 10, "A->B") == []


def test_restrictions_liquid_bulk():
    from agents.restrictions import evaluate_restrictions

    r = evaluate_restrictions("нужно отправить налив в цистерне Новосибирск-Москва")
    assert r.hard_block is True
    assert r.code == "bulk_liquid"


def test_restrictions_forbidden_cdek():
    from agents.restrictions import detect_competitor, detect_forbidden_carrier, evaluate_restrictions

    assert detect_forbidden_carrier("отправьте через СДЭК") == "cdek"
    assert detect_forbidden_carrier("через ПЭК") is None
    assert detect_competitor("через ПЭК") == "pek"
    r = evaluate_restrictions("можно через Деловые Линии?")
    assert r.hard_block is False
    assert r.code and r.code.startswith("groupage_supplier")


def test_pek_is_competitor_and_possible_supplier():
    from agents.restrictions import evaluate_restrictions

    r = evaluate_restrictions("отправьте через ПЭК из Москвы в Казань")
    assert r.hard_block is False
    assert r.code == "groupage_supplier:pek"
    blob = " ".join(r.reply_messages).lower()
    assert "конкурент" in blob
    assert "поставщик" in blob


def test_restrictions_ru_strips_china_services():
    from agents.restrictions import evaluate_restrictions

    r = evaluate_restrictions(
        "перевозка по россии",
        {},
        {"corridor": "ru_domestic"},
        {
            "logistics": True,
            "buyout": True,
            "customs_clearance": True,
            "insurance": True,
        },
    )
    assert r.hard_block is False
    assert r.services_override is not None
    assert r.services_override["logistics"] is True
    assert r.services_override["buyout"] is False
    assert r.services_override["customs_clearance"] is False


def test_catalog_incoterms_pair_and_divisor():
    from agents.catalog import format_incoterms_pair, volumetric_divisor, ready_to_quote

    assert format_incoterms_pair("exw", "dap") == "EXW-DAP"
    assert format_incoterms_pair("FOB", "FOB") == "FOB-FOB"
    assert volumetric_divisor("air") == 6000
    assert volumetric_divisor("rail") == 1000
    assert volumetric_divisor("ltl_groupage") == 5000
    assert ready_to_quote(
        {"name": "коробки"},
        {
            "origin_city": "Novosibirsk",
            "destination_city": "Moscow",
            "corridor": "ru_domestic",
            "ready_date": "сейчас",
        },
        {"logistics": True},
    )
    assert not ready_to_quote(
        {"name": "коробки"},
        {"origin_city": "Novosibirsk", "destination_city": "Moscow", "corridor": "ru_domestic"},
        {"logistics": True},
    )


def test_estimate_cargo_uses_mode_divisor():
    air = estimate_cargo(
        {
            "cargo": {"name": "box", "quantity": 1, "length_cm": 60, "width_cm": 40, "height_cm": 40, "weight_kg": 1},
            "route": {"transport_mode": "air", "corridor": "cn_import"},
        }
    )
    rail = estimate_cargo(
        {
            "cargo": {"name": "box", "quantity": 1, "length_cm": 60, "width_cm": 40, "height_cm": 40, "weight_kg": 1},
            "route": {"transport_mode": "rail", "corridor": "ru_domestic"},
        }
    )
    assert air["volumetric_divisor"] == 6000
    assert rail["volumetric_divisor"] == 1000
    assert rail["volumetric_weight_kg"] > air["volumetric_weight_kg"]


def test_json_tariff_skips_other_corridor():
    from pathlib import Path
    from agents.adapters import JsonTariffFileAdapter

    path = Path(__file__).resolve().parents[2] / "data" / "partner_tariffs" / "example_ru_ltl.json"
    adapter = JsonTariffFileAdapter("ru_ltl", path)
    miss = adapter.quote(10, "NSK-MOW", ctx={"corridor": "cn_import", "transport_mode": "air"})
    assert miss.get("error") == "mode_mismatch"
    hit = adapter.quote(10, "NSK-MOW", ctx={"corridor": "ru_domestic", "transport_mode": "ltl_groupage"})
    assert not hit.get("error")
    assert hit["price"] > 0


def test_heuristic_concierge_ru_and_pek():
    from agents.concierge import _heuristic_concierge

    ru = _heuristic_concierge({}, "Сборка тарно-штучный Новосибирск Москва 2 тонны")
    assert ru["route_updates"].get("corridor") == "ru_domestic"
    assert ru["route_updates"].get("transport_mode") == "ltl_groupage"
    assert ru["cargo_updates"].get("weight_kg") == 2000
    # Card incomplete without ready_date — one human question
    blob_ru = " ".join(ru.get("reply_messages") or []).lower()
    assert "готов" in blob_ru or "отгруз" in blob_ru
    pek = _heuristic_concierge({}, "отправьте через ПЭК из Москвы в Казань")
    assert pek.get("hard_block") is not True
    blob = " ".join(pek.get("reply_messages") or []).lower()
    assert "конкурент" in blob or "товар" in blob or "готов" in blob
    assert pek["route_updates"].get("origin_city")
    assert pek["route_updates"].get("destination_city")


def test_heuristic_cn_exw_dap_buyout():
    from agents.concierge import _heuristic_concierge

    data = _heuristic_concierge(
        {},
        "Импорт из Китая: выкуп и доставка сборкой EXW Гуанчжоу DAP Москва, 120 кг",
    )
    route = data["route_updates"]
    assert route.get("corridor") == "cn_import"
    assert route.get("origin_incoterm") == "EXW"
    assert route.get("dest_incoterm") == "DAP"
    assert route.get("incoterms") == "EXW-DAP"
    assert "buyout" in (data.get("services") or [])



def test_cdek_adapter_not_registered(monkeypatch):
    from agents.adapters import all_adapters 

    monkeypatch.setenv("PARTNER_CDEK_ACCOUNT", "acc")
    monkeypatch.setenv("PARTNER_CDEK_SECURE", "sec")
    monkeypatch.setenv("PARTNER_HTTP_PEK", "https://pecom.ru/api/quote")
    monkeypatch.setenv("ALLOW_MOCK_RATES", "false")
    codes = [a.code for a in all_adapters()]
    assert "cdek" not in codes


def test_model_candidates_split_and_reasoning():
    from common.llm import is_reasoning_model, model_candidates, model_for

    assert model_candidates("gpt-5.6-sol,gpt-5.5,gpt-4o")[0] == "gpt-5.6-sol"
    assert "gpt-4o" in model_candidates("gpt-5.6-sol, gpt-4o")
    assert is_reasoning_model("gpt-5.6-sol")
    assert is_reasoning_model("gpt-5.6-luna")
    assert not is_reasoning_model("gpt-4o")


def test_model_for_reads_role_env(monkeypatch):
    from common.llm import model_for

    monkeypatch.setenv("OPENAI_MODEL", "gpt-5.6-sol")
    monkeypatch.setenv("OPENAI_FAST_MODEL", "gpt-5.6-luna")
    monkeypatch.setenv("OPENAI_CODING_MODEL", "gpt-5.6-sol")
    monkeypatch.setenv("OPENAI_DOCUMENT_MODEL", "gpt-5.6-sol")
    assert model_for("main") == "gpt-5.6-sol"
    assert model_for("fast") == "gpt-5.6-luna"
    assert model_for("coding") == "gpt-5.6-sol"
    assert model_for("document") == "gpt-5.6-sol"


def test_llm_rejects_empty_or_refused_completion():
    from types import SimpleNamespace

    from common.llm import _completion_text
    import pytest

    empty = SimpleNamespace(
        choices=[
            SimpleNamespace(
                finish_reason="length",
                message=SimpleNamespace(content=None, refusal=None),
            )
        ]
    )
    with pytest.raises(RuntimeError, match="empty LLM content"):
        _completion_text(empty)

    refused = SimpleNamespace(
        choices=[
            SimpleNamespace(
                finish_reason="stop",
                message=SimpleNamespace(content=None, refusal="policy"),
            )
        ]
    )
    with pytest.raises(RuntimeError, match="refusal"):
        _completion_text(refused)

    ok = SimpleNamespace(
        choices=[
            SimpleNamespace(
                finish_reason="stop",
                message=SimpleNamespace(content='{"a": 1}', refusal=None),
            )
        ]
    )
    assert _completion_text(ok) == '{"a": 1}'


def test_heuristic_does_not_eat_greeting_as_cargo():
    from agents.concierge import _heuristic_concierge

    data = _heuristic_concierge({}, "привет")
    assert not (data.get("cargo_updates") or {}).get("name") == "привет"


def test_normalize_deal_status_maps_gpt_aliases():
    from agents.catalog import normalize_deal_status    

    assert normalize_deal_status("intake") == "intake"
    assert normalize_deal_status("clarify_route") == "intake"
    assert normalize_deal_status("quote_calculation") == "quoting"
    assert normalize_deal_status("cargo_details") == "intake"
    assert normalize_deal_status(" уточнение параметров перевозки") == "intake"


def test_detect_client_intent_lifecycle():
    from agents.lifecycle import detect_client_intent

    deal = {"status": "negotiation", "offer": {"price": 120000}}
    assert detect_client_intent("согласен", deal) == "accept_offer"
    assert detect_client_intent("согласен с договором", {"status": "contract"}) == "accept_contract"
    assert detect_client_intent("оплатили, вот чек", deal) == "payment_sent"
    assert detect_client_intent("где сейчас груз?", deal) == "tracking"
    assert detect_client_intent("можете скидку?", deal) == "request_discount"
    assert detect_client_intent("дорого", deal) == "request_discount"
    assert detect_client_intent("дорого ли выйдет из Китая?", {"status": "intake"}) == "question"


def test_new_order_split_does_not_mix_cargo():
    from agents.order_split import looks_like_new_order

    deal = {
        "status": "quoting",
        "cargo": {"name": "мясорубки Redmond"},
        "route": {"origin_city": "Hangzhou", "destination_city": "Khimki"},
    }
    assert looks_like_new_order(
        "ещё посчитайте холодильники из Гуанчжоу в Новосибирск",
        deal,
        {"name": "холодильники"},
        {"origin_city": "Guangzhou", "destination_city": "Novosibirsk"},
    )
    assert not looks_like_new_order(
        "вес 200 кг",
        deal,
        {},
        {},
    )
    assert not looks_like_new_order(
        "мясорубки Redmond 100 штук, уточнение",
        deal,
        {"name": "мясорубки Redmond 100 шт"},
        {"origin_city": "Hangzhou", "destination_city": "Khimki"},
    )
    assert looks_like_new_order(
        "те же мясорубки но Гуанчжоу → Новосибирск",
        deal,
        {"name": "мясорубки Redmond"},
        {"origin_city": "Guangzhou", "destination_city": "Novosibirsk"},
    )


def test_login_urls_are_not_quote_apis():
    from agents.adapters import _is_quote_api_url

    assert _is_quote_api_url("https://my.fesco.com/auth") is False
    assert _is_quote_api_url("https://keycloak.trcont.ru") is False
    assert _is_quote_api_url("https://isales.trcont.ru") is False
    assert _is_quote_api_url("https://partner.example.com/api/v1/quote") is True


def test_mock_quote_is_not_real():
    from agents.rates import is_real_quote

    assert is_real_quote({"source": "api:demo_express", "partner": "demo_express", "price": 18000}) is False
    assert is_real_quote({"source": "email_imap", "partner": "fesco", "price": 189200}) is True
    assert is_real_quote({"source": "api:x:error", "price": 1, "error": "fail"}) is False


def test_heuristic_hangzhou_khimki():
    from agents.concierge import _heuristic_concierge

    data = _heuristic_concierge(
        {},
        "Добрый день. Прошу цену из Ханчжоу в Химки, мясорубки Redmond 100 штук",
    )
    route = data["route_updates"]
    assert route.get("origin_city") == "Hangzhou"
    assert route.get("destination_city") == "Khimki"
    assert route.get("corridor") == "cn_import"


def test_supplier_env_aliases_include_pek(monkeypatch):
    from common.queues import _partner_email_targets

    monkeypatch.setenv("SUPPLIER_QUOTE_EMAILS", "rates@supplier.example")
    monkeypatch.setenv("PARTNER_QUOTE_EMAILS", "")
    monkeypatch.setenv("PARTNER_EMAIL_PEK", "pek@example.com")
    monkeypatch.setenv("SUPPLIER_EMAIL_FESCO", "fesco@example.com")
    targets = [t.lower() for t in _partner_email_targets()]
    assert "rates@supplier.example" in targets
    assert "fesco@example.com" in targets
    assert "pek@example.com" in targets


def test_freight_and_sourcing_inboxes_are_split(monkeypatch):
    from common.queues import _freight_email_targets, _sourcing_email_targets

    monkeypatch.setenv("SUPPLIER_QUOTE_EMAILS", "rates@fesco.example")
    monkeypatch.setenv("PARTNER_QUOTE_EMAILS", "")
    monkeypatch.setenv("SOURCING_QUOTE_EMAILS", "buyout@cn.example")
    monkeypatch.setenv("SOURCING_EMAIL_CN", "factory@cn.example")
    freight = [t.lower() for t in _freight_email_targets()]
    sourcing = [t.lower() for t in _sourcing_email_targets()]
    assert "rates@fesco.example" in freight
    assert "buyout@cn.example" not in freight
    assert "buyout@cn.example" in sourcing
    assert "factory@cn.example" in sourcing
    assert "rates@fesco.example" not in sourcing


def test_client_weight_not_overridden_by_heuristic():
    from agents.cargo import estimate_cargo, has_client_chargeable_basis

    cargo = {"name": "коробки", "weight_kg": 2000, "quantity": 1}
    assert has_client_chargeable_basis(cargo) is True
    est = estimate_cargo({"cargo": cargo, "route": {"transport_mode": "ltl_groupage"}})
    assert est["source"] == "partial_client"
    assert est["weight_kg"] == 2000
    assert est["chargeable_weight_kg"] == 2000


def test_fcl_container_not_parcel_heuristic():
    from agents.cargo import estimate_cargo, has_client_chargeable_basis

    cargo = {
        "name": "40-футовый контейнер",
        "quantity": 1,
        "cargo_class": "container",
        "description": "40ft контейнер, получатель Прогресс-Строй",
    }
    route = {"transport_mode": "container", "corridor": "ru_domestic"}
    assert has_client_chargeable_basis(cargo) is True
    est = estimate_cargo({"cargo": cargo, "route": route})
    assert est["source"] == "container_fcl"
    assert est["weight_kg"] >= 10000
    assert est["volume_m3"] >= 30
    assert est["details"].get("fcl") is True


def test_file_tariff_is_not_real_quote_by_default(monkeypatch):
    from agents.rates import is_real_quote

    monkeypatch.setenv("ALLOW_FILE_TARIFFS", "false")
    assert is_real_quote({"source": "file:ru_ltl", "partner": "ru_ltl", "price": 50000}) is False
    assert is_real_quote({"source": "email_imap", "partner": "fesco", "price": 189200}) is True

    monkeypatch.setenv("ALLOW_FILE_TARIFFS", "true")
    assert is_real_quote({"source": "file:ru_ltl", "partner": "ru_ltl", "price": 50000}) is True


def test_pek_benchmark_lane_sla():
    from agents.pek_benchmark import format_pek_benchmark, lookup_lane

    lane = lookup_lane("Moscow", "Kazan", "ltl_groupage")
    assert lane is not None
    assert lane["typical_sla_days"] == [1, 3]
    text = " ".join(
        format_pek_benchmark(
            {"origin_city": "Moscow", "destination_city": "Kazan", "transport_mode": "ltl_groupage"}
        )
    )
    assert "конкурент" in text.lower()
    assert "1–3" in text or "1-3" in text
    assert "₽" not in text
    assert "не обещаем" in text.lower() or "как пэк" in text.lower()


def test_own_product_card_has_sla_not_price():
    from agents.pek_benchmark import format_own_product

    lines = format_own_product(
        {
            "corridor": "ru_domestic",
            "origin_city": "Moscow",
            "destination_city": "Kazan",
            "transport_mode": "ltl_groupage",
        }
    )
    blob = " ".join(lines)
    assert "Продукт" in blob
    assert "сборка" in blob.lower()
    assert "1–3" in blob or "1-3" in blob
    assert "₽" not in blob


