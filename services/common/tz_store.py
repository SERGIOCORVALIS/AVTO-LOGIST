"""Persistence for TZ v1 tables. Failures must not break quoting."""

from __future__ import annotations

import json
from typing import Any

from common.db import db


def _soft_fail(op: str, exc: Exception) -> None:
    try:
        from common.logutil import warn as log_warn

        log_warn("tz_store_soft_fail", op=op, error=str(exc)[:300])
    except Exception:
        pass


def save_supplier_question(
    deal_id: str,
    question: str,
    *,
    card_answer: str | None = None,
    status: str = "open",
) -> dict[str, Any] | None:
    try:
        with db() as conn:
            cur = conn.execute(
                """
                INSERT INTO supplier_questions (deal_id, question, card_answer, status)
                VALUES (%s, %s, %s, %s)
                RETURNING *
                """,
                (deal_id, question, card_answer, status),
            )
            return cur.fetchone()
    except Exception as exc:
        _soft_fail("save_supplier_question", exc)
        return None


def save_rate_benchmark(
    *,
    lane: str,
    value: float,
    transport_mode: str | None = None,
    unit: str = "rub",
    source: str | None = None,
    deal_id: str | None = None,
    notes: str | None = None,
) -> None:
    try:
        with db() as conn:
            conn.execute(
                """
                INSERT INTO rate_benchmarks
                  (lane, transport_mode, unit, value, source, deal_id, notes)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                """,
                (lane, transport_mode, unit, value, source, deal_id, notes),
            )
    except Exception as exc:
        _soft_fail("save_rate_benchmark", exc)


def bump_volume_lane(
    *,
    lane: str,
    transport_mode: str | None,
    won: bool,
    qty: float = 1,
    lost_on_price: bool = False,
) -> None:
    try:
        with db() as conn:
            conn.execute(
                """
                INSERT INTO volume_lanes (lane, transport_mode, period_month, won_qty, potential_qty, lost_on_price)
                VALUES (%s, %s, date_trunc('month', NOW())::date, %s, %s, %s)
                ON CONFLICT (lane, transport_mode, period_month) DO UPDATE SET
                  won_qty = volume_lanes.won_qty + EXCLUDED.won_qty,
                  potential_qty = volume_lanes.potential_qty + EXCLUDED.potential_qty,
                  lost_on_price = volume_lanes.lost_on_price + EXCLUDED.lost_on_price,
                  updated_at = NOW()
                """,
                (
                    lane,
                    transport_mode or "",
                    qty if won else 0,
                    0 if won else qty,
                    1 if lost_on_price and not won else 0,
                ),
            )
    except Exception as exc:
        _soft_fail("bump_volume_lane", exc)

def director_report(kind: str, title: str, body: dict[str, Any]) -> None:
    try:
        with db() as conn:
            conn.execute(
                """
                INSERT INTO director_reports (kind, title, body)
                VALUES (%s, %s, %s::jsonb)
                """,
                (kind, title, json.dumps(body, default=str)),
            )
    except Exception as exc:
        _soft_fail("director_report", exc)


def on_deal_closed(deal: dict[str, Any], status: str, body: dict[str, Any] | None = None) -> None:
    route = deal.get("route") or {}
    lane = f"{route.get('origin_city') or '?'}→{route.get('destination_city') or '?'}"
    mode = route.get("transport_mode")
    qty = float((body or {}).get("qty") or (deal.get("cargo") or {}).get("quantity") or 1)
    won = status == "closed_won"
    lost_price = (not won) and "цен" in str((body or {}).get("reason") or "").lower()
    bump_volume_lane(lane=lane, transport_mode=mode, won=won, qty=qty, lost_on_price=lost_price)
    offer = deal.get("offer") or {}
    cost = (deal.get("cost_breakdown") or {}).get("effective_supplier_cost") or offer.get(
        "effective_supplier_cost"
    )
    if won and cost:
        save_rate_benchmark(
            lane=lane,
            value=float(cost),
            transport_mode=mode,
            source="closed_won",
            deal_id=str(deal.get("id") or ""),
            notes="historical benchmark, not a standing tariff",
        )
    if lost_price:
        director_report(
            "procurement_loss",
            f"Системный проигрыш по цене: {lane}",
            {
                "lane": lane,
                "mode": mode,
                "qty": qty,
                "note": "не снижать маржу вслепую — усилить закупку, пересобрать схему, оценить volume rate",
            },
        )
