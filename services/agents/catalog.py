"""Product catalog: corridors, modes, cargo classes, Incoterms, services.

Corridors are geography-first (RU domestic vs any international). China→RU is a
subtype of international, not the only foreign lane.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from agents.geography import CN_IMPORT, CORRIDORS, DOMESTIC, INTERNATIONAL, infer_corridor as geo_infer_corridor
from agents.readiness import classify_calculation

_REPO_ROOT = Path(__file__).resolve().parents[2]
_CATALOG_PATH = _REPO_ROOT / "data" / "service_catalog.json"

INCOTERMS_2020 = [
    "EXW",
    "FCA",
    "FAS",
    "FOB",
    "CFR",
    "CIF",
    "CPT",
    "CIP",
    "DAP",
    "DPU",
    "DDP",
]

# Re-export geography corridors so callers keep `from agents.catalog import CORRIDORS`.
DEAL_STATUSES = (
    "intake",
    "sizing",
    "customs",
    "quoting",
    "pricing",
    "negotiation",
    "contract",
    "execution",
    "awaiting_manager",
    "closed_won",
    "closed_lost",
    "cancelled",
)
CONCIERGE_STAGES = (
    "intake",
    "sizing",
    "customs",
    "quoting",
    "pricing",
    "negotiation",
    "contract",
    "execution",
    "awaiting_manager",
)
CARGO_CLASSES = ("tare_piece", "dimensional", "oversized", "dangerous")
SERVICE_IDS = (
    "logistics",
    "buyout",
    "supplier_sourcing",
    "customs_clearance",
    "certification",
    "insurance",
    "night_express",
)
CN_SERVICE_IDS = SERVICE_IDS
RU_MODES = ("ltl_groupage", "road_train", "container", "rail")
CN_MODES = ("ltl_groupage", "air", "container", "ftl_truck")
INTL_MODES = ("ltl_groupage", "air", "container", "ftl_truck", "rail", "sea")

MODE_DIVISORS = {
    "air": 6000.0,  # Academy ~167 kg/m³; confirm per airline
    "ltl_groupage": 5000.0,
    "ftl_truck": 4000.0,
    "road_train": 4000.0,
    "container": 1000.0,
    "rail": 1000.0,
    "sea": 1000.0,
    "night_express": 4000.0,
}

MODE_LABELS_RU = {
    "ltl_groupage": "сборка",
    "road_train": "автопоезд",
    "container": "контейнеры",
    "rail": "ЖД",
    "air": "авиа",
    "ftl_truck": "фуры",
    "sea": "море",
    "night_express": "ночной экспресс",
}

CARGO_CLASS_LABELS_RU = {
    "tare_piece": "тарно-штучный",
    "dimensional": "габаритный",
    "oversized": "негабаритный",
    "dangerous": "опасный",
}

SERVICE_LABELS_RU = {
    "logistics": "логистика",
    "buyout": "выкуп",
    "supplier_sourcing": "подбор поставщика",
    "customs_clearance": "растаможка",
    "certification": "сертификация",
    "insurance": "страхование груза",
    "night_express": "ночной экспресс",
}

CORRIDOR_LABELS_RU = {
    DOMESTIC: "перевозки по России",
    CN_IMPORT: "импорт из Китая",
    INTERNATIONAL: "международная перевозка",
}

DEFAULT_MODE = {
    DOMESTIC: "ltl_groupage",
    CN_IMPORT: "ltl_groupage",
    INTERNATIONAL: "container",
}


@lru_cache(maxsize=1)
def load_catalog() -> dict[str, Any]:
    if _CATALOG_PATH.is_file():
        return json.loads(_CATALOG_PATH.read_text(encoding="utf-8"))
    return {
        "version": 1,
        "incoterms_2020": INCOTERMS_2020,
        "corridors": {
            DOMESTIC: {"modes": [{"id": m} for m in RU_MODES], "services": ["logistics"]},
            CN_IMPORT: {"modes": [{"id": m} for m in CN_MODES], "services": list(SERVICE_IDS)},
            INTERNATIONAL: {
                "modes": [{"id": m} for m in INTL_MODES],
                "services": ["logistics", "customs_clearance", "certification", "insurance"],
            },
        },
    }


def compact_catalog_for_llm() -> dict[str, Any]:
    cat = load_catalog()
    try:
        from agents.pek_benchmark import compact_pek_for_llm

        pek = compact_pek_for_llm()
    except Exception:
        pek = {
            "role": "competitor_and_possible_supplier",
            "never_rfq": False,
            "disclaimer": "ПЭК — конкурент и одновременно возможный поставщик сборки",
        }
    return {
        "corridors": {
            DOMESTIC: {
                "label": CORRIDOR_LABELS_RU[DOMESTIC],
                "modes": [MODE_LABELS_RU[m] + f" ({m})" for m in RU_MODES],
                "services": ["logistics only"],
            },
            CN_IMPORT: {
                "label": CORRIDOR_LABELS_RU[CN_IMPORT],
                "modes": [MODE_LABELS_RU[m] + f" ({m})" for m in CN_MODES],
                "services": [SERVICE_LABELS_RU[s] + f" ({s})" for s in SERVICE_IDS],
            },
            INTERNATIONAL: {
                "label": CORRIDOR_LABELS_RU[INTERNATIONAL],
                "modes": [MODE_LABELS_RU[m] + f" ({m})" for m in INTL_MODES],
                "services": ["логистика, таможня, сертификация, страхование"],
            },
        },
        "cargo_classes": [CARGO_CLASS_LABELS_RU[c] + f" ({c})" for c in CARGO_CLASSES],
        "incoterms_2020": cat.get("incoterms_2020") or INCOTERMS_2020,
        "incoterms_are_a_pair": "origin_incoterm + dest_incoterm, e.g. FOB-DAP, EXW-EXW",
        "geography_first": "both points RU → ru_domestic; any foreign point → international (cn_import if China)",
        "groupage_suppliers_ok": ["ПЭК", "Деловые Линии", "КИТ", "Байкал-Сервис", "Энергия", "Шерл", "Азимут", "Дальэкспресс"],
        "competitor_may_be_supplier": True,
        "competitors": pek,
        "hard_stops": ["налив / bulk liquid", "частные переезды", "санкционные товары"],
        "not_hard_stop": ["опасный", "негабарит", "двойное назначение — compliance hold"],
        "academy": _academy_digest(),
    }


def _academy_digest() -> dict[str, Any]:
    try:
        from agents.academy import compact_academy_for_llm

        return compact_academy_for_llm()
    except Exception:
        return {"loaded": False}


def normalize_deal_status(stage: Any, fallback: str = "intake") -> str:
    """Map free-form GPT next_stage onto Postgres deal_status enum."""
    raw = str(stage or "").strip().lower()
    raw = raw.replace(" ", "_").replace("-", "_")
    if raw in DEAL_STATUSES:
        return raw
    aliases = {
        "qualify": "intake",
        "qualification": "intake",
        "collect": "intake",
        "clarify": "intake",
        "clarification": "intake",
        "details": "intake",
        "cargo_details": "intake",
        "route_clarification": "intake",
        "clarify_route": "intake",
        "quote_calculation": "quoting",
        "quote": "quoting",
        "calculation": "quoting",
        "offer": "pricing",
        "kp": "pricing",
        "escalate": "awaiting_manager",
        "manager": "awaiting_manager",
    }
    if raw in aliases:
        return aliases[raw]
    if any(k in raw for k in ("quot", "расчёт", "расчет", "ставк", "цен")):
        return "quoting"
    if any(k in raw for k in ("custom", "тамож", "ндс", "пошлин")):
        return "customs"
    if any(k in raw for k in ("negot", "торг")):
        return "negotiation"
    if any(k in raw for k in ("contract", "договор")):
        return "contract"
    if any(k in raw for k in ("siz", "габарит", "вес")):
        return "sizing"
    if any(k in raw for k in ("manager", "escalat", "эскал")):
        return "awaiting_manager"
    fb = fallback if fallback in DEAL_STATUSES else "intake"
    return fb


def normalize_incoterm(value: Any) -> str | None:
    if not value or not isinstance(value, str):
        return None
    code = value.strip().upper()
    if code not in INCOTERMS_2020:
        return None
    return code


def format_incoterms_pair(origin: Any = None, dest: Any = None) -> str:
    o = normalize_incoterm(origin) or ""
    d = normalize_incoterm(dest) or ""
    if o and d:
        return f"{o}-{d}"
    return o or d


def volumetric_divisor(transport_mode: str | None, corridor: str | None = None) -> float:
    mode = (transport_mode or "").strip()
    if mode in MODE_DIVISORS:
        return MODE_DIVISORS[mode]
    if corridor == DOMESTIC:
        return MODE_DIVISORS["ltl_groupage"]
    return MODE_DIVISORS["ltl_groupage"]


def default_services(corridor: str | None) -> dict[str, bool]:
    flags = {k: False for k in SERVICE_IDS}
    flags["logistics"] = True
    if corridor == DOMESTIC:
        return flags
    flags["customs_clearance"] = True
    return flags


def services_from_list(
    selected: list[Any] | None,
    corridor: str | None,
    existing: dict[str, Any] | None = None,
) -> dict[str, bool]:
    flags = dict(existing) if existing else default_services(corridor)
    for key in SERVICE_IDS:
        flags.setdefault(key, False)
    if selected is None:
        if corridor == DOMESTIC:
            return ru_only_services(flags)
        return flags
    chosen = {str(s).strip() for s in selected if s}
    if chosen:
        for key in SERVICE_IDS:
            flags[key] = key in chosen
        if corridor != DOMESTIC and "logistics" not in chosen:
            flags["logistics"] = False
            if not any(
                flags.get(k)
                for k in ("buyout", "supplier_sourcing", "customs_clearance", "certification", "insurance")
            ):
                flags["logistics"] = True
                flags["customs_clearance"] = True
    if corridor == DOMESTIC:
        return ru_only_services(flags)
    return flags


def ru_only_services(flags: dict[str, Any]) -> dict[str, bool]:
    out = {k: False for k in SERVICE_IDS}
    out["logistics"] = True
    if flags.get("night_express"):
        out["night_express"] = True
    if flags.get("insurance"):
        out["insurance"] = True
    return out


def allowed_modes(corridor: str | None) -> tuple[str, ...]:
    if corridor == DOMESTIC:
        return RU_MODES
    if corridor == CN_IMPORT:
        return CN_MODES
    if corridor == INTERNATIONAL:
        return INTL_MODES
    return RU_MODES + CN_MODES + ("sea",)


def normalize_mode(mode: Any, corridor: str | None) -> str | None:
    if not mode or not isinstance(mode, str):
        return None
    m = mode.strip()
    if m in allowed_modes(corridor) or m in MODE_DIVISORS:
        if corridor and m not in allowed_modes(corridor):
            return DEFAULT_MODE.get(corridor or "", None)
        return m
    return None


def default_mode(corridor: str | None) -> str:
    return DEFAULT_MODE.get(corridor or "", "air")


def apply_route_defaults(route: dict[str, Any]) -> dict[str, Any]:
    out = dict(route)
    corridor = out.get("corridor")
    if corridor not in CORRIDORS:
        corridor = infer_corridor(out)
        if corridor:
            out["corridor"] = corridor
    mode = normalize_mode(out.get("transport_mode"), corridor)
    if not mode and corridor:
        mode = default_mode(corridor)
    if mode:
        out["transport_mode"] = mode
    origin_inc = normalize_incoterm(out.get("origin_incoterm"))
    dest_inc = normalize_incoterm(out.get("dest_incoterm"))
    if origin_inc:
        out["origin_incoterm"] = origin_inc
    if dest_inc:
        out["dest_incoterm"] = dest_inc
    pair = format_incoterms_pair(out.get("origin_incoterm"), out.get("dest_incoterm"))
    if pair:
        out["incoterms"] = pair
    elif out.get("incoterms") and "-" in str(out["incoterms"]):
        parts = str(out["incoterms"]).replace("–", "-").split("-")
        if len(parts) == 2:
            o, d = normalize_incoterm(parts[0]), normalize_incoterm(parts[1])
            if o:
                out["origin_incoterm"] = o
            if d:
                out["dest_incoterm"] = d
            if o and d:
                out["incoterms"] = f"{o}-{d}"
    return out


def infer_corridor(route: dict[str, Any]) -> str | None:
    return geo_infer_corridor(route)


def ready_to_quote(
    cargo: dict[str, Any],
    route: dict[str, Any],
    services: dict[str, Any],
    *,
    full_quote: bool = False,
) -> bool:
    if full_quote:
        return True
    return classify_calculation(cargo, route, services, full_quote=full_quote)["can_quote"]


def selected_service_labels(services: dict[str, Any]) -> list[str]:
    return [
        SERVICE_LABELS_RU[k]
        for k in SERVICE_IDS
        if services.get(k) and k in SERVICE_LABELS_RU
    ]
