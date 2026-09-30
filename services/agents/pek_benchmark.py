"""Market talk-track for ПЭК: competitor AND possible groupage supplier. SLA cards, not a tariff."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from agents.catalog import MODE_LABELS_RU

_PATH = Path(__file__).resolve().parents[2] / "data" / "pek_market_cards.json"


@lru_cache(maxsize=1)
def load_pek_benchmark() -> dict[str, Any]:
    if not _PATH.is_file():
        return {
            "disclaimer_ru": "ПЭК — конкурент и возможный поставщик сборки. Ориентир рынка по сроку",
            "disclaimer_en": "PEK is a competitor and a possible groupage supplier. Market benchmark for SLA, not a tariff.",   
            "products": [],
            "lanes": [],
        }
    return json.loads(_PATH.read_text(encoding="utf-8")) or {
        "disclaimer_ru": "ПЭК — конкурент и возможный поставщик сборки. Ориентир рынка по сроку",
        "disclaimer_en": "PEK is a competitor and a possible groupage supplier. Market benchmark for SLA, not a tariff.",
        "products": [],
        "lanes": [],
    }


def _norm_city(value: Any) -> str:
    return str(value or "").strip().lower()


def lookup_lane(
    origin_city: str | None,
    dest_city: str | None,
    mode: str | None = None,
) -> dict[str, Any] | None:
    data = load_pek_benchmark()
    o, d = _norm_city(origin_city), _norm_city(dest_city)
    if not o or not d:
        return None
    lanes = data.get("lanes") or []
    for lane in lanes:
        if _norm_city(lane.get("origin")) != o or _norm_city(lane.get("destination")) != d:
            continue
        if mode and lane.get("mode") and lane["mode"] != mode:
            continue
        return lane
    if mode:
        return lookup_lane(origin_city, dest_city, None)
    return None


def product_card(mode: str | None) -> dict[str, Any] | None:
    data = load_pek_benchmark()
    want = mode or "ltl_groupage"
    for p in data.get("products") or []:
        if p.get("id") == want:
            return p
    return (data.get("products") or [None])[0]


def format_pek_benchmark(
    route: dict[str, Any] | None = None,
    *,
    mentioned: bool = True,
) -> list[str]:
    """Client-facing lines: market SLA, our modes, no invented ₽."""
    data = load_pek_benchmark()
    route = route or {}
    mode = str(route.get("transport_mode") or "ltl_groupage")
    card = product_card(mode)
    lane = lookup_lane(route.get("origin_city"), route.get("destination_city"), mode)
    sla = (lane or {}).get("typical_sla_days") or (card or {}).get("typical_sla_days") or [2, 8] 
    label = MODE_LABELS_RU.get(mode, (card or {}).get("label_ru") or "сборка")
    origin = route.get("origin_city") or "город А"
    dest = route.get("destination_city") or "город Б"
    lines: list[str] = []
    if mentioned:
        lines.append(
            "ПЭК — конкурент и одновременно возможный поставщик сборки: запрещать закупку у них нельзя. "
            "Через них можно запросить ставку, если это релевантная сборка."
        )
    lines.append(
        f"Сверка с рынком по сроку (не обещаем «как ПЭК» и не берём их цену): "
        f"{label} {origin} → {dest} обычно {sla[0]}–{sla[1]} дн. "
        "Цифру назову после ставки своих поставщиков."
    )
    lines.append(
        "Наши схемы: сборка, автопоезд, контейнеры, ЖД. "
        + str(data.get("disclaimer_ru") or "")
    )
    return lines


def format_own_product(route: dict[str, Any] | None = None) -> list[str]:
    """Client product card — our modes and market SLA, never a PEK price promise."""
    route = route or {}
    corridor = route.get("corridor") or "ru_domestic"
    default_mode = "ltl_groupage" if corridor == "ru_domestic" else "ltl_groupage"
    mode = str(route.get("transport_mode") or default_mode)
    card = product_card(mode)
    lane = lookup_lane(route.get("origin_city"), route.get("destination_city"), mode)
    sla = (lane or {}).get("typical_sla_days") or (card or {}).get("typical_sla_days") or [2, 8]
    label = MODE_LABELS_RU.get(mode, (card or {}).get("label_ru") or "сборка")
    origin = route.get("origin_city") or "город отправления"
    dest = route.get("destination_city") or "город назначения"
    if corridor == "cn_import" or corridor == "international":
        return [
            f"Продукт: {label}, международка {origin} → {dest}. "
            f"Ориентир срока {sla[0]}–{sla[1]} дн (рынок/benchmark, не оферта и не постоянный тариф). "
            "Ставку назову после ответа поставщиков."
        ]
    return [
        f"Продукт: {label} по России, {origin} → {dest}. "
        f"Ориентир срока {sla[0]}–{sla[1]} дн (рынок, не оферта). "
        "Цифру — после ставки своих поставщиков."
    ]


def compact_pek_for_llm() -> dict[str, Any]:
    data = load_pek_benchmark()
    return {
        "role": "competitor_benchmark",
            "never_rfq": False,
            "never_book": False,
            "disclaimer": data.get("disclaimer_ru"),
        "products": [
            {
                "id": p.get("id"),
                "label": p.get("label_ru"),
                "sla_days": p.get("typical_sla_days"),
            }
            for p in (data.get("products") or [])
        ],
    }
