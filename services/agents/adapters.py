"""Supplier rate adapters (HTTP, JSON tariffs + optional mock).

Groupage players (ПЭК, Деловые Линии, Байкал-Сервис) may be suppliers.
CDEK / Keycloak login URLs are not quote APIs.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Protocol

from agents.rates import MOCK_RATES
from agents.restrictions import NOT_SUPPLIERS


class QuoteAdapter(Protocol):
    code: str

    def quote(
        self,
        chargeable_kg: float,
        route_summary: str,
        ctx: dict[str, Any] | None = None,
    ) -> dict[str, Any]: ...


_LOGIN_URL_HINTS = (
    "/auth",
    "/login",
    "/signin",
    "keycloak",
    "/_dhl",
    "/account",
    "/cabinet",
)


def _is_quote_api_url(url: str) -> bool:
    low = (url or "").lower()
    if not low.startswith("http"):
        return False
    if any(h in low for h in _LOGIN_URL_HINTS):
        return False
    return (
        "/quote" in low
        or "/api" in low
        or "/v1/" in low
        or "/v2/" in low
        or "/lk/calc/fit" in low
        or "/offers/fit" in low
    )


def _allow_mock_rates() -> bool:
    from agents.rates import allow_mock_rates

    return allow_mock_rates()


def _tariff_matches(cfg: dict[str, Any], ctx: dict[str, Any] | None) -> bool:
    if not ctx:
        return True
    corridor = cfg.get("corridor")
    if corridor and ctx.get("corridor") and corridor != ctx.get("corridor"):
        return False
    modes = cfg.get("modes") or []
    mode = ctx.get("transport_mode")
    if modes and mode and mode not in modes:
        return False
    return True


class MockPartnerAdapter:
    def __init__(self, code: str):
        self.code = code

    def quote(
        self,
        chargeable_kg: float,
        route_summary: str,
        ctx: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
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

    def quote(
        self,
        chargeable_kg: float,
        route_summary: str,
        ctx: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        headers = {}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        params: dict[str, Any] = {"kg": chargeable_kg, "route": route_summary}
        if ctx:
            for key in ("corridor", "transport_mode", "cargo_class", "incoterms"):
                if ctx.get(key):
                    params[key] = ctx[key]
        try:
            from common.http_client import partner_get

            url = self.base_url
            if not url.lower().rstrip("/").endswith("/quote"):
                url = f"{self.base_url}/quote"
            r = partner_get(url, params=params, headers=headers)
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
    """Local partner tariff JSON with optional corridor / modes filter."""

    def __init__(self, code: str, path: Path):
        self.code = code
        self.path = path

    def quote(
        self,
        chargeable_kg: float,
        route_summary: str,
        ctx: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        try:
            cfg = json.loads(self.path.read_text(encoding="utf-8"))
            if not _tariff_matches(cfg, ctx):
                return {
                    **_error_quote(self.code, route_summary, RuntimeError("mode_mismatch")),
                    "error": "mode_mismatch",
                }
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
            code = str(row["code"] or "supplier")
            if code.lower() in NOT_SUPPLIERS:
                continue
            meta = row.get("metadata") or {}
            key = None
            if isinstance(meta, dict):
                key = meta.get("api_key")
            key = (
                key
                or os.getenv(f"SUPPLIER_KEY_{code.upper()}")
                or os.getenv(f"PARTNER_KEY_{code.upper()}")
            )
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
        if path.stem.startswith("example") or path.name.endswith(".example.json"):
            continue
        # PEK / ДЛ handled by carrier_adapters (lane-aware)
        if path.stem.startswith("pek") or path.stem.startswith("dellin"):
            continue
        out.append(JsonTariffFileAdapter(path.stem, path))
    return out


def all_adapters() -> list[QuoteAdapter]:
    adapters: list[QuoteAdapter] = []
    # CDEK is courier (not auto-RFQ). ПЭК/ДЛ/Байкал могут быть поставщиками сборки.
    from agents.carrier_adapters import build_carrier_adapters
    from agents.fesco_adapter import build_fesco_adapter

    adapters.extend(build_carrier_adapters())
    fesco = build_fesco_adapter()
    if fesco:
        adapters.append(fesco)

    for env_key, url in os.environ.items():
        supplier_code = None
        if env_key.startswith("SUPPLIER_HTTP_"):
            supplier_code = env_key.replace("SUPPLIER_HTTP_", "").lower()
        elif env_key.startswith("PARTNER_HTTP_"):
            supplier_code = env_key.replace("PARTNER_HTTP_", "").lower()
        if not supplier_code or not (url or "").startswith("http"):
            continue
        if supplier_code in NOT_SUPPLIERS:
            continue
        if supplier_code in ("pek", "dellin", "fesco"):
            continue  # dedicated adapters
        if not _is_quote_api_url(url):
            continue
        key = os.getenv(f"SUPPLIER_KEY_{supplier_code.upper()}") or os.getenv(
            f"PARTNER_KEY_{supplier_code.upper()}"
        )
        adapters.append(HttpPartnerAdapter(supplier_code, url, key))

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
