"""Client ABC memory, follow-up cadence, volume intelligence, insurance gap."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from agents.tz_policy import merge_tz_policy

ABC_FIELDS = (
    "volume_per_month",
    "regularity",
    "routes",
    "current_carrier",
    "pains",
    "selection_criteria",
    "current_price",
    "future_volume",
    "decision_maker",
    "payment_terms",
)


def followup_schedule(
    *,
    client_said_when: str | None = None,
    shipment_in_days: float | None = None,
    operational: bool = False,
    policy: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    cfg = merge_tz_policy(policy)
    if client_said_when:
        return [{"offset_hours": None, "at": client_said_when, "kind": "agreed"}]
    if operational:
        return [
            {
                "offset_hours": float(cfg["followup_operational_silence_hours"]),
                "kind": "operational_silence",
            }
        ]
    urgent = shipment_in_days is not None and shipment_in_days < float(cfg["shipment_urgent_days"])
    if urgent:
        return [{"offset_hours": float(cfg["followup_urgent_hours"]), "kind": "urgent_shipment"}]
    return [{"offset_hours": float(h), "kind": "default"} for h in cfg["followup_default_hours"]]


def followup_due_at(item: dict[str, Any], now: datetime | None = None) -> datetime | None:
    now = now or datetime.now(timezone.utc)
    if item.get("at"):
        return None
    hours = item.get("offset_hours")
    if hours is None:
        return None
    return now + timedelta(hours=float(hours))


def merge_abc(existing: dict[str, Any] | None, updates: dict[str, Any] | None) -> dict[str, Any]:
    out = dict(existing or {})
    for k, v in (updates or {}).items():
        if k in ABC_FIELDS and v not in (None, "", []):
            out[k] = v
    return out


def vip_candidate(abc: dict[str, Any] | None, policy: dict[str, Any] | None = None) -> bool:
    cfg = merge_tz_policy(policy)
    abc = abc or {}
    vol = abc.get("volume_per_month")
    try:
        vol_n = float(vol)
    except (TypeError, ValueError):
        vol_n = 0.0
    lo, hi = float(cfg["vip_volume_min"]), float(cfg["vip_volume_max"])
    prepay = str(abc.get("payment_terms") or "").lower()
    return bool(
        vol_n >= lo
        and vol_n <= hi * 4
        and abc.get("decision_maker")
        and ("100" in prepay or "предоплат" in prepay)
    )


def aggregate_lane_volume(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Won + potential volume on a lane → basis to ask a volume rate."""
    won = 0.0
    potential = 0.0
    clients: set[str] = set()
    for r in rows:
        qty = float(r.get("qty") or r.get("containers") or r.get("trucks") or 0)
        clients.add(str(r.get("client_id") or r.get("client") or ""))
        if r.get("won") or r.get("status") == "closed_won":
            won += qty
        else:
            potential += qty
    return {
        "clients": len([c for c in clients if c]),
        "won": won,
        "potential": potential,
        "total": won + potential,
        "ask_volume_rate": (won + potential) >= 10,
    }


def insurance_gap(cargo_value: float | None, carrier_limit: float | None) -> dict[str, Any]:
    cv = float(cargo_value or 0)
    lim = float(carrier_limit or 0)
    extra = max(cv - lim, 0)
    return {
        "cargo_value": cv,
        "carrier_limit": lim,
        "extra_to_cover": extra,
        "need_extra": extra > 0,
        "note": (
            f"груз {cv:.0f}, лимит {lim:.0f} → достраховать {extra:.0f}"
            if extra > 0
            else "лимит перевозчика покрывает стоимость груза"
        ),
    }


def objection_is_price(text: str) -> bool:
    low = (text or "").lower()
    return bool(
        any(w in low for w in ("дорог", "дешев", "скидк", "уступ", "снизь"))
        and "дорого ли" not in low
    )


def comparability_reply() -> str:
    return (
        "«Дорого» само по себе не скидка. Сначала сверю сопоставимость: "
        "в вашей цифре есть забор, страхование и доставка до двери?"
    )
