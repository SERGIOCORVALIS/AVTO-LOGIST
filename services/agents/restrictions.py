"""Hard product restrictions per TZ: liquid bulk, private moves, sanctioned goods.

Dangerous / oversized are NOT a stop. Dual-use is a compliance hold, not auto-reject.
Groupage carriers (ПЭК, Деловые Линии, Байкал-Сервис, …) may be TRANSINVEST suppliers.
A competitor may simultaneously be a supplier — do not forbid that.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from agents.catalog import ru_only_services
from agents.geography import DOMESTIC

# Courier networks we do not auto-RFQ. Mentioning them is not a hard stop.
NOT_SUPPLIERS = frozenset({"cdek", "keycloak"})

COURIER_HINT_PATTERNS: list[tuple[str, str]] = [
    ("cdek", r"\bсдэк\b|\bcdek\b"),
]

GROUPAGE_SUPPLIER_PATTERNS: list[tuple[str, str]] = [
    ("pek", r"\bпэк\b|\bpecom\b|\bpek\b"),
    ("dellin", r"деловые\s+линии|\bdellin\b|delovye\s+lin"),
    ("baikal", r"байкал[-\s]?сервис|baikalsr|baikal[-\s]?service"),
    ("kit", r"\bкит\b|\bkit\b"),
    ("energia", r"энерги[яи]"),
    ("sherl", r"шерл"),
    ("azimut", r"азимут"),
    ("dalexpress", r"дальэкспресс"),
]

LIQUID_PATTERNS = [
    r"наливн",
    r"\bналив\b",
    r"цистерн",
    r"liquid\s*bulk",
    r"bulk\s*liquid",
    r"tanker\s+cargo",
    r"наливом",
]

PRIVATE_MOVE_PATTERNS = [
    r"частн\w*\s+переезд",
    r"квартирн\w*\s+переезд",
    r"переезд\s+(квартир|дома|семьи|семьи)",
    r"household\s+mov",
    r"personal\s+effects\s+move",
    r"вещи\s+из\s+квартир",
]

SANCTION_PATTERNS = [
    r"санкцион",
    r"sanctioned",
    r"оружи[ея]",
    r"наркот",
    r"военн\w+\s+(техник|груж|издел)",
]

DUAL_USE_PATTERNS = [
    r"двойн\w+\s+назначен",
    r"dual[\s-]?use",
    r"шифрован",
    r"криптошлюз",
]

CARRIER_LABELS = {
    "pek": "ПЭК",
    "baikal": "Байкал-Сервис",
    "dellin": "Деловые Линии",
    "cdek": "СДЭК",
    "kit": "КИТ",
    "energia": "Энергия",
    "sherl": "Шерл",
    "azimut": "Азимут",
    "dalexpress": "Дальэкспресс",
}

OWN_MODES_HINT = (
    "Работаем схемами: по России — сборка, автопоезд, контейнеры, ЖД, ночной экспресс; "
    "международка — сборка, авиа, контейнеры, фуры, море, ЖД. География не ограничена Китай→РФ."
)

PEK_BENCHMARK_HINT = (
    "ПЭК — конкурент и одновременно возможный поставщик сборки: запрещать закупку нельзя. "
    "Сверяемся со сроком рынка; цифру клиенту берём после ставки, в том числе у ПЭК, если даст."
)


@dataclass
class RestrictionResult:
    hard_block: bool = False
    code: str | None = None
    reply_messages: list[str] = field(default_factory=list)
    escalate: bool = False
    escalation_reason: str | None = None
    cargo_updates: dict[str, Any] = field(default_factory=dict)
    services_override: dict[str, bool] | None = None
    note: str | None = None
    must_approve: bool = False


def detect_forbidden_carrier(text: str) -> str | None:
    """Kept for tests/callers: only courier hint (CDEK), not a hard product ban."""
    low = text.lower()
    for code, pat in COURIER_HINT_PATTERNS:
        if re.search(pat, low, re.I):
            return code
    return None


def detect_competitor(text: str) -> str | None:
    low = text.lower()
    for code, pat in GROUPAGE_SUPPLIER_PATTERNS:
        if code == "pek" and re.search(pat, low, re.I):
            return code
    return None


def detect_groupage_supplier(text: str) -> str | None:
    low = text.lower()
    for code, pat in GROUPAGE_SUPPLIER_PATTERNS:
        if re.search(pat, low, re.I):
            return code
    return None


def detect_liquid_bulk(text: str, cargo: dict[str, Any] | None = None) -> bool:
    if cargo and (cargo.get("is_liquid") is True):
        return True
    blob = _blob(text, cargo)
    return any(re.search(p, blob, re.I) for p in LIQUID_PATTERNS)


def detect_private_move(text: str, cargo: dict[str, Any] | None = None) -> bool:
    blob = _blob(text, cargo)
    return any(re.search(p, blob, re.I) for p in PRIVATE_MOVE_PATTERNS)


def detect_sanctioned(text: str, cargo: dict[str, Any] | None = None) -> bool:
    blob = _blob(text, cargo)
    return any(re.search(p, blob, re.I) for p in SANCTION_PATTERNS)


def detect_dual_use(text: str, cargo: dict[str, Any] | None = None) -> bool:
    blob = _blob(text, cargo)
    return any(re.search(p, blob, re.I) for p in DUAL_USE_PATTERNS)


def detect_dangerous(text: str, cargo: dict[str, Any] | None = None) -> bool:
    if cargo and (
        cargo.get("hazardous") is True
        or cargo.get("cargo_class") == "dangerous"
        or cargo.get("battery") is True
    ):
        return True
    blob = _blob(text, cargo)
    return bool(
        re.search(r"опасн\w*\s+груз|adr\b|класс\s+опасн|un\s*\d{4}|hazardous|\bdg\b", blob)
    )


def _blob(text: str, cargo: dict[str, Any] | None) -> str:
    return " ".join(
        filter(
            None,
            [
                text or "",
                str((cargo or {}).get("name") or ""),
                str((cargo or {}).get("notes") or ""),
                str((cargo or {}).get("category") or ""),
            ],
        )
    ).lower()


def evaluate_restrictions(
    text: str,
    cargo: dict[str, Any] | None = None,
    route: dict[str, Any] | None = None,
    services: dict[str, Any] | None = None,
) -> RestrictionResult:
    cargo = cargo or {}
    route = route or {}
    services = dict(services or {})

    if detect_liquid_bulk(text, cargo):
        return RestrictionResult(
            hard_block=True,
            code="bulk_liquid",
            reply_messages=[
                "Наливные грузы не возим — цистерны и liquid bulk вне наших услуг.",
                "Можем взять тарно-штучный, габаритный, негабаритный или опасный (не налив).",
            ],
            escalate=True,
            escalation_reason="forbidden_cargo_liquid",
            cargo_updates={"is_liquid": True},
        )

    if detect_private_move(text, cargo):
        return RestrictionResult(
            hard_block=True,
            code="private_move",
            reply_messages=[
                "Частные переезды не берём — работаем с коммерческими грузами юрлиц.",
            ],
            escalate=True,
            escalation_reason="private_move",
        )

    if detect_sanctioned(text, cargo):
        return RestrictionResult(
            hard_block=True,
            code="sanctioned_goods",
            reply_messages=[
                "По этому грузу есть санкционные/запрещённые признаки. Без серых схем не везём — передаю на compliance.",
            ],
            escalate=True,
            escalation_reason="sanctioned_goods",
        )

    if detect_dual_use(text, cargo):
        return RestrictionResult(
            hard_block=False,
            code="dual_use_hold",
            must_approve=True,
            escalate=True,
            escalation_reason="dual_use_hold",
            cargo_updates={"dual_use": True},
            note="Двойное назначение — не автоматический отказ: hold живому логисту и брокеру.",
            reply_messages=[
                "Похоже на груз двойного назначения. Не отказываю автоматически: ставлю compliance hold, живой логист и брокер согласуют маршрут/погранпереход/допустимость.",
            ],
        )

    competitor = detect_competitor(text)
    groupage = detect_groupage_supplier(text)
    if competitor or groupage:
        from agents.pek_benchmark import format_pek_benchmark

        code = competitor or groupage
        label = CARRIER_LABELS.get(code or "", code or "")
        msgs = format_pek_benchmark(route, mentioned=True) if competitor else [
            f"{label} может быть и конкурентом, и нашим поставщиком сборки — запрещать закупку нельзя. Считаю нашей экономикой."
        ]
        return RestrictionResult(
            hard_block=False,
            code=f"groupage_supplier:{code}",
            note=PEK_BENCHMARK_HINT if competitor else None,
            reply_messages=msgs,
            escalate=False,
        )

    courier = detect_forbidden_carrier(text)
    if courier:
        label = CARRIER_LABELS.get(courier, courier)
        return RestrictionResult(
            hard_block=False,
            code=f"courier_hint:{courier}",
            reply_messages=[
                f"Через курьерские сети вроде {label} обычно не бронируем.",
                OWN_MODES_HINT,
            ],
            escalate=False,
        )

    corridor = route.get("corridor")
    cn_extras = any(
        services.get(k)
        for k in ("buyout", "supplier_sourcing", "customs_clearance", "certification")
    )
    if corridor == DOMESTIC and cn_extras:
        return RestrictionResult(
            hard_block=False,
            code="ru_logistics_only",
            note="По России оказываем логистику (и страхование/ночной экспресс при необходимости) — выкуп и таможню сбросил.",
            services_override=ru_only_services(services),
            reply_messages=[],
        )

    if detect_dangerous(text, cargo):
        return RestrictionResult(
            hard_block=False,
            code="dangerous_must_approve",
            must_approve=True,
            escalate=True,
            escalation_reason="dangerous_goods_review",
            cargo_updates={
                "hazardous": True,
                "cargo_class": cargo.get("cargo_class") or "dangerous",
            },
            note="Опасный груз сам по себе не стоп: нужен профильный перевозчик/эксперт, решение не выдумываем.",
        )

    return RestrictionResult()
