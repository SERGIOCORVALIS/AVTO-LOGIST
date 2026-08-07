"""FX rates + amount conversion to RUB for pricing / offers."""

from __future__ import annotations

import time
import xml.etree.ElementTree as ET
from typing import Any

import httpx

# Fallback static rates if network unavailable (update periodically)
_FALLBACK = {"RUB": 1.0, "USD": 90.0, "EUR": 98.0, "CNY": 12.5}
_cache: dict[str, Any] = {"ts": 0.0, "rates": dict(_FALLBACK), "source": "fallback"}


def _from_cbr() -> dict[str, float] | None:
    """Central Bank of Russia daily XML (RUB per unit)."""
    try:
        r = httpx.get("https://www.cbr.ru/scripts/XML_daily.asp", timeout=8.0)
        r.raise_for_status()
        root = ET.fromstring(r.content)
        rates = {"RUB": 1.0}
        for valute in root.findall("Valute"):
            char = (valute.findtext("CharCode") or "").upper()
            if char not in ("USD", "EUR", "CNY"):
                continue
            nominal = float((valute.findtext("Nominal") or "1").replace(",", "."))
            value = float((valute.findtext("Value") or "0").replace(",", "."))
            if nominal > 0 and value > 0:
                rates[char] = value / nominal
        if "USD" in rates and "EUR" in rates:
            return rates
    except Exception:
        return None
    return None


def _from_frankfurter() -> dict[str, float] | None:
    try:
        r = httpx.get(
            "https://api.frankfurter.app/latest",
            params={"from": "USD", "to": "RUB,EUR,CNY"},
            timeout=8.0,
        )
        r.raise_for_status()
        data = r.json()
        usd_rub = float(data["rates"]["RUB"])
        return {
            "RUB": 1.0,
            "USD": usd_rub,
            "EUR": usd_rub / float(data["rates"]["EUR"]),
            "CNY": usd_rub / float(data["rates"].get("CNY", usd_rub / 12.5)),
        }
    except Exception:
        return None


def get_rates_to_rub() -> dict[str, float]:
    """Return map currency -> RUB per 1 unit. Prefers CBR, then Frankfurter."""
    now = time.time()
    if now - float(_cache["ts"]) < 3600 and _cache["rates"]:
        return dict(_cache["rates"])

    for source, loader in (("cbr", _from_cbr), ("frankfurter", _from_frankfurter)):
        rates = loader()
        if rates and rates.get("USD"):
            _cache["ts"] = now
            _cache["rates"] = rates
            _cache["source"] = source
            return dict(rates)

    return dict(_FALLBACK)


def fx_source() -> str:
    return str(_cache.get("source") or "fallback")


def to_rub(amount: float, currency: str | None = "RUB") -> float:
    cur = (currency or "RUB").upper()
    rates = get_rates_to_rub()
    factor = rates.get(cur, rates["RUB"])
    return round(float(amount) * factor, 2)


def normalize_quote_price(quote: dict[str, Any]) -> dict[str, Any]:
    q = dict(quote)
    cur = (q.get("currency") or "RUB").upper()
    price = float(q.get("price") or 0)
    q["currency"] = cur
    q["price_rub"] = to_rub(price, cur)
    q["fx_rates"] = get_rates_to_rub()
    q["fx_source"] = fx_source()
    return q
