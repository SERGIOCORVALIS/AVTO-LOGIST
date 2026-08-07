"""Logistics partner API adapters (HTTP, CDEK, JSON tariffs + optional mock)."""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Protocol

import httpx

from agents.rates import MOCK_RATES


class QuoteAdapter(Protocol):
    code: str

    def quote(self, chargeable_kg: float, route_summary: str) -> dict[str, Any]: ...


def _allow_mock_rates() -> bool:
    env = os.getenv("ALLOW_MOCK_RATES")
    if env is not None and env != "":
        return env.lower() in ("1", "true", "yes", "on")
    # Production defaults to false
    if os.getenv("ALO_ENV", "").lower() == "production":
        return False
    if os.getenv("NODE_ENV", "").lower() == "production":
        return False
    return True


class MockPartnerAdapter:
    def __init__(self, code: str):
        self.code = code

    def quote(self, chargeable_kg: float, route_summary: str) -> dict[str, Any]:
        cfg = MOCK_RATES[self.code]
        price = round(cfg["base_per_kg"] * max(chargeable_kg, 1), 2)
        if chargeable_kg > 100:
            price = round(price * float(cfg.get("volume_tier_pct", 0.94)), 2)
        return {
            "source": f"api:{self.code}",
            "partner": self.code,
            "route_summary": route_summary,
            "price": price,
            "currency": "RUB",
            "eta_days_min": cfg["eta"][0],
            "eta_days_max": cfg["eta"][1],
            "hidden_fees": cfg["fees"],
            "reliability_score": cfg["reliability"],
            "valid_until": (datetime.now(timezone.utc) + timedelta(hours=48)).isoformat(),
        }


class HttpPartnerAdapter:
    def __init__(self, code: str, base_url: str, api_key: str | None = None):
        self.code = code
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key

    def quote(self, chargeable_kg: float, route_summary: str) -> dict[str, Any]:
        headers = {}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        try:
            r = httpx.get(
                f"{self.base_url}/quote",
                params={"kg": chargeable_kg, "route": route_summary},
                headers=headers,
                timeout=12.0,
            )
            r.raise_for_status()
            data = r.json()
            return {
                "source": f"api:{self.code}",
                "partner": self.code,
                "route_summary": route_summary,
                "price": float(data["price"]),
                "currency": data.get("currency", "RUB"),
                "eta_days_min": data.get("eta_days_min"),
                "eta_days_max": data.get("eta_days_max"),
                "hidden_fees": data.get("hidden_fees", []),
                "reliability_score": float(data.get("reliability_score", 0.7)),
                "valid_until": data.get("valid_until")
                or (datetime.now(timezone.utc) + timedelta(hours=48)).isoformat(),
                "contact_email": data.get("contact_email"),
                "raw_http": data,
            }
        except Exception as e:
            return _error_quote(self.code, route_summary, e)


class JsonTariffFileAdapter:
    """Local partner tariff JSON: {base_per_kg, eta:[min,max], currency, fees, reliability}."""

    def __init__(self, code: str, path: Path):
        self.code = code
        self.path = path

    def quote(self, chargeable_kg: float, route_summary: str) -> dict[str, Any]:
        try:
            cfg = json.loads(self.path.read_text(encoding="utf-8"))
            per_kg = float(cfg.get("base_per_kg") or cfg.get("price_per_kg") or 0)
            price = round(per_kg * max(chargeable_kg, 1), 2)
            tiers = cfg.get("tiers") or []
            for t in sorted(tiers, key=lambda x: float(x.get("min_kg", 0)), reverse=True):
                if chargeable_kg >= float(t.get("min_kg", 0)):
                    price = round(float(t["per_kg"]) * max(chargeable_kg, 1), 2)
                    break
            eta = cfg.get("eta") or [10, 16]
            return {
                "source": f"file:{self.code}",
                "partner": self.code,
                "route_summary": route_summary,
                "price": price,
                "currency": cfg.get("currency", "RUB"),
                "eta_days_min": eta[0],
                "eta_days_max": eta[1] if len(eta) > 1 else eta[0],
                "hidden_fees": cfg.get("fees", []),
                "reliability_score": float(cfg.get("reliability", 0.7)),
                "valid_until": (datetime.now(timezone.utc) + timedelta(hours=48)).isoformat(),
                "contact_email": cfg.get("contact_email"),
            }
        except Exception as e:
            return _error_quote(self.code, route_summary, e)


class CdekPartnerAdapter:
    """CDEK API v2 calculator (international / tariff list)."""

    def __init__(self, account: str, secure: str, from_code: int = 44, to_code: int = 44):
        self.code = "cdek"
        self.account = account
        self.secure = secure
        self.from_code = int(os.getenv("PARTNER_CDEK_FROM_CODE", str(from_code)))
        self.to_code = int(os.getenv("PARTNER_CDEK_TO_CODE", str(to_code)))
        self.base = os.getenv("PARTNER_CDEK_BASE", "https://api.cdek.ru/v2").rstrip("/")

    def _token(self) -> str:
        r = httpx.post(
            f"{self.base}/oauth/token",
            data={
                "grant_type": "client_credentials",
                "client_id": self.account,
                "client_secret": self.secure,
            },
            timeout=12.0,
        )
        r.raise_for_status()
        return r.json()["access_token"]

    def quote(self, chargeable_kg: float, route_summary: str) -> dict[str, Any]:
        try:
            token = self._token()
            weight_g = int(max(chargeable_kg, 0.1) * 1000)
            payload = {
                "type": 1,
                "from_location": {"code": self.from_code},
                "to_location": {"code": self.to_code},
                "packages": [{"weight": weight_g, "length": 20, "width": 15, "height": 10}],
            }
            r = httpx.post(
                f"{self.base}/calculator/tarifflist",
                headers={"Authorization": f"Bearer {token}"},
                json=payload,
                timeout=15.0,
            )
            r.raise_for_status()
            data = r.json()
            tariffs = data.get("tariff_codes") or data.get("tariffs") or []
            if not tariffs:
                raise RuntimeError("cdek_no_tariffs")
            best = min(tariffs, key=lambda t: float(t.get("delivery_sum") or t.get("sum") or 1e12))
            price = float(best.get("delivery_sum") or best.get("sum") or 0)
            days_min = best.get("period_min") or best.get("calendar_min")
            days_max = best.get("period_max") or best.get("calendar_max")
            return {
                "source": "api:cdek",
                "partner": "cdek",
                "route_summary": route_summary,
                "price": price,
                "currency": "RUB",
                "eta_days_min": days_min,
                "eta_days_max": days_max,
                "hidden_fees": [],
                "reliability_score": 0.75,
                "valid_until": (datetime.now(timezone.utc) + timedelta(hours=24)).isoformat(),
                "raw_http": best,
            }
        except Exception as e:
            return _error_quote("cdek", route_summary, e)


def _error_quote(code: str, route_summary: str, e: Exception) -> dict[str, Any]:
    return {
        "source": f"api:{code}:error",
        "partner": code,
        "route_summary": route_summary,
        "price": 999999999,
        "currency": "RUB",
        "eta_days_min": 99,
        "eta_days_max": 99,
        "hidden_fees": [str(e)],
        "reliability_score": 0.0,
        "valid_until": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
        "error": str(e),
    }


def _db_http_adapters() -> list[QuoteAdapter]:
    adapters: list[QuoteAdapter] = []
    try:
        from common.db import db

        with db() as conn:
            rows = conn.execute(
                """
                SELECT code, api_base_url, metadata
                FROM partners
                WHERE active = TRUE
                  AND api_base_url IS NOT NULL
                  AND api_base_url LIKE 'http%%'
                """
            ).fetchall()
        for row in rows:
            code = str(row["code"] or "partner")
            meta = row.get("metadata") or {}
            key = None
            if isinstance(meta, dict):
                key = meta.get("api_key")
            key = key or os.getenv(f"PARTNER_KEY_{code.upper()}")
            adapters.append(HttpPartnerAdapter(code, str(row["api_base_url"]), key))
    except Exception:
        pass
    return adapters


def _json_tariff_adapters() -> list[QuoteAdapter]:
    root = Path(__file__).resolve().parents[2] / "data" / "partner_tariffs"
    if not root.exists():
        return []
    out: list[QuoteAdapter] = []
    for path in root.glob("*.json"):
        # Skip templates: example_*.json / *.example.json
        if path.stem.startswith("example") or path.name.endswith(".example.json"):
            continue
        out.append(JsonTariffFileAdapter(path.stem, path))
    return out


def all_adapters() -> list[QuoteAdapter]:
    adapters: list[QuoteAdapter] = []

    cdek_acc = os.getenv("PARTNER_CDEK_ACCOUNT") or ""
    cdek_sec = os.getenv("PARTNER_CDEK_SECURE") or ""
    if cdek_acc and cdek_sec:
        adapters.append(CdekPartnerAdapter(cdek_acc, cdek_sec))

    for code, url in os.environ.items():
        if code.startswith("PARTNER_HTTP_") and url.startswith("http"):
            partner_code = code.replace("PARTNER_HTTP_", "").lower()
            key = os.getenv(f"PARTNER_KEY_{partner_code.upper()}")
            adapters.append(HttpPartnerAdapter(partner_code, url, key))

    adapters.extend(_db_http_adapters())
    adapters.extend(_json_tariff_adapters())

    seen: set[str] = set()
    unique: list[QuoteAdapter] = []
    for a in adapters:
        if a.code in seen:
            continue
        seen.add(a.code)
        unique.append(a)

    if _allow_mock_rates():
        for code in MOCK_RATES:
            if code not in seen:
                unique.append(MockPartnerAdapter(code))
                seen.add(code)

    return unique
