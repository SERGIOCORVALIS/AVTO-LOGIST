from __future__ import annotations

import json
import os
import re
from typing import Any

import httpx

from common.db import db


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


def estimate_cargo(deal: dict[str, Any], analog_hint: dict[str, Any] | None = None) -> dict[str, Any]:
    cargo = deal.get("cargo") or {}
    category = (cargo.get("category") or _infer_category(cargo.get("name"))).lower()
    qty = float(cargo.get("quantity") or 1)
    cal = get_calibration(category)
    base = CATEGORY_DEFAULTS.get(category, CATEGORY_DEFAULTS["general"]).copy()
    source = "category_heuristic"
    confidence = 0.45
    error_band = 15.0

    if analog_hint:
        base.update({k: analog_hint[k] for k in ("l", "w", "h", "kg") if k in analog_hint})
        source = str(analog_hint.get("source") or "web_analog")
        confidence = float(analog_hint.get("confidence", 0.6))
        error_band = float(analog_hint.get("error_band_pct", 12))

    # client-provided dims win
    if cargo.get("length_cm"):
        base["l"] = float(cargo["length_cm"])
        source = "client"
        confidence = 0.85
        error_band = 5
    if cargo.get("width_cm"):
        base["w"] = float(cargo["width_cm"])
    if cargo.get("height_cm"):
        base["h"] = float(cargo["height_cm"])
    if cargo.get("weight_kg"):
        base["kg"] = float(cargo["weight_kg"])
        source = "client" if source != "client" else source
        confidence = max(confidence, 0.85)

    l = base["l"] * (cal["volume_factor"] ** (1 / 3))
    w = base["w"] * (cal["volume_factor"] ** (1 / 3))
    h = base["h"] * (cal["volume_factor"] ** (1 / 3))
    unit_kg = base["kg"] * cal["weight_factor"]

    # packing allowance +5% volume when heuristic
    if source != "client":
        l, w, h = l * 1.05, w * 1.05, h * 1.05

    total_weight = unit_kg * qty
    volume_m3 = (l * w * h * qty) / 1_000_000
    # air volumetric divisor 6000
    volumetric = (l * w * h * qty) / 6000
    chargeable = max(total_weight, volumetric)

    return {
        "length_cm": round(l, 2),
        "width_cm": round(w, 2),
        "height_cm": round(h, 2),
        "weight_kg": round(total_weight, 3),
        "volumetric_weight_kg": round(volumetric, 3),
        "chargeable_weight_kg": round(chargeable, 3),
        "volume_m3": round(volume_m3, 4),
        "source": source,
        "confidence": confidence,
        "error_band_pct": error_band,
        "calibration_applied": cal,
        "details": {"category": category, "quantity": qty},
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
    key = os.getenv("OPENAI_API_KEY") or ""
    if not key:
        return None
    model = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
    base = (os.getenv("OPENAI_BASE_URL") or "https://api.openai.com/v1").rstrip("/")
    try:
        r = httpx.post(
            f"{base}/chat/completions",
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            json={
                "model": model,
                "temperature": 0,
                "response_format": {"type": "json_object"},
                "messages": [
                    {
                        "role": "system",
                        "content": (
                            "Estimate typical packed unit dimensions for freight. "
                            "Return JSON: l,w,h in cm, kg per unit, confidence 0-1."
                        ),
                    },
                    {"role": "user", "content": product_name},
                ],
            },
            timeout=20.0,
        )
        r.raise_for_status()
        content = r.json()["choices"][0]["message"]["content"]
        data = json.loads(content)
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
