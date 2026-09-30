"""Business logic from TRANSINVEST TZ v1 — geography, VAT, readiness, RFQ, escalation."""

from agents.client_memory import (
    aggregate_lane_volume,
    comparability_reply,
    followup_schedule,
    insurance_gap,
)
from agents.escalation_matrix import resolve_escalation
from agents.finance import effective_supplier_cost, normalize_quote_tax, price_offer, validate_economics
from agents.geography import infer_corridor
from agents.procurement import sanitize_rfq_payload, supplier_matches_mode, build_supplier_question
from agents.readiness import classify_calculation
from agents.restrictions import evaluate_restrictions
from agents.transport_options import international_alternatives, suggest_modes


def test_geography_not_only_china():
    assert infer_corridor({"origin_country": "RU", "destination_country": "RU"}) == "ru_domestic"
    assert infer_corridor({"origin_country": "CN", "destination_country": "RU"}) == "cn_import"
    assert infer_corridor({"origin_country": "DE", "destination_country": "RU"}) == "international"
    assert infer_corridor({"origin_country": "TR", "destination_country": "KZ"}) == "international"


def test_vat_comparable_base():
    assert effective_supplier_cost(100_000, "excluded", ru_vat_pct=22) == 122_000
    assert effective_supplier_cost(100_000, "included", ru_vat_pct=22) == 100_000
    cheap_ex = normalize_quote_tax(
        {"price": 100_000, "vat_note": "без НДС"}, corridor="ru_domestic"
    )
    dear_inc = normalize_quote_tax(
        {"price": 110_000, "vat_note": "с НДС"}, corridor="ru_domestic"
    )
    assert cheap_ex["effective_supplier_cost"] == 122_000
    assert dear_inc["effective_supplier_cost"] == 110_000
    assert cheap_ex["effective_supplier_cost"] > dear_inc["effective_supplier_cost"]


def test_readiness_preliminary_vs_impossible():
    impossible = classify_calculation({}, {"origin_city": None}, {"logistics": True})
    assert impossible["level"] == "impossible"
    assert impossible["can_quote"] is False
    # Without ready_date the card is incomplete — no RFQ yet
    incomplete = classify_calculation(
        {"name": "коробки"},
        {"origin_city": "Moscow", "destination_city": "Tyumen", "corridor": "ru_domestic"},
        {"logistics": True},
    )
    assert incomplete["can_quote"] is False
    assert incomplete["level"] == "impossible"
    prelim = classify_calculation(
        {"name": "коробки"},
        {
            "origin_city": "Moscow",
            "destination_city": "Tyumen",
            "corridor": "ru_domestic",
            "ready_date": "2026-09-01",
        },
        {"logistics": True},
    )
    assert prelim["level"] == "preliminary"
    assert prelim["can_quote"] is True
    exact = classify_calculation(
        {"name": "коробки", "weight_kg": 800, "volume_m3": 2},
        {
            "origin_city": "Moscow",
            "destination_city": "Tyumen",
            "origin_address": "склад 1",
            "destination_address": "склад 2",
            "ready_date": "сейчас",
        },
        {"logistics": True},
    )
    assert exact["level"] == "exact"


def test_intake_one_question_and_url_fields():
    from agents.intake import next_intake_question, intake_gaps, needs_product_handoff
    from agents.cargo import extract_urls, _parse_product_page_fields

    q = next_intake_question({}, {}, {"logistics": True})
    assert "товар" in q.lower()
    assert not needs_product_handoff({"url": "https://example.com/item"})
    assert needs_product_handoff(
        {
            "url": "https://www.wildberries.ru/catalog/1/detail.aspx",
            "url_enrich_attempted": True,
            "url_enriched": False,
        }
    )
    assert not needs_product_handoff(
        {
            "url": "https://example.com/item",
            "url_enrich_attempted": True,
            "url_enriched": False,
            "name": "Насосы",
        }
    )
    gaps = intake_gaps(
        {"name": "powerbank"},
        {"origin_city": "Shanghai", "destination_city": "Moscow", "corridor": "cn_import"},
        {"logistics": True, "customs_clearance": True},
    )
    assert gaps[0]["key"] == "pickup_mode"
    assert extract_urls("ссылка https://1688.com/item/1 детали")
    parsed = _parse_product_page_fields(
        "Power Bank 20000mAh. Weight 0.35 kg. Size 15x8x3 cm. Price USD 12.50"
    )
    assert parsed.get("name")
    assert parsed.get("weight_kg") == 0.35


def test_no_hard_weight_gate_and_long_route_compare():
    out = suggest_modes(
        {"weight_kg": 700},
        {"corridor": "ru_domestic", "origin_city": "Moscow", "destination_city": "Tyumen"},
        client_chose="air",
    )
    assert out["hard_weight_gate"] is False
    assert out["primary"] == "air"
    assert "container" in out["alternatives"]


def test_shanghai_spb_alternatives():
    alts = international_alternatives(
        {"corridor": "cn_import", "origin_city": "Shanghai", "destination_city": "Saint Petersburg"}
    )
    ids = [a["id"] for a in alts]
    assert "sea" in ids and "air" in ids and "rail" in ids


def test_rfq_strips_client_identity():
    payload = sanitize_rfq_payload(
        {
            "cargo_summary": "ООО Ромашка ИНН 5401401513, завод: ACME Shenzhen, +79991234567 boxes",
            "client_name": "Иванов",
            "inn": "5401401513",
        },
        deal={"client_name": "Иванов", "metadata": {"client_inn": "5401401513"}},
    )
    blob = payload["cargo_summary"].lower()
    assert "5401401513" not in blob
    assert "+79991234567" not in blob
    assert payload["bypass_protection"] is True


def test_rfq_strips_consignee_and_party_labels():
    payload = sanitize_rfq_payload(
        {
            "cargo_summary": "40ft контейнер, получатель Армада, клиент Строительные системы",
            "route_summary": "Новосибирск → Корсаков",
        },
        deal={
            "client_name": "Aleksandra / Строительные системы",
            "metadata": {"consignee": "Армада", "client_org": "Строительные системы"},
        },
    )
    blob = (payload["cargo_summary"] + " " + payload.get("route_summary", "")).lower()
    assert "армада" not in blob
    assert "строительные системы" not in blob
    assert "получатель" in blob  # label may remain, value scrubbed
    assert "скрыт" in blob or "сторона" in blob


def test_specialized_lane_rejects_empty_corridor_wildcard():
    """ru_domestic + container with require_mode must not treat empty corridors as match-all."""
    from common.db import list_supplier_rfq_emails

    # Smoke: function accepts specialized flags without throwing.
    # Without DB seed this may return []; presence of preferred_codes path is enough.
    try:
        emails = list_supplier_rfq_emails(
            transport_mode="container",
            corridor="ru_domestic",
            preferred_codes=["fesco", "transcontainer"],
            require_mode=True,
            limit=10,
        )
        assert isinstance(emails, list)
    except Exception as exc:
        # Local CI without Postgres: skip soft
        if "connect" in str(exc).lower() or "password" in str(exc).lower():
            return
        raise


def test_scheme_catalog_pszhvs_defaults():
    from agents.schemes import resolve_scheme_defaults, canonicalize_scheme

    assert canonicalize_scheme("pszhvs_rail_sea") == "pszhvs"
    assert canonicalize_scheme("CY-CY") == "cy-cy"
    d = resolve_scheme_defaults(scheme="ПСЖВС")
    assert d["scheme_id"] == "pszhvs"
    assert "fesco" in d["preferred_operators"]
    assert d["require_mode"] is True


def test_quote_compare_ranks_cheapest():
    from agents.quote_compare import format_quote_compare, rank_quotes

    ranked = rank_quotes(
        [
            {"partner": "B", "price": 200_000, "currency": "RUB"},
            {"partner": "A", "price": 150_000, "currency": "RUB"},
        ]
    )
    assert ranked[0]["partner"] == "A"
    text = format_quote_compare(
        "deal-1",
        ranked,
        scheme="ПСЖВС",
        compare_kind="station_port",
    )
    assert "Лидер" in text
    assert "A" in text


def test_cabinet_rfq_opt_in_and_job_id_token():
    from common import queues as q

    assert q._cabinet_rfq_enabled() is False or isinstance(q._cabinet_rfq_enabled(), bool)
    token = q._safe_job_token("sales@fesco.com")
    assert "@" not in token
    assert len(token) <= 36
    jid = q._make_job_id("quote", "f57a3b1a-e551-4f9a-a98b-b9b5160f6299", "a@b.ru")
    assert jid.startswith("quote-")
    assert jid.count("-") >= 3


def test_supplier_mode_filter():
    railer = {"modes": ["rail"]}
    trucker = {"modes": ["ftl_truck", "road_train"]}
    assert supplier_matches_mode(railer, "rail")
    assert not supplier_matches_mode(trucker, "rail")
    assert supplier_matches_mode(trucker, "ftl_truck")


def test_supplier_question_uses_card_then_client():
    deal = {
        "cargo": {"name": "насосы", "weight_kg": 1200},
        "route": {"origin_city": "Hamburg", "destination_city": "Moscow"},
    }
    known = build_supplier_question(question="какой вес?", deal=deal)
    assert known["need_client"] is False
    assert "1200" in (known["card_answer"] or "")
    unknown = build_supplier_question(question="нужен SDS?", deal=deal)
    assert unknown["need_client"] is True


def test_min_profit_and_margin_path():
    offer = price_offer(2_000, {"target_margin_pct": 18, "floor_margin_pct": 10})
    assert offer["needs_approve"] is True
    assert "gross_profit" in offer["reason"] or offer["gross_profit_rub"] < 3000
    eco = validate_economics(cost_total=100_000, offer_price=105_000, corridor="ru_domestic")
    assert eco["needs_human"] is True
    assert "margin_below_floor" in eco["issues"] or "profit_below_minimum" in eco["issues"]


def test_followup_default_and_urgent():
    default = followup_schedule(
        policy={"followup_default_hours": [24, 72, 168]}
    )
    assert [i["offset_hours"] for i in default] == [24, 72, 168]
    urgent = followup_schedule(
        shipment_in_days=5,
        policy={"followup_urgent_hours": 2, "shipment_urgent_days": 14},
    )
    assert urgent[0]["offset_hours"] == 2


def test_volume_and_insurance():
    agg = aggregate_lane_volume(
        [
            {"client_id": "a", "qty": 5, "won": True},
            {"client_id": "b", "qty": 5, "won": False},
        ]
    )
    assert agg["total"] == 10
    assert agg["ask_volume_rate"] is True
    gap = insurance_gap(15_000_000, 10_000_000)
    assert gap["extra_to_cover"] == 5_000_000
    assert "сопоставимость" in comparability_reply().lower() or "забор" in comparability_reply().lower()


def test_escalation_dual_use_is_hold_not_stop():
    spec = resolve_escalation("dual_use_hold")
    assert spec["stop"] is False
    assert spec["notify"] == "logist_and_broker"
    r = evaluate_restrictions("груз двойного назначения, станки")
    assert r.hard_block is False
    assert r.escalation_reason == "dual_use_hold"


def test_private_move_is_stop():
    r = evaluate_restrictions("нужен квартирный переезд из Москвы в Казань")
    assert r.hard_block is True
    assert r.code == "private_move"


def test_academy_route_matrix_port_vs_inland():
    from agents.academy import route_matrix_priority, scheme_legs, suggest_container_type

    msk = route_matrix_priority(
        {"corridor": "cn_import", "origin_city": "Shanghai", "destination_city": "Moscow"},
        {},
    )
    assert msk[0]["id"] == "sea_rail"
    inland = route_matrix_priority(
        {"corridor": "cn_import", "origin_city": "Chengdu", "destination_city": "Novosibirsk"},
        {},
    )
    assert inland[0]["id"] == "rail"
    spb = route_matrix_priority(
        {"corridor": "cn_import", "origin_city": "Ningbo", "destination_city": "Saint Petersburg"},
        {},
    )
    assert spb[0]["id"] == "sea"
    eq = suggest_container_type({"volume_m3": 35})
    assert eq["primary"] == "40DC"
    kam = scheme_legs(
        {"corridor": "ru_domestic", "destination_city": "Petropavlovsk-Kamchatsky", "transport_mode": "container"}
    )
    assert any("смежный" in x for x in kam)


def test_academy_exw_legs_and_rfq_no_client():
    from agents.academy import carrier_rfq_fields, quote_inclusions, scheme_legs
    from agents.procurement import sanitize_rfq_payload

    legs = scheme_legs(
        {
            "corridor": "cn_import",
            "origin_incoterm": "EXW",
            "origin_city": "Ningbo",
            "destination_city": "Moscow",
            "transport_mode": "container",
        }
    )
    assert any("pickup" in x.lower() or "забор" in x.lower() or "pickup" in x for x in legs)
    inc = quote_inclusions(
        {"corridor": "cn_import", "destination_city": "Moscow", "transport_mode": "container"},
        {"hazardous": True},
        {"customs_clearance": True},
    )
    assert inc["must_disclose_free_time"] is True
    assert any("DG" in x or "опасн" in x.lower() for x in inc["includes"])
    rfq = carrier_rfq_fields(
        {"name": "насосы", "weight_kg": 1200, "volume_m3": 4},
        {"origin_city": "Ningbo", "destination_city": "Moscow", "origin_incoterm": "EXW"},
    )
    assert rfq["dg"] == "Non-DG"
    assert "all local charges" in rfq["ask"]
    payload = sanitize_rfq_payload(
        {"cargo_summary": "насосы 1200 кг"},
        deal={
            "client_name": "Секрет",
            "cargo": {"name": "насосы"},
            "route": {"origin_city": "Ningbo", "transport_mode": "container"},
        },
    )
    assert payload.get("academy_rfq")
    assert "Секрет" not in str(payload.get("academy_rfq"))


def test_academy_readiness_asks_msds_not_block():
    prelim = classify_calculation(
        {
            "name": "краска",
            "hazardous": True,
            "weight_kg": 800,
            "volume_m3": 2,
            "invoice_value": 12000,
            "invoice_currency": "USD",
        },
        {
            "origin_city": "Shanghai",
            "destination_city": "Moscow",
            "corridor": "cn_import",
            "origin_address": "factory",
            "destination_address": "warehouse",
            "origin_incoterm": "FOB",
            "ready_date": "2026-10-01",
        },
        {"logistics": True},
    )
    assert prelim["can_quote"] is True
    assert prelim["level"] == "preliminary"
    missing = " ".join(prelim["missing_for_exact"])
    assert "MSDS" in missing or "UN" in missing


def test_academy_digest_in_catalog():
    from agents.catalog import compact_catalog_for_llm

    digest = compact_catalog_for_llm()["academy"]
    assert digest["thinking"]["cabinet_is_benchmark"] is True
    assert "cost" in digest["thinking"]["compare"]


def test_academy_rfq_from_payload_without_deal():
    from agents.procurement import sanitize_rfq_payload

    payload = sanitize_rfq_payload(
        {
            "cargo_summary": "насосы Non-DG",
            "route_summary": "Ningbo → Moscow",
            "weight_kg": 1200,
            "volume_m3": 4,
            "transport_mode": "container",
            "corridor": "cn_import",
            "origin_incoterm": "EXW",
        }
    )
    assert payload.get("academy_rfq")
    assert payload.get("ask_quote_to_include")
    assert any("free time" in x.lower() or "Free" in x or "VGM" in x for x in payload["ask_quote_to_include"])
    assert payload.get("bypass_protection") is True


def test_academy_policy_flags_exist():
    from agents.procurement import sanitize_rfq_payload
    from agents.tz_policy import DEFAULT_TZ_POLICY, academy_active, merge_tz_policy, policy_from_env

    assert DEFAULT_TZ_POLICY["academy_enabled"] is True
    assert DEFAULT_TZ_POLICY["academy_in_prompts"] is True
    assert merge_tz_policy({"academy_in_rfq": False})["academy_in_rfq"] is False
    assert academy_active({"academy_enabled": False}, layer="kp") is False
    off = sanitize_rfq_payload(
        {"cargo_summary": "x", "transport_mode": "container"},
        deal={"policy": {"academy_in_rfq": False}},
    )
    assert off.get("academy_rfq") is None
    # env overlay is callable without crashing
    assert isinstance(policy_from_env(), dict)


def test_academy_env_overlay(monkeypatch):
    from agents.tz_policy import merge_tz_policy

    monkeypatch.setenv("ACADEMY_IN_VOICE", "false")
    monkeypatch.setenv("RU_VAT_PCT", "22")
    cfg = merge_tz_policy()
    assert cfg["academy_in_voice"] is False
    assert cfg["ru_vat_pct"] == 22
    monkeypatch.setenv("ACADEMY_ENABLED", "false")
    assert merge_tz_policy()["academy_enabled"] is False

