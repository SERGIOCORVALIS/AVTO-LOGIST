from __future__ import annotations

import re
from typing import Any

import httpx

from common.db import db
from common.proxy import httpx_proxy_kwargs


def get_calibration(category: str | None) -> dict[str, float]:
    cat = (category or "general").lower()
    try:
        with db() as conn:
            row = conn.execute(
                "SELECT * FROM calibration_coeffs WHERE category = %s", (cat,)
            ).fetchone()
    except Exception:
        return {"volume_factor": 1.0, "weight_factor": 1.0}
    if not row:
        return {"volume_factor": 1.0, "weight_factor": 1.0}
    return {
        "volume_factor": float(row["volume_factor"]),
        "weight_factor": float(row["weight_factor"]),
    }


# Category heuristics (cm / kg per unit) when client data missing
CATEGORY_DEFAULTS: dict[str, dict[str, float]] = {
    "electronics": {"l": 30, "w": 20, "h": 15, "kg": 1.2},
    "powerbank": {"l": 15, "w": 8, "h": 3, "kg": 0.35},
    "textile": {"l": 40, "w": 30, "h": 20, "kg": 0.8},
    "general": {"l": 40, "w": 30, "h": 30, "kg": 5.0},
}


def client_dim_flags(cargo: dict[str, Any] | None) -> dict[str, bool]:
    cargo = cargo or {}
    try:
        weight = float(cargo.get("weight_kg") or 0)
    except (TypeError, ValueError):
        weight = 0.0
    try:
        volume = float(cargo.get("volume_m3") or 0)
    except (TypeError, ValueError):
        volume = 0.0
    lwh = all(
        cargo.get(k) not in (None, "", 0, 0.0)
        for k in ("length_cm", "width_cm", "height_cm")
    )
    return {
        "weight": weight > 0,
        "volume": volume > 0,
        "lwh": lwh,
    }


def _is_fcl_container(cargo: dict[str, Any], route: dict[str, Any] | None = None) -> bool:
    route = route or {}
    name = str(cargo.get("name") or cargo.get("description") or "").lower()
    cls = str(cargo.get("cargo_class") or "").lower()
    mode = str(route.get("transport_mode") or cargo.get("transport_mode") or "").lower()
    if cls in ("container", "fcl", "kte", "ктк") or mode == "container":
        return True
    return bool(
        re.search(r"контейнер|container|\b40\s*(ft|фу|')|\b20\s*(ft|фу|')|\bhc\b", name)
    )


def _fcl_defaults(cargo: dict[str, Any]) -> dict[str, float]:
    """Rough FCL envelope for RFQ (not LTL parcel heuristic)."""
    blob = f"{cargo.get('name') or ''} {cargo.get('description') or ''}".lower()
    is_20 = bool(re.search(r"\b20\s*(ft|фу|'|фут)", blob)) and not re.search(
        r"\b40\s*(ft|фу|'|фут)", blob
    )
    # ISO box approx + typical payload when client weight unknown
    if is_20:
        return {"l": 589, "w": 235, "h": 239, "kg": 18000, "m3": 33.2}
    return {"l": 1203, "w": 235, "h": 239, "kg": 22000, "m3": 67.7}


def has_client_chargeable_basis(cargo: dict[str, Any] | None) -> bool:
    cargo = cargo or {}
    flags = client_dim_flags(cargo)
    if flags["weight"] or flags["volume"] or flags["lwh"]:
        return True
    # FCL/КТК: type+qty is enough to RFQ; do not wait for parcel kg.
    return _is_fcl_container(cargo)


def estimate_cargo(deal: dict[str, Any], analog_hint: dict[str, Any] | None = None) -> dict[str, Any]:
    cargo = deal.get("cargo") or {}
    route = deal.get("route") or {}
    category = (cargo.get("category") or _infer_category(cargo.get("name"))).lower()
    qty = float(cargo.get("quantity") or 1)
    cal = get_calibration(category)
    base = CATEGORY_DEFAULTS.get(category, CATEGORY_DEFAULTS["general"]).copy()
    flags = client_dim_flags(cargo)
    source = "category_heuristic"
    confidence = 0.45
    error_band = 15.0

    if _is_fcl_container(cargo, route) and not (flags["weight"] and (flags["lwh"] or flags["volume"])):
        fcl = _fcl_defaults(cargo)
        weight = float(cargo["weight_kg"]) if flags["weight"] else fcl["kg"] * qty
        volume = float(cargo["volume_m3"]) if flags["volume"] else fcl["m3"] * qty
        l, w, h = fcl["l"], fcl["w"], fcl["h"]
        if flags["lwh"]:
            l = float(cargo.get("length_cm") or l)
            w = float(cargo.get("width_cm") or w)
            h = float(cargo.get("height_cm") or h)
        return {
            "length_cm": round(l, 2),
            "width_cm": round(w, 2),
            "height_cm": round(h, 2),
            "weight_kg": round(weight, 3),
            "volumetric_weight_kg": round(volume * 167, 3),
            "chargeable_weight_kg": round(weight, 3),
            "volume_m3": round(volume, 4),
            "volumetric_divisor": 6000,
            "source": "container_fcl" if not flags["weight"] else "partial_client",
            "confidence": 0.85 if flags["weight"] else 0.7,
            "error_band_pct": 10.0 if flags["weight"] else 20.0,
            "calibration_applied": cal,
            "details": {
                "category": "container",
                "quantity": qty,
                "transport_mode": route.get("transport_mode") or "container",
                "corridor": route.get("corridor"),
                "client_weight": flags["weight"],
                "client_volume": flags["volume"],
                "client_lwh": flags["lwh"],
                "fcl": True,
            },
        }

    if analog_hint and not flags["lwh"]:
        base.update({k: analog_hint[k] for k in ("l", "w", "h", "kg") if k in analog_hint})
        source = str(analog_hint.get("source") or "web_analog")
        confidence = float(analog_hint.get("confidence", 0.6))
        error_band = float(analog_hint.get("error_band_pct", 12))

    if cargo.get("length_cm"):
        base["l"] = float(cargo["length_cm"])
    if cargo.get("width_cm"):
        base["w"] = float(cargo["width_cm"])
    if cargo.get("height_cm"):
        base["h"] = float(cargo["height_cm"])
    if flags["weight"]:
        base["kg"] = float(cargo["weight_kg"]) / max(qty, 1)

    if flags["weight"] and (flags["lwh"] or flags["volume"]):
        source = "client"
        confidence = 0.9
        error_band = 5
    elif flags["weight"] or flags["lwh"] or flags["volume"]:
        source = "partial_client"
        confidence = max(confidence, 0.8)
        error_band = 8

    l = base["l"] * (cal["volume_factor"] ** (1 / 3))
    w = base["w"] * (cal["volume_factor"] ** (1 / 3))
    h = base["h"] * (cal["volume_factor"] ** (1 / 3))
    unit_kg = base["kg"] * cal["weight_factor"]

    if source not in ("client", "partial_client"):
        l, w, h = l * 1.05, w * 1.05, h * 1.05

    total_weight = unit_kg * qty
    if flags["weight"]:
        total_weight = float(cargo["weight_kg"])
    volume_m3 = (l * w * h * qty) / 1_000_000
    if flags["volume"]:
        volume_m3 = float(cargo["volume_m3"])
    from agents.catalog import volumetric_divisor

    divisor = volumetric_divisor(route.get("transport_mode"), route.get("corridor"))
    volumetric = (l * w * h * qty) / divisor
    if flags["volume"] and not flags["lwh"]:
        volumetric = (volume_m3 * 1_000_000) / divisor
    if flags["weight"] and not flags["lwh"] and not flags["volume"]:
        chargeable = total_weight
    else:
        chargeable = max(total_weight, volumetric)

    return {
        "length_cm": round(l, 2),
        "width_cm": round(w, 2),
        "height_cm": round(h, 2),
        "weight_kg": round(total_weight, 3),
        "volumetric_weight_kg": round(volumetric, 3),
        "chargeable_weight_kg": round(chargeable, 3),
        "volume_m3": round(volume_m3, 4),
        "volumetric_divisor": divisor,
        "source": source,
        "confidence": confidence,
        "error_band_pct": error_band,
        "calibration_applied": cal,
        "details": {
            "category": category,
            "quantity": qty,
            "transport_mode": route.get("transport_mode"),
            "corridor": route.get("corridor"),
            "client_weight": flags["weight"],
            "client_volume": flags["volume"],
            "client_lwh": flags["lwh"],
        },
    }


def _infer_category(name: str | None) -> str:
    if not name:
        return "general"
    low = name.lower()
    if "powerbank" in low or "пауэр" in low or "повербанк" in low:
        return "powerbank"
    if any(x in low for x in ("phone", "телефон", "laptop", "наушник", "электрон")):
        return "electronics"
    if any(x in low for x in ("ткан", "одежд", "textile", "футболк")):
        return "textile"
    return "general"


def _analog_from_past_deals(product_name: str) -> dict[str, Any] | None:
    try:
        with db() as conn:
            row = conn.execute(
                """
                SELECT e.length_cm, e.width_cm, e.height_cm, e.weight_kg,
                       e.details, d.cargo
                FROM cargo_estimates e
                JOIN deals d ON d.id = e.deal_id
                WHERE d.status IN ('closed_won','closed_lost','negotiation','pricing')
                  AND (d.cargo->>'name' ILIKE %s OR e.details::text ILIKE %s)
                ORDER BY e.created_at DESC
                LIMIT 1
                """,
                (f"%{product_name[:60]}%", f"%{product_name[:60]}%"),
            ).fetchone()
    except Exception:
        return None
    if not row:
        return None
    details = row.get("details") or {}
    qty = float(details.get("quantity") or (row.get("cargo") or {}).get("quantity") or 1)
    qty = max(qty, 1)
    return {
        "l": float(row["length_cm"]),
        "w": float(row["width_cm"]),
        "h": float(row["height_cm"]),
        "kg": float(row["weight_kg"]) / qty,
        "confidence": 0.72,
        "error_band_pct": 8,
        "source": "past_deal_analog",
        "analog_note": f"from past estimate for '{product_name}'",
    }


def _analog_from_openai(product_name: str) -> dict[str, Any] | None:
    from common import extract_json, settings
    from common.llm import chat_json, gpt_client, model_for

    if not settings.openai_api_key:
        return None
    try:
        content = chat_json(
            gpt_client(),
            model_for("fast"),
            "Estimate typical packed unit dimensions for freight. "
            "Return JSON: l,w,h in cm, kg per unit, confidence 0-1.",
            product_name,
            temperature=0,
            trace_name="cargo_analog",
        )
        data = extract_json(content)
        l, w, h, kg = float(data["l"]), float(data["w"]), float(data["h"]), float(data["kg"])
        if min(l, w, h, kg) <= 0:
            return None
        return {
            "l": l,
            "w": w,
            "h": h,
            "kg": kg,
            "confidence": float(data.get("confidence", 0.62)),
            "error_band_pct": 10,
            "source": "llm_analog",
            "analog_note": f"llm estimate for '{product_name}'",
        }
    except Exception:
        return None


def _analog_from_duckduckgo(product_name: str) -> dict[str, Any] | None:
    try:
        r = httpx.get(
            "https://api.duckduckgo.com/",
            params={"q": f"{product_name} dimensions weight kg cm", "format": "json", "no_html": 1},
            timeout=8.0,
            headers={"User-Agent": "AutoLogisticsOS/1.0"},
        )
        r.raise_for_status()
        data = r.json()
        text = " ".join(
            filter(
                None,
                [
                    data.get("AbstractText") or "",
                    data.get("Answer") or "",
                    " ".join(
                        (t.get("Text") or "") for t in (data.get("RelatedTopics") or [])[:5] if isinstance(t, dict)
                    ),
                ],
            )
        )
        if not text.strip():
            return None
        dims = re.search(
            r"(\d+(?:[.,]\d+)?)\s*[x×х]\s*(\d+(?:[.,]\d+)?)\s*[x×х]\s*(\d+(?:[.,]\d+)?)\s*(cm|мм|mm)?",
            text,
            re.I,
        )
        weight = re.search(r"(\d+(?:[.,]\d+)?)\s*(kg|кг|g|г)\b", text, re.I)
        if not dims and not weight:
            return None
        cat = _infer_category(product_name)
        base = CATEGORY_DEFAULTS.get(cat, CATEGORY_DEFAULTS["general"]).copy()
        if dims:
            l = float(dims.group(1).replace(",", "."))
            w = float(dims.group(2).replace(",", "."))
            h = float(dims.group(3).replace(",", "."))
            unit = (dims.group(4) or "cm").lower()
            if unit in ("mm", "мм"):
                l, w, h = l / 10, w / 10, h / 10
            base.update({"l": l, "w": w, "h": h})
        if weight:
            kg = float(weight.group(1).replace(",", "."))
            if (weight.group(2) or "kg").lower() in ("g", "г"):
                kg /= 1000
            base["kg"] = kg
        return {
            **base,
            "confidence": 0.58,
            "error_band_pct": 14,
            "source": "web_analog",
            "analog_note": f"duckduckgo parse for '{product_name}'",
        }
    except Exception:
        return None


def search_web_analog(product_name: str) -> dict[str, Any] | None:
    """Resolve unit dims/weight: past deals → OpenAI → DuckDuckGo → category."""
    if not product_name:
        return None
    for finder in (_analog_from_past_deals, _analog_from_openai, _analog_from_duckduckgo):
        hit = finder(product_name)
        if hit:
            return hit
    cat = _infer_category(product_name)
    base = CATEGORY_DEFAULTS.get(cat, CATEGORY_DEFAULTS["general"])
    return {
        **base,
        "confidence": 0.45,
        "error_band_pct": 15,
        "source": "category_heuristic",
        "analog_note": f"category fallback={cat} for '{product_name}'",
    }


_URL_RE = re.compile(r"https?://[^\s<>\"')\]]+", re.I)


def extract_urls(text: str) -> list[str]:
    if not text:
        return []
    found = []
    for m in _URL_RE.finditer(text):
        u = m.group(0).rstrip(".,;:!?）)")
        if u not in found:
            found.append(u)
    return found[:5]


def _strip_html(html: str) -> str:
    html = re.sub(r"(?is)<script[^>]*>.*?</script>", " ", html)
    html = re.sub(r"(?is)<style[^>]*>.*?</style>", " ", html)
    html = re.sub(r"(?is)<noscript[^>]*>.*?</noscript>", " ", html)
    html = re.sub(r"(?is)<!--.*?-->", " ", html)
    title = ""
    tm = re.search(r"(?is)<title[^>]*>(.*?)</title>", html)
    if tm:
        title = re.sub(r"\s+", " ", tm.group(1)).strip()
    text = re.sub(r"(?is)<[^>]+>", " ", html)
    text = re.sub(r"&nbsp;", " ", text)
    text = re.sub(r"&amp;", "&", text)
    text = re.sub(r"&quot;", '"', text)
    text = re.sub(r"&#\d+;", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    if title and title.lower() not in text.lower()[:200]:
        text = f"{title}. {text}"
    return text[:12000]


def _parse_product_page_fields(text: str) -> dict[str, Any]:
    """Heuristic extract from product page / listing text."""
    out: dict[str, Any] = {}
    low = text.lower()
    # Title-like first sentence
    first = re.split(r"[.!?]\s+", text.strip(), maxsplit=1)[0].strip()
    if 8 <= len(first) <= 180 and not first.lower().startswith("http"):
        out["name"] = first[:200]
    w = re.search(r"(?:вес|weight|net\s*weight|gw)[^\d]{0,20}(\d+(?:[.,]\d+)?)\s*(kg|кг|g|г)", low)
    if w:
        kg = float(w.group(1).replace(",", "."))
        if (w.group(2) or "kg").lower() in ("g", "г"):
            kg /= 1000
        if kg > 0:
            out["weight_kg"] = kg
    dims = re.search(
        r"(\d+(?:[.,]\d+)?)\s*[x×х]\s*(\d+(?:[.,]\d+)?)\s*[x×х]\s*(\d+(?:[.,]\d+)?)\s*(cm|см|mm|мм)?",
        low,
    )
    if dims:
        l = float(dims.group(1).replace(",", "."))
        wd = float(dims.group(2).replace(",", "."))
        h = float(dims.group(3).replace(",", "."))
        unit = (dims.group(4) or "cm").lower()
        if unit in ("mm", "мм"):
            l, wd, h = l / 10, wd / 10, h / 10
        out.update({"length_cm": l, "width_cm": wd, "height_cm": h})
    price = re.search(
        r"(?:price|цена|стоимость|usd|cny|\$|¥)\s*[:=]?\s*(\d[\d\s]{0,10}(?:[.,]\d{1,2})?)\s*(usd|\$|eur|€|cny|¥|rub|₽)?",
        low,
    )
    if price:
        try:
            out["invoice_value"] = float(price.group(1).replace(" ", "").replace(",", "."))
            cur = (price.group(2) or "usd").lower()
            out["invoice_currency"] = (
                "EUR"
                if cur in ("€", "eur")
                else "CNY"
                if cur in ("¥", "cny")
                else "RUB"
                if cur in ("₽", "rub")
                else "USD"
            )
        except ValueError:
            pass
    qty = re.search(r"(?:qty|quantity|кол-?во|moq)[^\d]{0,12}(\d{1,7})", low)
    if qty:
        try:
            q = int(qty.group(1))
            if 0 < q < 1_000_000:
                out["quantity"] = q
        except ValueError:
            pass
    if len(text) >= 40:
        out["description"] = text[:1500]
        out["spec_description"] = text[:1500]
    return out


def _llm_parse_product_page(text: str, url: str) -> dict[str, Any] | None:
    from common import extract_json, settings
    from common.llm import chat_json, gpt_client, model_for

    if not settings.openai_api_key or not text.strip():
        return None
    try:
        content = chat_json(
            gpt_client(),
            model_for("document"),
            "Extract freight product facts from a product page as JSON. "
            "Fields: name (string), description (string), quantity (number), "
            "weight_kg, length_cm, width_cm, height_cm, volume_m3, "
            "invoice_value, invoice_currency (USD|EUR|CNY|RUB), category. "
            "Omit unknown. Do not invent.",
            f"URL: {url}\n\nPAGE:\n{text[:10000]}",
            temperature=0,
            trace_name="cargo_product_page",
        )
        data = extract_json(content)
        if not isinstance(data, dict):
            return None
        return {k: v for k, v in data.items() if v is not None and v != ""}
    except Exception:
        return None


def enrich_from_product_url(url: str) -> dict[str, Any]:
    """Fetch client product link and return cargo field updates."""
    out: dict[str, Any] = {
        "url": url,
        "url_enrich_attempted": True,
    }
    if not url or not url.startswith("http"):
        out["url_enriched"] = False
        return out
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (compatible; AutoLogisticsOS/1.0; +https://localhost) "
            "AppleWebKit/537.36 Chrome/120.0.0.0"
        ),
        "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ru,en;q=0.8,zh;q=0.5",
    }
    try:
        r = httpx.get(
            url,
            headers=headers,
            timeout=15.0,
            follow_redirects=True,
            **httpx_proxy_kwargs(),
        )
        r.raise_for_status()
        ctype = (r.headers.get("content-type") or "").lower()
        raw = r.text if "html" in ctype or "text" in ctype or not ctype else ""
        if not raw and r.content:
            raw = r.content[:200_000].decode("utf-8", errors="ignore")
        text = _strip_html(raw) if raw else ""
        if not text.strip():
            out["url_enriched"] = False
            return out
        fields = _parse_product_page_fields(text)
        llm = _llm_parse_product_page(text, url)
        if llm:
            # Prefer LLM name/description; keep heuristic dims if LLM omitted
            for k, v in llm.items():
                if v is not None and v != "":
                    fields[k] = v
        out.update({k: v for k, v in fields.items() if v is not None})
        out["url_enriched"] = bool(out.get("name") or out.get("description"))
        if out.get("description") or out.get("spec_description"):
            out["from_document"] = False
            # Product page description helps customs intake when no separate invoice yet
            out.setdefault("has_spec", True)
        return out
    except Exception as exc:
        out["url_enriched"] = False
        out["url_enrich_error"] = str(exc)[:200]
        return out


_URL_FIELD_MAP = {
    "name": "name",
    "description": "description",
    "spec_description": "spec_description",
    "quantity": "quantity",
    "weight_kg": "weight_kg",
    "length_cm": "length_cm",
    "width_cm": "width_cm",
    "height_cm": "height_cm",
    "volume_m3": "volume_m3",
    "invoice_value": "invoice_value",
    "invoice_currency": "invoice_currency",
    "category": "category",
    "has_spec": "has_spec",
}


def merge_url_enrichment(cargo: dict[str, Any], enrichment: dict[str, Any]) -> dict[str, Any]:
    """Fill only empty cargo fields from URL enrichment."""
    merged = dict(cargo or {})
    enr = enrichment or {}
    for meta in ("url", "url_enrich_attempted", "url_enriched", "url_enrich_error"):
        if meta in enr:
            merged[meta] = enr[meta]
    for src, dst in _URL_FIELD_MAP.items():
        v = enr.get(src)
        if v is None or v == "":
            continue
        if merged.get(dst) in (None, "", 0, 0.0):
            merged[dst] = v
    if enr.get("url_enriched") and merged.get("description") and not merged.get("invoice_value"):
        merged.setdefault("has_spec", True)
    return merged
