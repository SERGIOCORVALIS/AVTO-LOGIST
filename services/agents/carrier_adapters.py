"""PEK / Delovye Linii adapters — custom request shapes over HTTP or lane JSON.

Without live carrier API keys these call PARTNER_HTTP_{CODE} (mock/local) or
data/partner_tariffs/{code}*.json with optional city-pair lanes.
"""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


def _now_valid(hours: int = 48) -> str:
    return (datetime.now(timezone.utc) + timedelta(hours=hours)).isoformat()


def _cities_from_route(route_summary: str) -> tuple[str, str]:
    parts = re.split(r"\s*→\s*|\s*->\s*", route_summary or "", maxsplit=1)
    origin = (parts[0] if parts else "").split("(")[0].strip().lower()
    dest = (parts[1] if len(parts) > 1 else "").split("(")[0].strip().lower()
    return origin, dest


def _lane_match(lane: dict[str, Any], origin: str, dest: str) -> bool:
    o = str(lane.get("origin") or lane.get("from") or "").strip().lower()
    d = str(lane.get("destination") or lane.get("to") or "").strip().lower()
    if not o and not d:
        return True
    if o and o not in origin and origin not in o:
        return False
    if d and d not in dest and dest not in d:
        return False
    return True


def _quote_url(base: str) -> str:
    b = base.rstrip("/")
    if b.lower().endswith("/quote"):
        return b
    return f"{b}/quote"


class CarrierHttpAdapter:
    """POST JSON quote for PEK/DL-style APIs (also accepts GET JSON like generic)."""

    def __init__(self, code: str, base_url: str, api_key: str | None = None):
        self.code = code
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key

    def quote(
        self,
        chargeable_kg: float,
        route_summary: str,
        ctx: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        origin, dest = _cities_from_route(route_summary)
        payload = {
            "kg": chargeable_kg,
            "weight_kg": chargeable_kg,
            "route": route_summary,
            "origin": origin,
            "destination": dest,
            "corridor": (ctx or {}).get("corridor"),
            "transport_mode": (ctx or {}).get("transport_mode") or "ltl",
            "carrier": self.code,
        }
        url = _quote_url(self.base_url)
        try:
            from common.http_client import partner_get, partner_post

            r = partner_post(url, json=payload, headers=headers)
            if r.status_code in (404, 405):
                r = partner_get(
                    url,
                    params={"kg": chargeable_kg, "route": route_summary},
                    headers={k: v for k, v in headers.items() if k != "Content-Type"},
                )
            r.raise_for_status()
            data = r.json()
            price = float(data.get("price") or data.get("total") or data.get("cost") or 0)  
            eta = data.get("eta") or [
                data.get("eta_days_min"),
                data.get("eta_days_max"),
            ]
            return {
                "source": f"api:{self.code}",
                "partner": self.code,
                "route_summary": route_summary,
                "price": price,
                "currency": data.get("currency", "RUB"),
                "eta_days_min": eta[0] if isinstance(eta, list) else data.get("eta_days_min"),
                "eta_days_max": (
                    eta[1]
                    if isinstance(eta, list) and len(eta) > 1
                    else data.get("eta_days_max") or (eta[0] if isinstance(eta, list) else None)
                ),
                "hidden_fees": data.get("hidden_fees") or data.get("fees") or [],
                "reliability_score": float(data.get("reliability_score", 0.75)),
                "valid_until": data.get("valid_until") or _now_valid(),
                "contact_email": data.get("contact_email"),
                "raw_http": data,
            }
        except Exception as e:
            from agents.adapters import _error_quote

            return _error_quote(self.code, route_summary, e)


class LaneTariffFileAdapter:
    """JSON with base_per_kg and optional lanes[{origin,destination,per_kg|price,eta}]."""

    def __init__(self, code: str, path: Path):
        self.code = code
        self.path = path

    def quote(
        self,
        chargeable_kg: float,
        route_summary: str,
        ctx: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        from agents.adapters import _error_quote, _tariff_matches

        try:
            cfg = json.loads(self.path.read_text(encoding="utf-8"))
            if not _tariff_matches(cfg, ctx):
                return {
                    **_error_quote(self.code, route_summary, RuntimeError("mode_mismatch")),
                    "error": "mode_mismatch",
                }
            origin, dest = _cities_from_route(route_summary)
            per_kg = float(cfg.get("base_per_kg") or cfg.get("price_per_kg") or 0)
            eta = cfg.get("eta") or [5, 9]
            fees = list(cfg.get("fees") or [])
            for lane in cfg.get("lanes") or []:
                if not _lane_match(lane, origin, dest):
                    continue
                if lane.get("price") is not None:
                    price = float(lane["price"])
                else:
                    price = round(float(lane.get("per_kg") or per_kg) * max(chargeable_kg, 1), 2)
                if lane.get("eta"):
                    eta = lane["eta"]
                fees = list(lane.get("fees") or fees)
                break
            else:
                price = round(per_kg * max(chargeable_kg, 1), 2)
                for t in sorted(cfg.get("tiers") or [], key=lambda x: float(x.get("min_kg", 0)), reverse=True):
                    if chargeable_kg >= float(t.get("min_kg", 0)):
                        price = round(float(t["per_kg"]) * max(chargeable_kg, 1), 2)
                        break
            return {
                "source": f"file:{self.code}",
                "partner": self.code,
                "route_summary": route_summary,
                "price": price,
                "currency": cfg.get("currency", "RUB"),
                "eta_days_min": eta[0],
                "eta_days_max": eta[1] if len(eta) > 1 else eta[0],
                "hidden_fees": fees,
                "reliability_score": float(cfg.get("reliability", 0.72)),
                "valid_until": _now_valid(),
                "contact_email": cfg.get("contact_email"),
            }
        except Exception as e:
            return _error_quote(self.code, route_summary, e)


def build_carrier_adapters() -> list[Any]:
    """Register pek / dellin from env HTTP or lane JSON files."""
    out: list[Any] = []
    root = Path(__file__).resolve().parents[2] / "data" / "partner_tariffs"
    for code in ("pek", "dellin"):
        url = (
            os.getenv(f"PARTNER_HTTP_{code.upper()}")
            or os.getenv(f"SUPPLIER_HTTP_{code.upper()}")
            or ""
        ).strip()
        key = (
            os.getenv(f"PARTNER_KEY_{code.upper()}")
            or os.getenv(f"SUPPLIER_KEY_{code.upper()}")
        )
        if url.startswith("http"):
            out.append(CarrierHttpAdapter(code, url, key))
            continue
        # Prefer dedicated lane file, then stem match
        candidates = [
            root / f"{code}_ru_ltl.json",
            root / f"{code}.json",
        ]
        for path in candidates:
            if path.exists():
                out.append(LaneTariffFileAdapter(code, path))
                break
    return out
