"""Transport options without a hard weight gate. Dangerous/oversized sit on top of geography."""

from __future__ import annotations

from typing import Any

from agents.academy import (
    client_academy_messages,
    infer_service_boundary,
    looks_remote_ru,
    route_matrix_priority,
    scheme_legs,
    suggest_container_type,
)
from agents.geography import CN_IMPORT, DOMESTIC, INTERNATIONAL, is_international

LARGE_HINT_KG = 5000.0
SMALL_HINT_KG = 300.0
LONG_ROUTE_HINT_KM = 2100.0  # Москва–Тюмень и далее

CONTAINER_LOADING_HINTS = [
    "равномерная загрузка",
    "размещение по центральной оси",
    "крепление",
    "защитный щит у дверей, где требуется",
]


def suggest_modes(
    cargo: dict[str, Any] | None,
    route: dict[str, Any] | None,
    *,
    client_chose: str | None = None,
) -> dict[str, Any]:
    cargo = cargo or {}
    route = route or {}
    corridor = route.get("corridor")
    chosen = client_chose or route.get("transport_mode")
    weight = _num(cargo.get("weight_kg") or cargo.get("chargeable_weight_kg"))
    options: list[str]
    if corridor == DOMESTIC:
        options = ["ltl_groupage", "road_train", "container", "rail"]
        if weight is not None and weight >= LARGE_HINT_KG:
            options = ["road_train", "container", "rail", "ltl_groupage"]
        elif weight is not None and weight <= SMALL_HINT_KG:
            options = ["ltl_groupage", "rail", "container"]
    elif corridor == CN_IMPORT:
        options = ["ltl_groupage", "air", "container", "ftl_truck"]
        if weight is not None and weight >= LARGE_HINT_KG:
            options = ["container", "ftl_truck", "ltl_groupage", "air"]
        elif weight is not None and weight <= SMALL_HINT_KG:
            options = ["air", "ltl_groupage", "container"]
    else:
        options = ["ltl_groupage", "air", "container", "ftl_truck", "rail", "sea"]

    notes = [
        "нет жёсткого порога веса: авиа для 700 кг ради срока или сборка для 50 кг ради экономии — нормально",
        "показываем цену, срок и отличия",
    ]
    if chosen:
        notes.append(f"клиент выбрал {chosen} — считаем его, параллельно можем показать альтернативы")
        if chosen not in options:
            options = [chosen, *options]
    if _looks_long(route) and (not cargo.get("hazardous")):
        notes.append("длинный маршрут уровня Москва–Тюмень: сравнить авто и контейнер, если груз подходит")
        for m in ("road_train", "container"):
            if m not in options:
                options.append(m)
    if cargo.get("hazardous") or cargo.get("cargo_class") == "dangerous":
        notes.append("опасность — характеристика груза поверх географии, не отдельный коридор")
    if cargo.get("cargo_class") == "oversized":
        notes.append("негабарит — поверх географии; бот не придумывает экспертное решение")
    matrix = route_matrix_priority(route, cargo)
    if matrix:
        notes.append("академия: сначала " + "; ".join(m["label"] for m in matrix[:3]))
        for m in matrix:
            mid = {
                "container_20": "container",
                "sea_rail": "container",
                "sea": "sea" if corridor == INTERNATIONAL else "container",
                "rail": "rail" if corridor != CN_IMPORT else "container",
            }.get(m["id"], m["id"])
            if not mid or mid in ("dg_accepting", "special_equipment"):
                continue
            if mid not in options:
                options.append(mid)
    if looks_remote_ru(str(route.get("destination_city") or "")):
        notes.append("удалённый регион РФ: сборка и контейнер + выдача на смежный вид транспорта")
    boundary = infer_service_boundary(route)
    equipment = suggest_container_type(cargo, route)
    return {
        "primary": chosen or (options[0] if options else None),
        "alternatives": [m for m in options if m != chosen],
        "notes": notes,
        "hard_weight_gate": False,
        "service_boundary": boundary,
        "scheme_legs": scheme_legs(route, cargo, mode=chosen or (options[0] if options else None)),
        "container_hint": equipment,
        "academy_priority": matrix,
        "client_hints": client_academy_messages(cargo, route),
    }


def international_alternatives(route: dict[str, Any] | None) -> list[dict[str, str]]:
    route = route or {}
    origin = str(route.get("origin_city") or "").lower()
    dest = str(route.get("destination_city") or "").lower()
    if route.get("corridor") not in (CN_IMPORT, INTERNATIONAL) and not is_international(
        route.get("corridor")
    ):
        return []
    academy_first = route_matrix_priority(route, {})
    if academy_first:
        return academy_first
    shanghai = "shanghai" in origin or "шанхай" in origin
    spb = any(x in dest for x in ("петербург", "petersburg", "спб", "saint"))
    msk = any(x in dest for x in ("москв", "moscow"))
    if shanghai and spb:
        return [
            {"id": "sea", "label": "прямое море"},
            {"id": "sea_rail", "label": "море+ЖД через Владивосток/Находку"},
            {"id": "rail", "label": "сухопутное ЖД"},
            {"id": "ftl_truck", "label": "авто"},
            {"id": "air", "label": "авиа"},
        ]
    if shanghai and msk:
        return [
            {"id": "sea_rail", "label": "море+ЖД"},
            {"id": "rail", "label": "сухопутное ЖД"},
            {"id": "ftl_truck", "label": "авто"},
            {"id": "air", "label": "авиа"},
        ]
    return [
        {"id": "container", "label": "контейнер / море"},
        {"id": "rail", "label": "ЖД"},
        {"id": "ftl_truck", "label": "авто"},
        {"id": "air", "label": "авиа"},
    ]


def container_loading_messages(*, client_loads: bool = False) -> list[str]:
    lines = [
        "Инструкция по загрузке контейнера: "
        + "; ".join(CONTAINER_LOADING_HINTS)
        + "."
    ]
    if client_loads:
        lines.append(
            "Загрузку делаете вы — ответственность за крепление на вас, но щит у дверей всё равно ставим в известность."
        )
    else:
        lines.append("Просим информировать об установке защитного щита у дверей всех релевантных клиентов.")
    return lines


def incoterm_questions() -> list[str]:
    return [
        "Забираем с фабрики или поставщик довозит до порта/терминала?",
        "Куда доставлять на стороне назначения?",
    ]


def _num(v: Any) -> float | None:
    try:
        if v is None or v == "":
            return None
        return float(v)
    except (TypeError, ValueError):
        return None


def _looks_long(route: dict[str, Any]) -> bool:
    km = _num(route.get("distance_km"))
    if km and km >= LONG_ROUTE_HINT_KM:
        return True
    pair = f"{route.get('origin_city') or ''} {route.get('destination_city') or ''}".lower()
    return ("тюмен" in pair or "владивосток" in pair or "хабаровск" in pair) and (
        "москв" in pair or "петербург" in pair
    )
