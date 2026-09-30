"""Geography first: both points RU → domestic; any foreign point → international.

China→Russia is a subtype of international (cn_import), not the only corridor.
"""

from __future__ import annotations

from typing import Any

DOMESTIC = "ru_domestic"
CN_IMPORT = "cn_import"
INTERNATIONAL = "international"

CORRIDORS = (DOMESTIC, CN_IMPORT, INTERNATIONAL)

_CN = frozenset({"CN", "CHN", "CHINA", "КНР", "КИТАЙ"})
_RU = frozenset({"RU", "RUS", "RUSSIA", "РФ", "РОССИЯ"})


def _norm_country(value: Any) -> str:
    return str(value or "").strip().upper()


def is_china(country: Any) -> bool:
    return _norm_country(country) in _CN


def is_russia(country: Any) -> bool:
    code = _norm_country(country)
    return (not code) or code in _RU


def is_international(corridor: str | None) -> bool:
    return corridor in (CN_IMPORT, INTERNATIONAL)


def infer_corridor(route: dict[str, Any] | None) -> str | None:
    route = route or {}
    existing = route.get("corridor")
    if existing in CORRIDORS:
        return existing
    oc = _norm_country(route.get("origin_country"))
    dc = _norm_country(route.get("destination_country"))
    if not oc and not dc:
        return None
    origin_ru = is_russia(oc) if oc else False
    dest_ru = is_russia(dc) if dc else False
    if oc and dc and origin_ru and dest_ru:
        return DOMESTIC
    if is_china(oc) or is_china(dc):
        return CN_IMPORT
    if oc and dc and (not origin_ru or not dest_ru):
        return INTERNATIONAL
    if oc and not origin_ru:
        return CN_IMPORT if is_china(oc) else INTERNATIONAL
    if dc and not dest_ru:
        return CN_IMPORT if is_china(dc) else INTERNATIONAL
    if origin_ru and dest_ru:
        return DOMESTIC
    return None


def corridor_label_ru(corridor: str | None) -> str:
    return {
        DOMESTIC: "перевозки по России",
        CN_IMPORT: "импорт из Китая",
        INTERNATIONAL: "международная перевозка",
    }.get(corridor or "", "перевозка")
