"""Detect when the same client starts a second, different order."""

from __future__ import annotations

import re
from typing import Any

_NEW_ORDER_RE = re.compile(
    r"нов(ый|ая|ую|ое)\s+(заказ|заявк|поставк|груз)|"
    r"друг(ой|ая|ую|ое)\s+(заказ|заявк|поставк|груз|маршрут)|"
    r"ещ[её]\s+одн|"
    r"отдельн(ая|ый|ое)|"
    r"втор(ой|ая|ую)\s+(заказ|заявк|поставк)|"
    r"параллельн",
    re.I,
)

_ADVANCED = frozenset(
    ("quoting", "pricing", "negotiation", "contract", "execution")
)


def _norm(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip().lower())


def _names_overlap(a: Any, b: Any) -> bool:
    aa, bb = _norm(a), _norm(b)
    if not aa or not bb:
        return True
    return aa in bb or bb in aa


def looks_like_new_order(
    text: str,
    deal: dict[str, Any] | None,
    cargo_upd: dict[str, Any] | None = None,
    route_upd: dict[str, Any] | None = None,
    hinted: bool | None = None,
) -> bool:
    if hinted is True:
        return True
    if _NEW_ORDER_RE.search(text or ""):
        return True
    deal = deal or {}
    old_c = deal.get("cargo") if isinstance(deal.get("cargo"), dict) else {}
    old_r = deal.get("route") if isinstance(deal.get("route"), dict) else {}
    cargo_upd = cargo_upd or {}
    route_upd = route_upd or {}
    old_name = old_c.get("name") if old_c else None
    if not old_name:
        return False
    new_name = cargo_upd.get("name")
    name_conflict = bool(new_name) and not _names_overlap(old_name, new_name)
    origin_conflict = bool(
        old_r.get("origin_city")
        and route_upd.get("origin_city")
        and _norm(old_r.get("origin_city")) != _norm(route_upd.get("origin_city"))
    )
    dest_conflict = bool(
        old_r.get("destination_city")
        and route_upd.get("destination_city")
        and _norm(old_r.get("destination_city")) != _norm(route_upd.get("destination_city"))
    )
    status = str(deal.get("status") or "intake")
    if name_conflict and (origin_conflict or dest_conflict):
        return True
    if name_conflict and status in _ADVANCED:
        return True
    if origin_conflict and dest_conflict:
        return True
    if (origin_conflict or dest_conflict) and status in _ADVANCED:
        return True
    return False
