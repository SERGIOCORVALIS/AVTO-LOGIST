from __future__ import annotations

import json
from typing import Any

from common import extract_json, load_prompt, settings
from common.llm import chat_json, gpt_client


def price_offer(
    cost_total: float,
    policy: dict[str, Any],
    client_ask_discount_pct: float = 0,
) -> dict[str, Any]:
    target = float(policy.get("target_margin_pct", 18))
    floor = float(policy.get("floor_margin_pct", 10))
    max_disc = float(policy.get("max_discount_pct", 8))

    offer = cost_total * (1 + target / 100)
    margin = target
    needs_approve = False
    reason = ""

    disc = min(max(client_ask_discount_pct, 0), max_disc + 5)
    if disc:
        offer = offer * (1 - disc / 100)
        margin = (offer - cost_total) / offer * 100 if offer else 0

    if margin < floor:
        needs_approve = True
        reason = f"margin {margin:.1f}% < floor {floor}%"
        # restore to floor unless approved
        offer = cost_total / (1 - floor / 100)
        margin = floor

    if disc > max_disc:
        needs_approve = True
        reason = f"discount {disc}% > max {max_disc}%"

    steps = []
    for s in (0, 3, 5, min(disc, max_disc)):
        p = cost_total * (1 + target / 100) * (1 - s / 100)
        m = (p - cost_total) / p * 100 if p else 0
        if m >= floor:
            steps.append({"discount_pct": s, "price": round(p, 2), "margin_pct": round(m, 2)})

    return {
        "offer_price": round(offer, 2),
        "margin_pct": round(margin, 2),
        "discount_steps": steps,
        "needs_approve": needs_approve,
        "reason": reason,
        "cost_total": round(cost_total, 2),
    }


def negotiate_client_messages(
    deal: dict[str, Any],
    offer: dict[str, Any],
    quotes_top: list[dict[str, Any]],
) -> list[str]:
    if settings.openai_api_key:
        try:
            system = load_prompt("gpt", "negotiator.md")
            raw = chat_json(
                gpt_client(),
                settings.openai_model,
                system,
                json.dumps(
                    {"deal_status": deal.get("status"), "offer": offer, "top_quote": quotes_top[:1]},
                    ensure_ascii=False,
                ),
            )
            data = extract_json(raw)
            msgs = data.get("client_messages") or []
            if msgs:
                return msgs
        except Exception:
            pass

    q = quotes_top[0] if quotes_top else {}
    eta = f"{q.get('eta_days_min', '?')}–{q.get('eta_days_max', '?')} дн."
    return [
        f"Предварительный расчёт под ключ: {offer['offer_price']:.0f} {deal.get('currency', 'RUB')}.",
        f"Срок ориентир {eta}. В расчёте: фрахт + оценка таможни (пошлина/НДС/брокер) + локалка.",
        "Таможня и НДС — предварительная оценка до подтверждения инвойса и ТН ВЭД. Могу дать 2–3 варианта маршрут/срок.",
    ]
