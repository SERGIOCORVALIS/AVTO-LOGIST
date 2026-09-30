"""Sequential client intake: ask only what is missing, one question at a time.

Order for a calculation card:
1) product
2) origin city
3) destination city
4) factory pickup vs supplier-to-port (international)
5) ready-to-ship date
6) invoice / specification for customs (international)
Then RFQ to suppliers.
"""

from __future__ import annotations

import re
from typing import Any

from agents.geography import CN_IMPORT, INTERNATIONAL, is_international

# Stable keys used by readiness + concierge
GAP_PRODUCT = "product"
GAP_ORIGIN = "origin_city"
GAP_DEST = "destination_city"
GAP_PICKUP = "pickup_mode"
GAP_READY = "ready_date"
GAP_CUSTOMS_DOC = "customs_doc"

QUESTION_BY_GAP: dict[str, str] = {
    GAP_PRODUCT: "Добрый день!  ООО ЖД Трансинвест,рады вам помочь. Что за товар везём? Кратко название и количество, или пришлите ссылку / фото / спецификацию.",
    GAP_ORIGIN: "Из какого города забираем / отправляем груз?",
    GAP_DEST: "В какой город доставляем?",
    GAP_PICKUP: "Груз забираем с фабрики или поставщик довозит до порта/терминала?",
    GAP_READY: "Когда груз готов к отгрузке? (дата или «через N дней»).",
    GAP_CUSTOMS_DOC: (
        "Для таможенного расчёта пришлите инвойс или спецификацию с описанием товара "
        "(файл, фото или сумма инвойса и валюта)."
    ),
}

AFTER_CARD_COMPLETE = (
    "Карточка собрана. Запрашиваю ставки на подходящие схемы и сравню полную цену, срок и риски."
)

PRODUCT_URL_UNRESOLVED = "product_url_unresolved"

PRODUCT_HANDOFF_REPLY = (
    "По ссылке к сожалению сейчас нет технической пределить товар. "
    "Передаю заявку старшему менеджеру — он уточнит описание и продолжит расчёт."
)


def _is_intl(route: dict[str, Any], services: dict[str, Any] | None = None) -> bool:
    corridor = (route or {}).get("corridor")
    if corridor in (CN_IMPORT, INTERNATIONAL) or is_international(corridor):
        return True
    services = services or {}
    if services.get("customs_clearance"):
        return True
    oc = str((route or {}).get("origin_country") or "").upper()
    dc = str((route or {}).get("destination_country") or "").upper()
    if oc and dc and oc != dc:
        return True
    if oc and oc != "RU":
        return True
    return False


def has_product(cargo: dict[str, Any] | None) -> bool:
    cargo = cargo or {}
    name = str(cargo.get("name") or "").strip()
    if name and name.lower() not in ("груз", "товар", "cargo", "product"):
        return True
    desc = str(cargo.get("description") or cargo.get("spec_description") or "").strip()
    if len(desc) >= 8:
        return True
    return False


def needs_product_handoff(cargo: dict[str, Any] | None) -> bool:
    """Product link could not be parsed and the client did not name the cargo."""
    cargo = cargo or {}
    if has_product(cargo):
        return False
    url = str(cargo.get("url") or "").strip()
    if not url.startswith("http"):
        return False
    if not cargo.get("url_enrich_attempted"):
        return False
    return not bool(cargo.get("url_enriched"))


def has_customs_doc(cargo: dict[str, Any] | None) -> bool:
    cargo = cargo or {}
    if cargo.get("invoice_value") not in (None, "", 0, 0.0):
        return True
    if cargo.get("invoice_doc") or cargo.get("packing_list"):
        return True
    # Spec/description from an uploaded file counts; a product URL alone does not
    if cargo.get("from_document") and (
        cargo.get("has_spec")
        or cargo.get("spec_description")
        or cargo.get("description")
        or cargo.get("name")
    ):
        return True
    return False


def wants_quote_first(text: str | None) -> bool:
    low = (text or "").lower()
    return bool(
        re.search(
            r"ставк|расч[её]т|полный\s+расч|сначала\s+став|нужен\s+расч|дайте\s+став|ориентир|предварит",
            low,
        )
    )


def has_pickup_mode(route: dict[str, Any] | None) -> bool:
    route = route or {}
    if route.get("origin_incoterm"):
        return True
    if route.get("pickup_mode") in ("factory", "port", "terminal", "exw", "fob", "fca"):
        return True
    return False


def intake_gaps(
    cargo: dict[str, Any] | None,
    route: dict[str, Any] | None,
    services: dict[str, Any] | None = None,
    *,
    ops_only: bool = False,
    quote_first: bool = False,
) -> list[dict[str, str]]:
    """Ordered missing fields with human questions. Empty → card ready for RFQ."""
    cargo = cargo or {}
    route = route or {}
    services = services or {}
    gaps: list[dict[str, str]] = []

    if ops_only:
        if not has_product(cargo) and not cargo.get("url"):
            gaps.append({"key": GAP_PRODUCT, "question": QUESTION_BY_GAP[GAP_PRODUCT]})
        return gaps

    if not has_product(cargo):
        # URL alone: wait for enrich; if already tried and still empty — ask
        if not cargo.get("url") or cargo.get("url_enrich_attempted"):
            gaps.append({"key": GAP_PRODUCT, "question": QUESTION_BY_GAP[GAP_PRODUCT]})
    if not route.get("origin_city"):
        gaps.append({"key": GAP_ORIGIN, "question": QUESTION_BY_GAP[GAP_ORIGIN]})
    if not route.get("destination_city"):
        gaps.append({"key": GAP_DEST, "question": QUESTION_BY_GAP[GAP_DEST]})

    intl = _is_intl(route, services)
    if intl and not has_pickup_mode(route):
        gaps.append({"key": GAP_PICKUP, "question": QUESTION_BY_GAP[GAP_PICKUP]})
    if not route.get("ready_date") and not quote_first:
        gaps.append({"key": GAP_READY, "question": QUESTION_BY_GAP[GAP_READY]})
    if intl and not has_customs_doc(cargo) and not quote_first:
        gaps.append({"key": GAP_CUSTOMS_DOC, "question": QUESTION_BY_GAP[GAP_CUSTOMS_DOC] })

    return gaps


def next_intake_question(
    cargo: dict[str, Any] | None,
    route: dict[str, Any] | None,
    services: dict[str, Any] | None = None,
    *,
    ops_only: bool = False,
    quote_first: bool = False,
) -> str | None:
    gaps = intake_gaps(cargo, route, services, ops_only=ops_only, quote_first=quote_first)
    if not gaps:
        return None
    return gaps[0]["question"]


def intake_complete(
    cargo: dict[str, Any] | None,
    route: dict[str, Any] | None,
    services: dict[str, Any] | None = None,
    *,
    ops_only: bool = False,
    quote_first: bool = False,
) -> bool:
    return not intake_gaps(cargo, route, services, ops_only=ops_only, quote_first=quote_first)
