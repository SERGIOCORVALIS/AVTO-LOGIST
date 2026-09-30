"""RFQ / procurement layer: market rates, mode-specific suppliers, bypass protection.

Bot obtains rates: route → cargo → technology → relevant suppliers → RFQ →
10–20 quotes where reasonable → compare → negotiate → choose.
Do not RFQ a trucker for rail. Do not leak client identity to suppliers.
"""

from __future__ import annotations

import re
from typing import Any

from agents.tz_policy import merge_tz_policy

# Mode families — a supplier tagged with one family is not auto-asked for another.
MODE_FAMILIES: dict[str, str] = {
    "ltl_groupage": "groupage",
    "road_train": "ftl",
    "ftl_truck": "ftl",
    "night_express": "ftl",
    "container": "container",
    "rail": "rail",
    "sea": "sea",
    "air": "air",
}

CLIENT_LEAK_KEYS = (
    "client_name",
    "client_phone",
    "client_email",
    "inn",
    "ogrn",
    "kpp",
    "legal_name",
    "factory_address",
    "factory_name",
    "contact",
    "tg_user_id",
    "tg_chat_id",
    "consignee",
    "client_org",
    "shipper",
    "receiver",
    "получатель",
    "грузополучатель",
    "грузоотправитель",
)

_LEAK_PATTERNS = [
    r"\bинн\s*\d{10,12}\b",
    r"\bогрн\s*\d{13,15}\b",
    r"\+7\d{10}\b",
    r"\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b",
]

# Recipient / shipper labels that must never leave for suppliers.
_PARTY_LABEL_RE = re.compile(
    r"(?i)\b(получатель|грузополучатель|грузоотправитель|consignee|shipper|receiver|"
    r"клиент|заказчик|плательщик)\s*[:\-–]?\s*[^\n;,.]{2,80}"
)


def mode_family(transport_mode: str | None) -> str | None:
    if not transport_mode:
        return None
    return MODE_FAMILIES.get(str(transport_mode).strip())


def supplier_matches_mode(supplier: dict[str, Any], transport_mode: str | None) -> bool:
    """Do not automatically ask an auto carrier for rail, etc."""
    family = mode_family(transport_mode)
    if not family:
        return True
    modes = supplier.get("modes") or supplier.get("mode_families") or []
    if not modes:
        return True
    normalized = {MODE_FAMILIES.get(str(m), str(m)) for m in modes}
    return family in normalized or str(transport_mode) in {str(m) for m in modes}


def _scrub_party_names(text: str, deal: dict[str, Any] | None = None) -> str:
    """Remove client/consignee/org names from free-text RFQ fields."""
    out = str(text or "")
    meta = (deal or {}).get("metadata") if deal else {}
    meta = meta if isinstance(meta, dict) else {}
    secrets: list[str] = []
    for key in (
        "client_name",
        "consignee",
        "client_org",
        "shipper",
        "receiver",
        "legal_name",
    ):
        val = (deal or {}).get(key) if deal else None
        if not val:
            val = meta.get(key)
        if val:
            secrets.append(str(val))
    # Also strip nested label like «Aleksandra / Строительные системы»
    client = (deal or {}).get("client_name") if deal else None
    if client and "/" in str(client):
        secrets.extend(p.strip() for p in str(client).split("/") if p.strip())
    for secret in secrets:
        s = str(secret).strip()
        if len(s) < 3:
            continue
        out = re.sub(re.escape(s), "[сторона скрыта]", out, flags=re.I)
    out = _PARTY_LABEL_RE.sub(r"\1: [скрыто]", out)
    return out


def sanitize_rfq_payload(
    payload: dict[str, Any],
    *,
    deal: dict[str, Any] | None = None,
    allow_factory: bool = False,
) -> dict[str, Any]:
    """Strip client identity and bypass-enabling details from supplier RFQ."""
    out = dict(payload)
    for key in CLIENT_LEAK_KEYS:
        out.pop(key, None)
    cargo = _scrub_party_names(str(out.get("cargo_summary") or ""), deal)
    route = _scrub_party_names(str(out.get("route_summary") or ""), deal)
    if deal:
        inn = str((deal.get("metadata") or {}).get("client_inn") or "")
        if inn:
            cargo = re.sub(re.escape(inn), "[скрыто]", cargo)
            route = re.sub(re.escape(inn), "[скрыто]", route)
    for pat in _LEAK_PATTERNS:
        cargo = re.sub(pat, "[скрыто]", cargo, flags=re.I)
        route = re.sub(pat, "[скрыто]", route, flags=re.I)
    if not allow_factory:
        cargo = re.sub(r"(завод|factory|plant)\s*[:\-–]?\s*[^\n;,]{3,80}", "завод: [по запросу]", cargo, flags=re.I)
    out["cargo_summary"] = cargo
    if route:
        out["route_summary"] = route
    body_ov = out.get("rfq_body_override")
    if isinstance(body_ov, str) and body_ov.strip():
        scrubbed = _scrub_party_names(body_ov, deal)
        for pat in _LEAK_PATTERNS:
            scrubbed = re.sub(pat, "[скрыто]", scrubbed, flags=re.I)
        out["rfq_body_override"] = scrubbed.strip()[:4000]
    out["bypass_protection"] = True
    out["do_not_disclose"] = [
        "название клиента",
        "получатель / грузополучатель",
        "грузоотправитель",
        "ИНН/контакты клиента",
        "точный завод, если не нужен для ставки",
    ]
    try:
        from agents.academy import carrier_rfq_fields, sea_quote_checklist
        from agents.tz_policy import academy_active, merge_tz_policy

        cfg = merge_tz_policy((deal or {}).get("policy") if deal else None)
        if not academy_active(cfg, layer="rfq"):
            return out

        deal_cargo = dict((deal or {}).get("cargo") or {})
        deal_route = dict((deal or {}).get("route") or {})
        # When queues sanitize without a full deal, rebuild cargo/route from payload.
        if not deal_cargo.get("name") and out.get("cargo_summary"):
            deal_cargo.setdefault("name", str(out["cargo_summary"])[:200])
        if out.get("weight_kg") is not None:
            deal_cargo.setdefault("weight_kg", out.get("weight_kg"))
        if out.get("volume_m3") is not None:
            deal_cargo.setdefault("volume_m3", out.get("volume_m3"))
        if out.get("cargo_class"):
            deal_cargo.setdefault("cargo_class", out.get("cargo_class"))
        for key in (
            "origin_city",
            "destination_city",
            "transport_mode",
            "corridor",
            "origin_incoterm",
            "dest_incoterm",
            "incoterms",
            "ready_date",
        ):
            if out.get(key) and not deal_route.get(key):
                deal_route[key] = out[key]
        if out.get("route_summary") and not deal_route.get("origin_city"):
            parts = str(out["route_summary"]).replace("→", "->").split("->")
            if len(parts) >= 2:
                deal_route.setdefault("origin_city", parts[0].strip().split("(")[0].strip())
                deal_route.setdefault("destination_city", parts[1].strip().split("(")[0].strip())
        mode = str(deal_route.get("transport_mode") or out.get("transport_mode") or "")
        out["academy_rfq"] = carrier_rfq_fields(deal_cargo, deal_route)
        out["ask_quote_to_include"] = (
            sea_quote_checklist()
            if mode in ("sea", "container")
            else [
                "local charges",
                "free time",
                "validity",
                "inclusions / exclusions",
                "VAT / currency",
            ]
        )
    except Exception as exc:
        try:
            from common.logutil import warn as log_warn

            log_warn("academy_rfq_enrich_failed", error=str(exc)[:300])
        except Exception:
            pass
    try:
        from common import load_style_prompt

        # Prefer few-shot examples block; allow enough room for 5–8 samples.
        out["_style_hint"] = load_style_prompt(
            "style_supplier.md", max_chars=4500, prefer_examples=True
        )
    except Exception:
        pass
    return out


def rfq_target_count(policy: dict[str, Any] | None = None) -> tuple[int, int]:
    cfg = merge_tz_policy(policy)
    return int(cfg["rfq_target_min"]), int(cfg["rfq_target_max"])


def build_supplier_question(
    *,
    question: str,
    deal: dict[str, Any],
    documents: list[str] | None = None,
) -> dict[str, Any]:
    """Supplier question → card/docs → client → back to supplier → continue RFQ."""
    cargo = deal.get("cargo") or {}
    route = deal.get("route") or {}
    meta = deal.get("metadata") or {}
    card_bits = {
        "cargo": cargo.get("name"),
        "weight_kg": cargo.get("weight_kg"),
        "volume_m3": cargo.get("volume_m3"),
        "origin": route.get("origin_city"),
        "destination": route.get("destination_city"),
        "mode": route.get("transport_mode"),
        "incoterms": route.get("incoterms") or route.get("origin_incoterm"),
        "docs": documents or meta.get("documents") or [],
    }
    answered = _answer_from_card(question, card_bits)
    return {
        "question": question,
        "card_answer": answered,
        "need_client": answered is None,
        "status": "answered_from_card" if answered else "ask_client",
        "client_prompt": None
        if answered
        else f"Поставщик спрашивает: {question}. В карточке ответа нет — напишите, пожалуйста.",
        "resume_rfq": True,
    }


def _answer_from_card(question: str, card: dict[str, Any]) -> str | None:
    q = (question or "").lower()
    if any(w in q for w in ("вес", "weight", "кг", "kg")) and card.get("weight_kg"):
        return f"{card['weight_kg']} кг"
    if any(w in q for w in ("объём", "объем", "volume", "м³", "m3")) and card.get("volume_m3"):
        return f"{card['volume_m3']} м³"
    if any(w in q for w in ("груз", "товар", "cargo")) and card.get("cargo"):
        return str(card["cargo"])
    if any(w in q for w in ("откуда", "origin", "забор")) and card.get("origin"):
        return str(card["origin"])
    if any(w in q for w in ("куда", "dest", "выдач")) and card.get("destination"):
        return str(card["destination"])
    if any(w in q for w in ("msds", "sds", "пасп")) and card.get("docs"):
        docs = card.get("docs") or []
        hit = [d for d in docs if "msds" in str(d).lower() or "sds" in str(d).lower()]
        if hit:
            return str(hit[0])
    if any(w in q for w in ("инкотерм", "incoterm", "fob", "exw", "fca")) and card.get("incoterms"):
        return str(card["incoterms"])
    return None


def contact_fallback_order() -> list[str]:
    return ["manager", "shared_email", "messenger", "call", "human"]


def lost_deal_is_procurement_problem(reason: str | None) -> bool:
    low = (reason or "").lower()
    return any(k in low for k in ("цен", "дорог", "ставк", "price", "дешев"))
