"""Client freight readiness: blockers vs preliminary vs exact."""

from __future__ import annotations

from typing import Any

from agents.intake import intake_gaps, wants_quote_first

EXACT = "exact"
PRELIMINARY = "preliminary"
IMPOSSIBLE = "impossible"


def classify_calculation(
    cargo: dict[str, Any] | None,
    route: dict[str, Any] | None,
    services: dict[str, Any] | None = None,
    *,
    full_quote: bool = False,
    quote_first: bool = False,
) -> dict[str, Any]:
    cargo = cargo or {}
    route = route or {}
    services = services or {}
    assumptions: list[str] = []
    missing_exact: list[str] = []
    blockers: list[str] = []

    ops_only = (not services.get("logistics", True)) and (
        services.get("buyout") or services.get("supplier_sourcing")
    )

    gaps = intake_gaps(cargo, route, services, ops_only=ops_only, quote_first=quote_first)
    for g in gaps:
        blockers.append(g["question"])

    if ops_only:
        level = IMPOSSIBLE if blockers else (EXACT if cargo.get("url") else PRELIMINARY)
        if not cargo.get("url") and not blockers:
            assumptions.append("выкуп/подбор стартует без invoice/packing list — не блокируем")
        return _pack(level, assumptions, missing_exact, blockers)

    if full_quote and not blockers:
        return _pack(EXACT, assumptions, missing_exact, blockers)

    if not cargo.get("weight_kg") and not cargo.get("volume_m3") and not cargo.get("chargeable_weight_kg"):
        missing_exact.append("вес или объём")
        assumptions.append("предварительный расчёт без точного chargeable weight — уточним у поставщиков")
    if not route.get("origin_address") and not route.get("origin_terminal"):
        missing_exact.append("точный адрес/терминал отправления")
        assumptions.append("ставка по городу отправления, не по адресу")
    if not route.get("destination_address") and not route.get("destination_terminal"):
        missing_exact.append("точный адрес/терминал назначения")
        assumptions.append("ставка по городу назначения, не по адресу")
    if cargo.get("hazardous") and not (cargo.get("dg_un_number") or cargo.get("dg_class")):
        missing_exact.append("UN/класс опасности")
        assumptions.append("опасный груз принят в работу, экспертное решение не выдумываем")
    if cargo.get("hazardous") and not cargo.get("msds"):
        missing_exact.append("MSDS / паспорт безопасности")
        assumptions.append("без MSDS не подтверждаем «неопасный» и не закрываем DG-ставку")
    if cargo.get("oversized") or cargo.get("cargo_class") == "oversized":
        if not all(cargo.get(k) for k in ("length_cm", "width_cm", "height_cm")):
            missing_exact.append("габариты Д×Ш×В")
            assumptions.append("негабарит: ждём размеры, ставку эксперта не придумываем")
    if cargo.get("temperature_required") and cargo.get("temperature_c") is None:
        missing_exact.append("температура рефа")
        assumptions.append("не путаем активный reefer с изотермом — температуру уточняем")
    corridor = route.get("corridor")
    if corridor and corridor != "ru_domestic":
        if str(route.get("origin_incoterm") or "").upper() in ("EXW", "FCA", "FOB") and not (
            route.get("origin_incoterm_place") or route.get("origin_city")
        ):
            missing_exact.append("named place Incoterms")
            assumptions.append("FCA/EXW/FOB без места недостаточно для точной ставки")
        if not route.get("customs_scenario"):
            assumptions.append("таможня: порт прибытия или ВТТ — уточним, в предварительном считаем порт")
    dest = str(route.get("destination_city") or "").lower()
    try:
        from agents.academy import looks_remote_ru

        remote = looks_remote_ru(dest)
    except Exception:
        remote = any(h in dest for h in ("камчат", "магадан", "сахалин", "петропавловск", "kamchat"))
    if remote:
        assumptions.append("удалённый регион: в полной ставке отдельно выдача на смежный вид и каботаж")

    if blockers:
        level = IMPOSSIBLE
    elif missing_exact:
        level = PRELIMINARY
    else:
        level = EXACT
    return _pack(level, assumptions, missing_exact, blockers)


def _pack(
    level: str,
    assumptions: list[str],
    missing_exact: list[str],
    blockers: list[str],
) -> dict[str, Any]:
    return {
        "level": level,
        "can_quote": level != IMPOSSIBLE,
        "is_estimate": level != EXACT,
        "calculation_assumptions": assumptions,
        "missing_for_exact": missing_exact,
        "blockers": blockers,
    }


def client_readiness_messages(result: dict[str, Any]) -> list[str]:
    if result["level"] == IMPOSSIBLE:
        blockers = result.get("blockers") or []
        if blockers:
            # One human question — do not dump the whole checklist
            return [str(blockers[0])]
        return ["Пока считать нельзя — не хватает данных для карточки."]
    msgs: list[str] = []
    if result["level"] == PRELIMINARY:
        msgs.append(
            "Часть деталей уточню по ходу — дам расчёт на явных допущениях, заявку не блокирую."
        )
        if result.get("missing_for_exact"):
            msgs.append(
                "Для более точной ставки ещё пригодятся: "
                + ", ".join(result["missing_for_exact"][:3])
                + "."
            )
    return msgs
