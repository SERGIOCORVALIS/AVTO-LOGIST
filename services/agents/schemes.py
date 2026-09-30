"""Transport scheme catalog → default operators / modes (recommendation §9)."""

from __future__ import annotations

from typing import Any

# Canonical schemes used on RFQ / quote pipeline.
SCHEME_CATALOG: dict[str, dict[str, Any]] = {
    "pszhvs": {
        "label": "ПСЖВС (станция–порт, жд+море)",
        "aliases": ("pszhvs_rail_sea", "rail_sea", "южсах", "station_port"),
        "preferred_operators": ["fesco", "transcontainer", "kasco", "sasco", "dvlk"],
        "transport_mode": "container",
        "corridor": "ru_domestic",
        "require_mode": True,
        "compare": "station_port",
    },
    "cy-cy": {
        "label": "CY–CY контейнер",
        "aliases": ("cy_cy", "cycy", "container_cy"),
        "preferred_operators": ["fesco", "transcontainer", "sasco"],
        "transport_mode": "container",
        "require_mode": True,
        "compare": "container",
    },
    "ftl": {
        "label": "FTL / фура",
        "aliases": ("ftl_truck", "road_train", "фура", "авто"),
        "preferred_operators": [],
        "transport_mode": "ftl_truck",
        "require_mode": True,
        "compare": "road",
    },
    "ltl": {
        "label": "LTL / сборный",
        "aliases": ("ltl_groupage", "groupage", "сборный"),
        "preferred_operators": [],
        "transport_mode": "ltl_groupage",
        "require_mode": True,
        "compare": "road",
    },
    "sea": {
        "label": "Море",
        "aliases": ("ocean", "fcl", "lcl"),
        "preferred_operators": ["fesco", "sasco"],
        "transport_mode": "sea",
        "require_mode": True,
        "compare": "sea",
    },
    "rail": {
        "label": "Железная дорога",
        "aliases": ("жд", "railway"),
        "preferred_operators": ["transcontainer", "fesco"],
        "transport_mode": "rail",
        "require_mode": True,
        "compare": "rail",
    },
}


def _norm(value: str | None) -> str:
    return str(value or "").strip().lower().replace(" ", "_").replace("–", "-")


def canonicalize_scheme(scheme: str | None) -> str | None:
    raw = _norm(scheme)
    if not raw:
        return None
    # Cyrillic / mixed labels from staff
    if "псжвс" in raw or "южсах" in raw:
        return "pszhvs"
    if raw in ("фура", "авто", "еврофур"):
        return "ftl"
    if "сборн" in raw:
        return "ltl"
    if raw in SCHEME_CATALOG:
        return raw
    for sid, meta in SCHEME_CATALOG.items():
        if raw == sid or raw in {_norm(a) for a in meta.get("aliases") or []}:
            return sid
        if sid in raw or any(_norm(a) in raw for a in (meta.get("aliases") or [])):
            return sid
    if "pszhvs" in raw or "rail_sea" in raw:
        return "pszhvs"
    return None


def resolve_scheme_defaults(
    *,
    scheme: str | None = None,
    transport_mode: str | None = None,
    corridor: str | None = None,
    preferred: list[str] | None = None,
) -> dict[str, Any]:
    """Merge explicit preferred with scheme catalog defaults."""
    sid = canonicalize_scheme(scheme)
    # Infer PSZhVS for domestic container when scheme missing but corridor fits Far-East habit
    if not sid and _norm(corridor) == "ru_domestic" and _norm(transport_mode) in (  
        "container",
        "rail",
        "sea",
    ):
        # Do not force PSZhVS without scheme — only catalog when scheme known.
        sid = None

    cat = SCHEME_CATALOG.get(sid or "", {}) if sid else {}
    pref = [str(p).strip().lower() for p in (preferred or []) if p]
    if not pref:
        pref = list(cat.get("preferred_operators") or [])

    mode = transport_mode or cat.get("transport_mode")
    return {
        "scheme_id": sid,
        "label": cat.get("label") or sid,
        "preferred_operators": pref,
        "transport_mode": mode,
        "corridor": corridor or cat.get("corridor"),
        "require_mode": bool(cat.get("require_mode")) or bool(pref),
        "compare": cat.get("compare") or "generic",
        "from_catalog": bool(cat),
    }
