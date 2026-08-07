from __future__ import annotations

import os
from typing import Any


MOCK_RATES = {
    "demo_express": {
        "base_per_kg": 420,
        "eta": (8, 12),
        "reliability": 0.78,
        "fees": ["fuel 8%"],
        "volume_tier_pct": 0.94,
    },
    "silk_road": {
        "base_per_kg": 380,
        "eta": (12, 18),
        "reliability": 0.72,
        "fees": ["terminal 3500"],
        "volume_tier_pct": 0.94,
    },
    "eastgate": {
        "base_per_kg": 450,
        "eta": (7, 10),
        "reliability": 0.8,
        "fees": [],
        "volume_tier_pct": 0.94,
    },
}


def allow_mock_rates() -> bool:
    env = os.getenv("ALLOW_MOCK_RATES")
    if env is not None and env != "":
        return env.lower() in ("1", "true", "yes", "on")
    if os.getenv("ALO_ENV", "").lower() == "production":
        return False
    if os.getenv("NODE_ENV", "").lower() == "production":
        return False
    return True


def fetch_mock_quotes(
    deal: dict[str, Any],
    chargeable_kg: float,
    route_summary: str,
) -> list[dict[str, Any]]:
    """Dev/demo quotes. Disabled in production unless ALLOW_MOCK_RATES=true."""
    if not allow_mock_rates():
        return []
    from agents.adapters import MockPartnerAdapter

    return [
        MockPartnerAdapter(code).quote(chargeable_kg, route_summary)
        for code in MOCK_RATES
    ]


def compare_quotes(quotes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ranked = []
    for q in quotes:
        if q.get("error") or float(q.get("price") or 0) >= 999999999:
            continue
        price = float(q.get("price_rub") or q.get("price") or 1)
        eta = ((q.get("eta_days_min") or 14) + (q.get("eta_days_max") or 20)) / 2
        score = (
            (1_000_000 / max(price, 1)) * 0.6
            + (q.get("reliability_score") or 0.5) * 0.3
            + (20 / max(eta, 1)) * 0.1
        )
        ranked.append({**q, "score": round(score, 4), "total_landed": price})
    ranked.sort(key=lambda x: x["score"], reverse=True)
    return ranked


def negotiate_carrier(
    quote: dict[str, Any],
    aggression: float = 0.05,
    *,
    deal_id: str | None = None,
) -> dict[str, Any]:
    """Request a better rate via partner email — does not invent a discount."""
    improved = dict(quote)
    asked_price = round(float(quote.get("price") or 0) * (1 - aggression), 2)
    contact = quote.get("contact_email") or os.getenv("PARTNER_NEGOTIATE_EMAIL")
    partner = quote.get("partner")
    if not contact and partner:
        try:
            from common.db import partner_email_for_code

            contact = partner_email_for_code(str(partner))
        except Exception:
            contact = None

    enqueued = False
    if deal_id and contact:
        try:
            from common.queues import enqueue_negotiate_email

            job = enqueue_negotiate_email(
                deal_id,
                to=str(contact),
                route_summary=str(quote.get("route_summary") or ""),
                current_price=float(quote.get("price") or 0),
                currency=str(quote.get("currency") or "RUB"),
                ask_pct=aggression,
            )
            enqueued = bool(job)
        except Exception:
            enqueued = False

    improved["negotiation"] = {
        "asked_pct": aggression,
        "asked_price": asked_price,
        "achieved": False,
        "pending": enqueued,
        "contact": contact,
        "note": (
            "counter_offer_emailed"
            if enqueued
            else "awaiting_carrier_reply_or_missing_contact"
        ),
    }
    improved["source"] = quote.get("source", "api") + "+negotiate_requested"
    return improved
