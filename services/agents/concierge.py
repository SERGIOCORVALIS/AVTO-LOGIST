from __future__ import annotations

import json
import re
from typing import Any

from common import detect_grey_scheme, extract_json, load_prompt, settings
from common.company import company_display_name, load_company
from common.llm import chat_json, gpt_client


def run_concierge(deal: dict[str, Any], user_text: str) -> dict[str, Any]:
    if detect_grey_scheme(user_text):
        return {
            "reply_messages": [
                "Такие схемы мы не сопровождаем — работаем только в легальном поле с полной декларацией.",
                "Могу посчитать белую доставку с таможней (пошлина + НДС). Пришлите описание груза, инвойс/сумму, вес/объём и города.",
            ],
            "cargo_updates": {},
            "route_updates": {},
            "needs_escalation": True,
            "escalation_reason": "grey_scheme_request",
            "next_stage": "awaiting_manager",
            "confidence": 1.0,
            "hard_block": True,
        }

    company = load_company()
    system = (
        load_prompt("gpt", "concierge.md")
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
            "deal": {
                "id": str(deal.get("id")),
                "status": deal.get("status"),
                "cargo": deal.get("cargo"),
                "route": deal.get("route"),
            },
            "message": user_text,
            "need_invoice_for_vat_duty": True,
        },
        ensure_ascii=False,
    )

    if not settings.openai_api_key:
        return _heuristic_concierge(deal, user_text)

    try:
        raw = chat_json(gpt_client(), settings.openai_model, system, user)
        data = extract_json(raw)
        # merge heuristic invoice extract if model missed
        h = _extract_invoice(user_text)
        cargo_upd = dict(data.get("cargo_updates") or {})
        cargo_upd.update({k: v for k, v in h.items() if v is not None})
        data["cargo_updates"] = cargo_upd
        return data
    except Exception:
        return _heuristic_concierge(deal, user_text)


def _extract_invoice(text: str) -> dict[str, Any]:
    out: dict[str, Any] = {}
    low = text.lower()
    # e.g. инвойс 12000 usd / invoice $12,000 / стоимость 50000 yuan
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
    m = re.search(r"(\d[\d\s]{0,6})\s*(шт|pcs|pieces|единиц)?", text.lower())
    if not m:
        return None
    try:
        return int(m.group(1).replace(" ", ""))
    except ValueError:
        return None


def _heuristic_concierge(deal: dict[str, Any], text: str) -> dict[str, Any]:
    cargo = dict(deal.get("cargo") or {})
    route = dict(deal.get("route") or {})
    low = text.lower()

    if "гуанчжоу" in low or "guangzhou" in low:
        route["origin_city"] = "Guangzhou"
        route["origin_country"] = "CN"
    if "шанхай" in low or "shanghai" in low:
        route["origin_city"] = "Shanghai"
        route["origin_country"] = "CN"
    if "москв" in low or "moscow" in low:
        route["destination_city"] = "Moscow"
        route["destination_country"] = "RU"

    inv = _extract_invoice(text)
    cargo.update({k: v for k, v in inv.items() if v is not None})
    qty = _extract_qty(text)
    if qty and qty < 1_000_000:
        cargo["quantity"] = qty

    if not cargo.get("name") and len(text) < 400:
        cargo["name"] = text[:200]

    missing = []
    if not cargo.get("name"):
        missing.append("что везём (товар, кол-во)")
    if not route.get("origin_city"):
        missing.append("город отправления в Китае")
    if not route.get("destination_city"):
        missing.append("город назначения")
    if cargo.get("invoice_value") is None and not cargo.get("invoice_value_rub"):
        missing.append("сумма инвойса и валюта (для пошлины и НДС)")

    if missing:
        q = "Чтобы посчитать доставку и таможню (пошлина + НДС), уточните:\n" + "\n".join(
            f"{i+1}) {m}" for i, m in enumerate(missing[:3])
        )
        return {
            "reply_messages": ["Принял запрос.", q],
            "cargo_updates": cargo,
            "route_updates": route,
            "needs_escalation": False,
            "escalation_reason": None,
            "next_stage": "intake",
            "confidence": 0.55,
        }

    return {
        "reply_messages": [
            f"Зафиксировал: {cargo.get('name')} · {route.get('origin_city')} → {route.get('destination_city')}.",
            "Считаю габариты, ставки и предварительную таможню (пошлина + НДС). Вернусь с вилкой.",
        ],
        "cargo_updates": cargo,
        "route_updates": route,
        "needs_escalation": False,
        "escalation_reason": None,
        "next_stage": "sizing",
        "confidence": 0.7,
    }
