from __future__ import annotations

import json
import re
from typing import Any

from agents.catalog import (
    CARGO_CLASSES,
    CN_MODES,
    CN_SERVICE_IDS,
    CONCIERGE_STAGES,
    CORRIDORS,
    INCOTERMS_2020,
    INTL_MODES,
    RU_MODES,
    compact_catalog_for_llm,
    infer_corridor,
    normalize_deal_status,
)
from agents.geography import CN_IMPORT, DOMESTIC, INTERNATIONAL
from agents.lifecycle import CLIENT_INTENTS
from agents.readiness import classify_calculation, client_readiness_messages
from agents.intake import (
    AFTER_CARD_COMPLETE,
    PRODUCT_HANDOFF_REPLY,
    PRODUCT_URL_UNRESOLVED,
    needs_product_handoff,
    next_intake_question,
    wants_quote_first,
)
from agents.cargo import (
    enrich_from_product_url,
    extract_urls,
    merge_url_enrichment,
)
from agents.restrictions import (
    detect_competitor,
    detect_liquid_bulk,
    evaluate_restrictions,
)
from common import detect_grey_scheme, load_prompt, settings
from common.company import company_display_name, load_company
from common.llm import chat_parsed, gpt_client, model_for

_NULLABLE_STR = {"type": ["string", "null"]}
_NULLABLE_NUM = {"type": ["number", "null"]}
_NULLABLE_BOOL = {"type": ["boolean", "null"]}

CONCIERGE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "reply_messages": {"type": "array", "items": {"type": "string"}},
        "cargo_updates": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "name": _NULLABLE_STR,
                "quantity": _NULLABLE_NUM,
                "invoice_value": _NULLABLE_NUM,
                "invoice_currency": _NULLABLE_STR,
                "battery": _NULLABLE_BOOL,
                "category": _NULLABLE_STR,
                "cargo_class": {
                    "type": ["string", "null"],
                    "enum": [*CARGO_CLASSES, None],
                },
                "url": _NULLABLE_STR,
                "hazardous": _NULLABLE_BOOL,
                "is_liquid": _NULLABLE_BOOL,
                "weight_kg": _NULLABLE_NUM,
                "length_cm": _NULLABLE_NUM,
                "width_cm": _NULLABLE_NUM,
                "height_cm": _NULLABLE_NUM,
                "dg_class": _NULLABLE_STR,
                "dg_un_number": _NULLABLE_STR,
                "volume_m3": _NULLABLE_NUM,
                "dual_use": _NULLABLE_BOOL,
                "cargo_value": _NULLABLE_NUM,
            },
            "required": [
                "name",
                "quantity",
                "invoice_value",
                "invoice_currency",
                "battery",
                "category",
                "cargo_class",
                "url",
                "hazardous",
                "is_liquid",
                "weight_kg",
                "length_cm",
                "width_cm",
                "height_cm",
                "dg_class",
                "dg_un_number",
                "volume_m3",
                "dual_use",
                "cargo_value",
            ],
        },
        "route_updates": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "origin_city": _NULLABLE_STR,
                "origin_country": _NULLABLE_STR,
                "destination_city": _NULLABLE_STR,
                "destination_country": _NULLABLE_STR,
                "corridor": {"type": ["string", "null"], "enum": [*CORRIDORS, None]},
                "transport_mode": {
                    "type": ["string", "null"],
                    "enum": list(dict.fromkeys([*RU_MODES, *CN_MODES, *INTL_MODES, "night_express", None])),
                },
                "origin_incoterm": {
                    "type": ["string", "null"],
                    "enum": [*INCOTERMS_2020, None],
                },
                "dest_incoterm": {
                    "type": ["string", "null"],
                    "enum": [*INCOTERMS_2020, None],
                },
                "ready_date": _NULLABLE_STR,
            },
            "required": [
                "origin_city",
                "origin_country",
                "destination_city",
                "destination_country",
                "corridor",
                "transport_mode",
                "origin_incoterm",
                "dest_incoterm",
                "ready_date",
            ],
        },
        "services": {
            "type": ["array", "null"],
            "items": {"type": "string", "enum": list(CN_SERVICE_IDS)},
        },
        "needs_escalation": {"type": "boolean"},
        "escalation_reason": _NULLABLE_STR,
        "next_stage": {"type": "string", "enum": list(CONCIERGE_STAGES)},
        "confidence": {"type": "number"},
        "client_intent": {
            "type": ["string", "null"],
            "enum": [*CLIENT_INTENTS, None],
        },
        "new_order": {"type": "boolean"},
    },
    "required": [
        "reply_messages",
        "cargo_updates",
        "route_updates",
        "services",
        "needs_escalation",
        "escalation_reason",
        "next_stage",
        "confidence",
        "client_intent",
        "new_order",
    ],
}

_CN_CITIES = {
    "гуанчжоу": ("Guangzhou", "CN"),
    "guangzhou": ("Guangzhou", "CN"),
    "шанхай": ("Shanghai", "CN"),
    "shanghai": ("Shanghai", "CN"),
    "шэньчжэнь": ("Shenzhen", "CN"),
    "шенчжэнь": ("Shenzhen", "CN"),
    "shenzhen": ("Shenzhen", "CN"),
    "иу": ("Yiwu", "CN"),
    "yiwu": ("Yiwu", "CN"),
    "ханчжоу": ("Hangzhou", "CN"),
    "hangzhou": ("Hangzhou", "CN"),
    "хэфэй": ("Hefei", "CN"),
    "hefei": ("Hefei", "CN"),
    "пекин": ("Beijing", "CN"),
    "beijing": ("Beijing", "CN"),
    "нинбо": ("Ningbo", "CN"),
    "ningbo": ("Ningbo", "CN"),
}

_INTL_CITIES = {
    "гамбург": ("Hamburg", "DE"),
    "hamburg": ("Hamburg", "DE"),
    "берлин": ("Berlin", "DE"),
    "berlin": ("Berlin", "DE"),
    "роттердам": ("Rotterdam", "NL"),
    "rotterdam": ("Rotterdam", "NL"),
    "антверпен": ("Antwerp", "BE"),
    "antwerp": ("Antwerp", "BE"),
    "стамбул": ("Istanbul", "TR"),
    "istanbul": ("Istanbul", "TR"),
    "дубай": ("Dubai", "AE"),
    "dubai": ("Dubai", "AE"),
    "пусан": ("Busan", "KR"),
    "busan": ("Busan", "KR"),
    "сеул": ("Seoul", "KR"),
    "seoul": ("Seoul", "KR"),
    "алматы": ("Almaty", "KZ"),
    "almaty": ("Almaty", "KZ"),
    "минск": ("Minsk", "BY"),
    "minsk": ("Minsk", "BY"),
    "ташкент": ("Tashkent", "UZ"),
    "tashkent": ("Tashkent", "UZ"),
    "варшава": ("Warsaw", "PL"),
    "warsaw": ("Warsaw", "PL"),
    "баку": ("Baku", "AZ"),
    "ерев": ("Yerevan", "AM"),
    "тбилиси": ("Tbilisi", "GE"),
}

_RU_CITIES = {
    "москв": ("Moscow", "RU"),
    "мск": ("Moscow", "RU"),
    "moscow": ("Moscow", "RU"),
    "химк": ("Khimki", "RU"),
    "khimki": ("Khimki", "RU"),
    "новосибир": ("Novosibirsk", "RU"),
    "novosibirsk": ("Novosibirsk", "RU"),
    "петербург": ("Saint Petersburg", "RU"),
    "санкт-петербург": ("Saint Petersburg", "RU"),
    "спб": ("Saint Petersburg", "RU"),
    "екатеринбург": ("Yekaterinburg", "RU"),
    "казан": ("Kazan", "RU"),
    "красноярск": ("Krasnoyarsk", "RU"),
    "владивосток": ("Vladivostok", "RU"),
    "иркутск": ("Irkutsk", "RU"),
    "омск": ("Omsk", "RU"),
    "томск": ("Tomsk", "RU"),
    "челябинск": ("Chelyabinsk", "RU"),
    "краснодар": ("Krasnodar", "RU"),
    "ростов": ("Rostov-on-Don", "RU"),
    "самар": ("Samara", "RU"),
    "тюмен": ("Tyumen", "RU"),
    "хабаровск": ("Khabarovsk", "RU"),
    "барнаул": ("Barnaul", "RU"),
    "пермь": ("Perm", "RU"),
    "уфа": ("Ufa", "RU"),
}

_MODE_HINTS: list[tuple[str, str]] = [
    (r"автопоезд|сцепк", "road_train"),
    (r"контейнер|20\s*фт|40\s*фт|\bteu\b", "container"),
    (r"\bжд\b|железн|вагон", "rail"),
    (r"авиа|\bair\b|самол[её]т", "air"),
    (r"фур[аы]|ftl|еврофур", "ftl_truck"),
    (r"ночн\w*\s+экспресс|ночной экспресс", "night_express"),
    (r"море|sea\s*freight|\bfeu\b", "sea"),
    (r"сборк|сборн|ltl|groupage", "ltl_groupage"),
]


def _drop_nones(d: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in d.items() if v is not None}


def run_concierge(
    deal: dict[str, Any],
    user_text: str,
    history: list[dict[str, Any]] | None = None,
    client_memory: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if detect_grey_scheme(user_text):
        return {
            "reply_messages": [
                "Такие схемы мы не сопровождаем — работаем только в легальном поле с полной декларацией.",
                "Могу посчитать белую доставку. Пришлите описание груза, маршрут, вес/объём; для импорта из Китая — инвойс.",
            ],
            "cargo_updates": {},
            "route_updates": {},
            "needs_escalation": True,
            "escalation_reason": "grey_scheme_request",
            "next_stage": "awaiting_manager",
            "confidence": 1.0,
            "hard_block": True,
        }

    early = evaluate_restrictions(
        user_text, deal.get("cargo") or {}, deal.get("route") or {}
    )
    if early.hard_block:
        return {
            "reply_messages": early.reply_messages,
            "cargo_updates": early.cargo_updates,
            "route_updates": {},
            "needs_escalation": early.escalate,
            "escalation_reason": early.escalation_reason,
            "next_stage": "intake" if not early.escalate else "awaiting_manager",
            "confidence": 1.0,
            "hard_block": True,
        }

    company = load_company()
    academy = ""
    try:
        from agents.tz_policy import academy_active

        if academy_active(layer="prompts"):
            academy = "\n\n" + load_prompt("gpt", "academy.md")
    except Exception:
        try:
            academy = "\n\n" + load_prompt("gpt", "academy.md")
        except Exception:
            academy = ""

    style_extra = ""
    try:
        from common import load_style_prompt

        style_extra = "\n\n" + load_style_prompt(
            "style_client.md", max_chars=6000, prefer_examples=False
        )
    except Exception:
        style_extra = ""

    orch_extra = ""
    try:
        orch_extra = "\n\n" + load_prompt("gpt", "orchestrator.md")
    except Exception:
        orch_extra = ""

    system = (
        load_prompt("gpt", "concierge.md")
        + academy
        + style_extra
        + orch_extra
        + f"\n\nКомпания: {company.legal_name} ({company_display_name(company)})."
        + " Не выдумывай другие названия юрлица."
    )
    user = json.dumps(
        {
            "company": {
                "legal_name": company.legal_name,
                "short_name": company.short_name,
                "inn": company.inn,
                "ogrn": company.ogrn,
            },
            "catalog": compact_catalog_for_llm(),
            "deal": {
                "id": str(deal.get("id")),
                "status": deal.get("status"),
                "cargo": deal.get("cargo"),
                "route": deal.get("route"),
                "services": (deal.get("metadata") or {}).get("services"),
                "staff_ops_hint": (deal.get("metadata") or {}).get("staff_ops_hint"),
                "ask_client": (deal.get("metadata") or {}).get("ask_client"),
                "client_do_not_say": (deal.get("metadata") or {}).get("client_do_not_say"),
                "preferred_operators": (deal.get("metadata") or {}).get(
                    "preferred_operators"
                ),
            },
            "client_memory": client_memory,
            "recent_dialog": _format_history(history),
            "message": user_text,
            "need_invoice_for_vat_duty": True,
            "allowed_next_stage": list(CONCIERGE_STAGES),
            "staff_instructions": _staff_instructions_for_deal(deal),
        },
        ensure_ascii=False,
    )

    if not settings.openai_api_key:
        return _finalize_concierge(_heuristic_concierge(deal, user_text), deal, user_text)

    last_err: Exception | None = None
    for _ in range(2):
        try:
            data = chat_parsed(
                gpt_client(),
                model_for("main"),
                system,
                user,
                CONCIERGE_SCHEMA,
                schema_name="concierge_turn",
                temperature=0.7,
                trace_name="concierge",
            )
            return _finalize_concierge(data, deal, user_text)
        except Exception as exc:
            last_err = exc
            continue
    try:
        from common.logutil import log as file_log

        file_log("orchestrator", "warn", "concierge_llm_fallback", error=str(last_err or "")[:400])
    except Exception:
        pass
    return _finalize_concierge(_heuristic_concierge(deal, user_text), deal, user_text)


def _format_history(history: list[dict[str, Any]] | None) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for row in history or []:
        text = str(row.get("text") or "").strip()
        if not text:
            continue
        role = "client" if row.get("direction") == "inbound" else "manager"
        out.append({"role": role, "text": text[:800]})
    return out[-12:]


# Global staff-room coaching without deal uuid (filter out chit-chat / legacy).
_STAFF_COACH_RE = re.compile(
    r"спроси|не\s*пиши|не\s*говори|запомни|учти|всегда|сначала|предпочит|"
    r"никогда|оператор|схем[ауые]|инкотерм|инвойс|вес|габарит|клиенту\s*не|"
    r"не\s*называй|не\s*раскрывай|веди\s*так|делай\s*так|лучше|не\s*надо|"
    r"rfq|\bкп\b|по\s*сделк|cy[\s.-]?cy|псжвс|фитинг|контейнер|маршрут|ставк|марж",
    re.I,
)


def _payload_dict(payload: Any) -> dict[str, Any]:
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except Exception:
            return {"text": payload.strip()}
    if isinstance(payload, dict):
        return payload
    return {}


def _payload_text(payload: Any) -> str:
    return str(_payload_dict(payload).get("text") or "").strip()


def _is_coach_payload(payload: Any, *, require_regex_if_legacy: bool) -> bool:
    data = _payload_dict(payload)
    kind = str(data.get("kind") or "").lower().strip()
    text = str(data.get("text") or "").strip()
    if kind == "chat":
        return False
    if kind == "coach":
        return bool(text)
    # Legacy rows without kind
    if not require_regex_if_legacy:
        return bool(text)
    return bool(text and _STAFF_COACH_RE.search(text))


def _staff_training_rows(deal_id: str | None, ttl_days: int = 30) -> list[tuple[str, str]]:
    """Return (scope, text) from staff_room_training: deal-scoped + global coaching."""
    from common.db import db

    out: list[tuple[str, str]] = []
    seen: set[str] = set()
    ttl = max(1, int(ttl_days or 30))

    def _add(scope: str, text: str) -> None:
        t = text.strip()
        if not t or len(t) < 8:
            return
        key = re.sub(r"\s+", " ", t.lower())[:240]
        if key in seen:
            return
        seen.add(key)
        out.append((scope, t[:600]))

    with db() as conn:
        if deal_id:
            rows = conn.execute(
                """
                SELECT payload FROM learning_events
                WHERE event_type = 'staff_room_training'
                  AND deal_id = %s
                ORDER BY created_at DESC
                LIMIT 12
                """,
                (str(deal_id),),
            ).fetchall()
            for r in rows or []:
                payload = r["payload"] if isinstance(r, dict) else None
                if _is_coach_payload(payload, require_regex_if_legacy=False):
                    _add("deal", _payload_text(payload))

        # Global coaching: kind=coach (or legacy regex), TTL unless pinned.
        rows = conn.execute(
            """
            SELECT payload FROM learning_events
            WHERE event_type = 'staff_room_training'
              AND deal_id IS NULL
              AND (
                COALESCE(payload->>'pinned', 'false') IN ('true', '1')
                OR created_at > NOW() - make_interval(days => %s)
              )
            ORDER BY
              CASE WHEN COALESCE(payload->>'pinned', 'false') IN ('true', '1') THEN 0 ELSE 1 END,
              created_at DESC
            LIMIT 30
            """,
            (ttl,),
        ).fetchall()
        for r in rows or []:
            payload = r["payload"] if isinstance(r, dict) else None
            if _is_coach_payload(payload, require_regex_if_legacy=True):
                _add("global", _payload_text(payload))
            if sum(1 for s, _ in out if s == "global") >= 5:
                break

    return out


def _policy_coaching_bits() -> list[str]:
    """Stable coaching from policy_config + active/canary playbook."""
    bits: list[str] = []
    try:
        from common.db import get_policy
        from learning.loop import merge_playbook_into_policy, select_playbook

        base = get_policy() or {}
        policy = merge_playbook_into_policy(base, select_playbook(base))
    except Exception:
        try:
            from common.db import get_policy

            policy = get_policy() or {}
        except Exception:
            return bits
    tone = policy.get("comm_tone") or policy.get("tone")
    if tone:
        bits.append(f"Тон общения (playbook/policy): {tone}")
    ask = policy.get("always_ask_client")
    if isinstance(ask, list) and ask:
        bits.append("Политика: всегда уточняй у клиента — " + ", ".join(str(x) for x in ask))
    elif isinstance(ask, str) and ask.strip():
        bits.append(f"Политика: всегда уточняй у клиента — {ask.strip()}")
    dont = policy.get("client_do_not_say")
    if isinstance(dont, list) and dont:
        bits.append("Политика: клиенту не говорить — " + "; ".join(str(x) for x in dont))
    elif isinstance(dont, str) and dont.strip():
        bits.append(f"Политика: клиенту не говорить — {dont.strip()}")
    rules = policy.get("staff_coaching_rules")
    if isinstance(rules, list):
        for rule in rules[:6]:
            if rule:
                bits.append(f"Правило компании: {str(rule)[:400]}")
    elif isinstance(rules, str) and rules.strip():
        bits.append(f"Правило компании: {rules.strip()[:400]}")
    return bits


def _staff_instructions_for_deal(deal: dict[str, Any]) -> list[str]:
    """Surface policy + staff-room coaching so concierge follows instructions."""
    meta = deal.get("metadata") or {}
    bits: list[str] = []
    bits.extend(_policy_coaching_bits())

    hint = meta.get("staff_ops_hint")
    if hint:
        bits.append(f"Подсказка менеджера: {str(hint)[:1500]}")
    ask = meta.get("ask_client")
    if isinstance(ask, list) and ask:
        bits.append("Обязательно уточни у клиента: " + ", ".join(str(x) for x in ask))
    dont = meta.get("client_do_not_say")
    if dont:
        bits.append(f"Клиенту не говорить: {str(dont)[:500]}")
    ops = meta.get("preferred_operators")
    if isinstance(ops, list) and ops:
        bits.append("Предпочтительные операторы RFQ: " + ", ".join(str(x) for x in ops))

    ttl_days = 30
    try:
        from common.db import get_policy

        ttl_days = int((get_policy() or {}).get("staff_coach_ttl_days") or 30)
    except Exception:
        ttl_days = 30

    try:
        for scope, text in _staff_training_rows(deal.get("id"), ttl_days=ttl_days):
            label = (
                "Обучение по этой сделке"
                if scope == "deal"
                else "Общее обучение из рабочей группы"
            )
            bits.append(f"{label}: {text}")
    except Exception:
        pass
    return bits[:14]


def _finalize_concierge(
    data: dict[str, Any], deal: dict[str, Any], user_text: str
) -> dict[str, Any]:
    cargo_upd = _drop_nones(dict(data.get("cargo_updates") or {}))
    route_upd = _drop_nones(dict(data.get("route_updates") or {}))
    extracted = _extract_invoice(user_text)
    cargo_upd.update({k: v for k, v in extracted.items() if v is not None})
    cargo_upd.update({k: v for k, v in _extract_document_flags(user_text).items() if v is not None})
    qty = _extract_qty(user_text)
    if qty and qty < 1_000_000:
        cargo_upd.setdefault("quantity", qty)
    wkg = _extract_weight_kg(user_text)
    if wkg:
        cargo_upd.setdefault("weight_kg", wkg)
    vol = _extract_volume_m3(user_text)
    if vol:
        cargo_upd.setdefault("volume_m3", vol)

    urls = extract_urls(user_text)
    if urls and not cargo_upd.get("url"):
        cargo_upd["url"] = urls[0]

    hinted: dict[str, Any] = {}
    _apply_city_hints(hinted, user_text.lower())
    mode = _infer_mode(user_text.lower())
    if mode:
        hinted.setdefault("transport_mode", mode)
    pickup = _extract_pickup_mode(user_text)
    if pickup:
        hinted.setdefault("origin_incoterm", pickup["origin_incoterm"])
        hinted.setdefault("pickup_mode", pickup["pickup_mode"])
        if pickup.get("dest_incoterm"):
            hinted.setdefault("dest_incoterm", pickup["dest_incoterm"])
    ready = _extract_ready_date(user_text)
    if ready:
        hinted.setdefault("ready_date", ready)
    for k, v in hinted.items():
        route_upd.setdefault(k, v)

    oc = (route_upd.get("origin_country") or "").upper()
    dc = (route_upd.get("destination_country") or "").upper()
    if "из китая" in user_text.lower() or "из кнр" in user_text.lower():
        route_upd.setdefault("origin_country", "CN")
        route_upd.setdefault("corridor", CN_IMPORT)
    merged_cargo = {**(deal.get("cargo") or {}), **cargo_upd}
    merged_route = {**(deal.get("route") or {}), **route_upd}
    inferred = infer_corridor(merged_route) or infer_corridor(route_upd)
    if inferred:
        route_upd.setdefault("corridor", inferred)
        merged_route.setdefault("corridor", inferred)
    elif oc == "RU" and dc == "RU":
        route_upd.setdefault("corridor", DOMESTIC)
        merged_route.setdefault("corridor", DOMESTIC)

    url = str(merged_cargo.get("url") or "").strip()
    if url.startswith("http") and not merged_cargo.get("url_enrich_attempted"):
        enrichment = enrich_from_product_url(url)
        for k, v in enrichment.items():
            if k in ("url", "url_enrich_attempted", "url_enriched", "url_enrich_error"):
                cargo_upd[k] = v
            elif v not in (None, "") and cargo_upd.get(k) in (None, "", 0, 0.0):
                if k in (
                    "name",
                    "description",
                    "spec_description",
                    "quantity",
                    "weight_kg",
                    "length_cm",
                    "width_cm",
                    "height_cm",
                    "volume_m3",
                    "invoice_value",
                    "invoice_currency",
                    "category",
                    "has_spec",
                ):
                    cargo_upd[k] = v
        merged_cargo = {**(deal.get("cargo") or {}), **cargo_upd}

    services = data.get("services")
    svc_flags: dict[str, Any] = {}
    if isinstance(services, list):
        for s in services:
            svc_flags[str(s)] = True
    elif isinstance(services, dict):
        svc_flags = dict(services)
    else:
        svc_flags = dict((deal.get("metadata") or {}).get("services") or {}) or {"logistics": True}
    if not svc_flags:
        svc_flags = {"logistics": True}
    ops_only = (not svc_flags.get("logistics", True)) and (
        svc_flags.get("buyout") or svc_flags.get("supplier_sourcing")
    )

    data["cargo_updates"] = cargo_upd
    data["route_updates"] = route_upd
    if "services" not in data:
        data["services"] = None
    data.setdefault("client_intent", None)
    data.setdefault("new_order", False)
    data["next_stage"] = normalize_deal_status(
        data.get("next_stage"), deal.get("status") or "intake"
    )

    replies = [str(x).strip() for x in (data.get("reply_messages") or []) if str(x).strip()]
    if data.get("hard_block"):
        data["reply_messages"] = replies or [
            "На связи. Напишите, что везём и откуда/куда — продолжу с этого."
        ]
        return data

    if needs_product_handoff(merged_cargo):
        ack = ""
        for r in replies:
            low = r.lower()
            if any(x in low for x in ("зафиксир", "понял", "принял", "ссылк", "учёл", "учел")):
                ack = r
                break
        handoff = PRODUCT_HANDOFF_REPLY
        data["reply_messages"] = ([ack, handoff] if ack and ack != handoff else [handoff])
        data["needs_escalation"] = True
        data["escalation_reason"] = PRODUCT_URL_UNRESOLVED
        data["next_stage"] = "awaiting_manager"
        return data

    q = next_intake_question(
        merged_cargo,
        merged_route,
        svc_flags,
        ops_only=ops_only,
        quote_first=wants_quote_first(user_text),
    )
    if q:
        ack = ""
        for r in replies:
            low = r.lower()
            if any(x in low for x in ("зафиксир", "понял", "принял", "спасибо", "учёл", "учел")):
                ack = r
                break
        data["reply_messages"] = ([ack, q] if ack and ack != q else [q])
        data["next_stage"] = "intake"
    else:
        if not any("запрашиваю ставк" in r.lower() or "сравню" in r.lower() for r in replies):
            replies = (replies[:2] if replies else []) + [AFTER_CARD_COMPLETE]
        data["reply_messages"] = replies or [AFTER_CARD_COMPLETE]
        if data.get("next_stage") in ("intake", None, ""):
            data["next_stage"] = "sizing"
    return data



def _extract_document_flags(text: str) -> dict[str, Any]:
    out: dict[str, Any] = {}
    low = text.lower()
    looks_file = (
        "клиент прислал" in low
        or "содержимое:" in low
        or "расшифровка речи" in low
        or "подпись:" in low
    )
    if looks_file:
        out["from_document"] = True
    if re.search(r"инвойс|invoice|packing\s*list|упаковочн|спецификац", low):
        if looks_file or "пришли" in low or "во вложении" in low or "файл" in low:
            out["invoice_doc"] = True
            out["has_spec"] = True
            out["from_document"] = True
    if re.search(r"спецификац|описание товара|product\s*description", low) and looks_file:
        out["has_spec"] = True
        out["from_document"] = True
        if "содержимое:" in low:
            idx = low.find("содержимое:")
            chunk = text[idx : idx + 1200]
            if len(chunk.strip()) >= 12:
                out["description"] = chunk.strip()[:1500]
                out["spec_description"] = chunk.strip()[:1500]
    return out


def _extract_pickup_mode(text: str) -> dict[str, Any] | None:
    low = text.lower()
    factory = bool(
        re.search(
            r"с\s*фабрик|с\s*завод|забер[еёи]\w*|exw|эксв|самовывоз\s*с\s*фабрик|pickup\s*from\s*factory",
            low,
        )
    )
    port = bool(
        re.search(
            r"до\s*порта|до\s*терминал|fob|fca|довозит\w*\s+до|поставщик\s+довез|на\s+порт|на\s+терминал",
            low,
        )
    )
    if factory and not port:
        return {"origin_incoterm": "EXW", "pickup_mode": "factory", "dest_incoterm": "DAP"}
    if port and not factory:
        return {"origin_incoterm": "FOB", "pickup_mode": "port", "dest_incoterm": "DAP"}
    if factory and port:
        if "exw" in low or "эксв" in low:
            return {"origin_incoterm": "EXW", "pickup_mode": "factory", "dest_incoterm": "DAP"}
        if "fob" in low or "fca" in low:
            return {"origin_incoterm": "FOB", "pickup_mode": "port", "dest_incoterm": "DAP"}
    return None


def _extract_ready_date(text: str) -> str | None:
    low = text.lower()
    m = re.search(
        r"(?:готов(?:о|а|ы)?\s*(?:к\s*отгрузк\w*)?|ready(?:\s*date)?|отгрузк\w*)"
        r"[^\d]{0,20}"
        r"(\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?|\d{4}-\d{2}-\d{2})",
        low,
    )
    if m:
        return m.group(1)
    m = re.search(r"(\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?|\d{4}-\d{2}-\d{2})", text)
    if m and re.search(r"готов|отгруз|ready|через", low):
        return m.group(1)
    m = re.search(r"через\s*(\d{1,3})\s*(дн|день|дня|days?)", low)
    if m:
        return f"через {m.group(1)} дн."
    if re.search(r"готов\s*сейчас|уже\s*готов|ready\s*now", low):
        return "сейчас"
    if re.search(r"на\s*следующ\w*\s*недел", low):
        return "на следующей неделе"
    return None



def _extract_invoice(text: str) -> dict[str, Any]:
    out: dict[str, Any] = {}
    low = text.lower()
    m = re.search(
        r"(?:инвойс|invoice|стоимость|сумма|value)[^\d]{0,20}(\d[\d\s]{1,12}(?:[.,]\d{1,2})?)\s*(usd|\$|eur|€|cny|rmb|yuan|cny¥|¥|rub|₽|руб)?",
        low,
        re.I,
    )
    if m:
        raw = m.group(1).replace(" ", "").replace(",", ".")
        try:
            out["invoice_value"] = float(raw)
        except ValueError:
            return out
        cur = (m.group(2) or "usd").lower()
        if cur in ("$", "usd"):
            out["invoice_currency"] = "USD"
        elif cur in ("€", "eur"):
            out["invoice_currency"] = "EUR"
        elif cur in ("¥", "cny", "rmb", "yuan", "cny¥"):
            out["invoice_currency"] = "CNY"
        elif cur in ("₽", "rub", "руб"):
            out["invoice_currency"] = "RUB"
        else:
            out["invoice_currency"] = "USD"
    if "powerbank" in low or "пауэр" in low or "повербанк" in low:
        out["battery"] = True
        out["category"] = "powerbank"
    return out


def _extract_qty(text: str) -> int | None:
    m = re.search(r"(\d[\d\s]{0,6})\s*(шт|pcs|pieces|единиц)\b", text.lower())
    if not m:
        return None
    try:
        return int(m.group(1).replace(" ", ""))
    except ValueError:
        return None


def _extract_weight_kg(text: str) -> float | None:
    low = text.lower().replace(",", ".")
    m = re.search(r"(\d+(?:\.\d+)?)\s*(т|тонн(?:ы|а|у)?|ton(?:nes?)?)\b", low)
    if m:
        try:
            return float(m.group(1)) * 1000.0
        except ValueError:
            return None
    m = re.search(r"(\d+(?:\.\d+)?)\s*(кг|kg)\b", low)
    if m:
        try:
            return float(m.group(1))
        except ValueError:
            return None
    return None


def _extract_volume_m3(text: str) -> float | None:
    low = text.lower().replace(",", ".")
    m = re.search(r"(\d+(?:\.\d+)?)\s*(м3|м³|m3|куб)\b", low)
    if not m:
        return None
    try:
        return float(m.group(1))
    except ValueError:
        return None


def _apply_city_hints(route: dict[str, Any], low: str) -> None:
    stripped = low.strip()
    cities = {**_CN_CITIES, **_RU_CITIES, **_INTL_CITIES}
    if stripped in cities:
        city, country = cities[stripped]
        if not route.get("destination_city"):
            route["destination_city"] = city
            route["destination_country"] = country
        elif not route.get("origin_city"):
            route["origin_city"] = city
            route["origin_country"] = country
        return
    for needle, (city, country) in cities.items():
        if f"из {needle}" in low or f"from {needle}" in low:
            route["origin_city"] = city
            route["origin_country"] = country
        if f"в {needle}" in low or f"to {needle}" in low:
            route["destination_city"] = city
            route["destination_country"] = country
    for needle, (city, country) in cities.items():
        if needle not in low:
            continue
        if not route.get("origin_city"):
            route["origin_city"] = city
            route["origin_country"] = country
        elif city != route.get("origin_city") and not route.get("destination_city"):
            route["destination_city"] = city
            route["destination_country"] = country


def _infer_mode(low: str) -> str | None:
    for pat, mode in _MODE_HINTS:
        if re.search(pat, low):
            return mode
    return None


def _infer_cargo_class(low: str) -> str | None:
    if re.search(r"опасн|adr\b|hazard", low):
        return "dangerous"
    if re.search(r"негабарит|oversized", low):
        return "oversized"
    if re.search(r"габарит", low):
        return "dimensional"
    if re.search(r"тарн|штучн", low):
        return "tare_piece"
    return None


def _heuristic_concierge(deal: dict[str, Any], text: str) -> dict[str, Any]:
    cargo = dict(deal.get("cargo") or {})
    route = dict(deal.get("route") or {})
    low = text.lower()

    if detect_liquid_bulk(text, cargo):
        return {
            "reply_messages": [
                "Наливные грузы не возим — цистерны и liquid bulk вне наших услуг.",
                "Можем взять тарно-штучный, габаритный, негабаритный или опасный (не налив).",
            ],
            "cargo_updates": {**cargo, "is_liquid": True},
            "route_updates": route,
            "needs_escalation": True,
            "escalation_reason": "forbidden_cargo_liquid",
            "next_stage": "awaiting_manager",
            "confidence": 1.0,
            "hard_block": True,
        }

    competitor_notes: list[str] = []
    competitor = detect_competitor(text)

    restriction = evaluate_restrictions(text, cargo, route)
    if restriction.hard_block:
        return {
            "reply_messages": restriction.reply_messages,
            "cargo_updates": {**cargo, **restriction.cargo_updates},
            "route_updates": route,
            "needs_escalation": restriction.escalate,
            "escalation_reason": restriction.escalation_reason,
            "next_stage": "awaiting_manager" if restriction.escalate else "intake",
            "confidence": 1.0,
            "hard_block": True,
        }
    if restriction.reply_messages and restriction.code and restriction.code.startswith(
        ("groupage_supplier", "courier_hint", "competitor")
    ):
        competitor_notes = list(restriction.reply_messages)

    _apply_city_hints(route, low)
    if "из китая" in low or "из кнр" in low:
        route.setdefault("origin_country", "CN")
    inferred = infer_corridor(route)
    if inferred:
        route["corridor"] = inferred
    elif (route.get("origin_country") or "").upper() == "RU" and not route.get("destination_country"):
        if "кита" not in low:
            route["corridor"] = DOMESTIC

    mode = _infer_mode(low)
    if mode:
        route["transport_mode"] = mode

    if competitor:
        from agents.pek_benchmark import format_pek_benchmark

        competitor_notes = format_pek_benchmark(route, mentioned=True)

    cls = _infer_cargo_class(low)
    if cls:
        cargo["cargo_class"] = cls
        if cls == "dangerous":
            cargo["hazardous"] = True

    services: list[str] | None = None
    if route.get("corridor") in (CN_IMPORT, INTERNATIONAL):
        picked: list[str] = []
        if re.search(r"выкуп", low):
            picked.append("buyout")
        if re.search(r"подбор\s+поставщик", low):
            picked.append("supplier_sourcing")
        if re.search(r"раст[ао]мож|таможн", low):
            picked.append("customs_clearance")
        if re.search(r"сертифик", low):
            picked.append("certification")
        if re.search(r"страхов", low):
            picked.append("insurance")
        if re.search(r"ночн\w*\s+экспресс", low):
            picked.append("night_express")
        if re.search(r"достав|логист|привез|перевез", low) or not picked:
            picked.insert(0, "logistics")
            if "customs_clearance" not in picked and re.search(r"достав|привез", low):
                picked.append("customs_clearance")
        services = picked
    elif re.search(r"ночн\w*\s+экспресс", low):
        services = ["logistics", "night_express"]

    inv = _extract_invoice(text)
    cargo.update({k: v for k, v in inv.items() if v is not None})
    qty = _extract_qty(text)
    if qty and qty < 1_000_000:
        cargo["quantity"] = qty
    wkg = _extract_weight_kg(text)
    if wkg:
        cargo["weight_kg"] = wkg
    vol = _extract_volume_m3(text)
    if vol:
        cargo["volume_m3"] = vol

    if not cargo.get("name"):
        spoken = "расшифровка речи" in low or "голосовое" in low
        greet = bool(re.match(r"^(привет|здравств|добрый|хай|hello|hi|ку)\b", low)) and len(
            text.strip()
        ) < 40
        looks_cargo = bool(
            re.search(r"груз|вез|достав|перевез|кг|шт|сборк|фура|контейнер|инвойс", low)
        )
        if not greet and (looks_cargo or spoken or (20 < len(text) < 160)):
            cargo["name"] = text[:200]

    pickup = _extract_pickup_mode(text)
    if pickup:
        route.setdefault("origin_incoterm", pickup["origin_incoterm"])
        route.setdefault("pickup_mode", pickup["pickup_mode"])
        if pickup.get("dest_incoterm"):
            route.setdefault("dest_incoterm", pickup["dest_incoterm"])
    if route.get("corridor") in (CN_IMPORT, INTERNATIONAL):
        if "fob" in low:
            route["origin_incoterm"] = route.get("origin_incoterm") or "FOB"
        if "exw" in low or "эксв" in low:
            route["origin_incoterm"] = route.get("origin_incoterm") or "EXW"
        if "dap" in low:
            route["dest_incoterm"] = route.get("dest_incoterm") or "DAP"
        if "ddp" in low:
            route["dest_incoterm"] = route.get("dest_incoterm") or "DDP"
        if re.search(r"\bcif\b", low):
            route["dest_incoterm"] = route.get("dest_incoterm") or "CIF"
        if route.get("origin_incoterm") and route.get("dest_incoterm"):
            from agents.catalog import format_incoterms_pair

            route["incoterms"] = format_incoterms_pair(
                route["origin_incoterm"], route["dest_incoterm"]
            )

    ready_date = _extract_ready_date(text)
    if ready_date:
        route["ready_date"] = ready_date

    urls = extract_urls(text)
    if urls:
        cargo.setdefault("url", urls[0])
    cargo.update({k: v for k, v in _extract_document_flags(text).items() if v is not None})
    if cargo.get("url") and not cargo.get("url_enrich_attempted"):
        cargo = merge_url_enrichment(cargo, enrich_from_product_url(str(cargo["url"])))

    svc_flags = {"logistics": True}
    if services:
        svc_flags = {s: True for s in services}
        if "logistics" not in svc_flags and not (
            svc_flags.get("buyout") or svc_flags.get("supplier_sourcing")
        ):
            svc_flags["logistics"] = True

    ready = classify_calculation(
        cargo, route, svc_flags, quote_first=wants_quote_first(text)
    )
    if needs_product_handoff(cargo):
        return {
            "reply_messages": competitor_notes + [PRODUCT_HANDOFF_REPLY],
            "cargo_updates": cargo,
            "route_updates": route,
            "services": services,
            "needs_escalation": True,
            "escalation_reason": PRODUCT_URL_UNRESOLVED,
            "next_stage": "awaiting_manager",
            "confidence": 0.6,
            "hard_block": False,
        }
    q = next_intake_question(
        cargo, route, svc_flags, quote_first=wants_quote_first(text)
    )
    if q:
        return {
            "reply_messages": competitor_notes + [q],
            "cargo_updates": cargo,
            "route_updates": route,
            "services": services,
            "needs_escalation": False,
            "escalation_reason": None,
            "next_stage": "intake",
            "confidence": 0.55,
            "hard_block": False,
        }

    from agents.pek_benchmark import format_own_product
    from agents.transport_options import container_loading_messages, international_alternatives

    geo = "по России" if route.get("corridor") == DOMESTIC else "международка"
    replies = competitor_notes + [
        f"Зафиксировал ({geo}): {cargo.get('name')} · {route.get('origin_city')} → {route.get('destination_city')}.",
        *format_own_product(route),
        *client_readiness_messages(ready),
        AFTER_CARD_COMPLETE,
    ]
    if route.get("transport_mode") == "container":
        replies.extend(container_loading_messages())
    alts = international_alternatives(route)
    if alts and not route.get("transport_mode"):
        replies.append(
            "Варианты: " + "; ".join(a["label"] for a in alts) + ". Сравню цену и срок."
        )
    try:
        from agents.academy import client_academy_messages
        from agents.transport_options import suggest_modes

        replies.extend(client_academy_messages(cargo, route))
        modes = suggest_modes(cargo, route)
        if modes.get("scheme_legs"):
            replies.append("Плечи схемы: " + " → ".join(modes["scheme_legs"][:6]) + ".")
    except Exception:
        pass

    return {
        "reply_messages": replies,
        "cargo_updates": cargo,
        "route_updates": route,
        "services": services,
        "needs_escalation": bool(cargo.get("hazardous")),
        "escalation_reason": "dangerous_goods_review" if cargo.get("hazardous") else None,
        "next_stage": "sizing",
        "confidence": 0.7,
        "hard_block": False,
    }
