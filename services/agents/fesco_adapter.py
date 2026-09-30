"""FESCO FIT live rates via MY.FESCO / api.fesco.com calculator API.

Public FIT flow (same as my.fesco.com calculator JS):
  GET  {calc}/from?date=DD-MM-YYYY
  GET  {calc}/to?date=...&from=...
  GET  {calc}/wte?date=...&from=...&to=...
  GET  {offers}?date=YYYY-MM-DD&from=...&to=...&wte=...&co=COC|SOC

Env:
  PARTNER_HTTP_FESCO / FESCO_API_BASE — calc base (default api.fesco.com .../calc/fit) 
  FESCO_OFFERS_URL — offers endpoint (default my.fesco.com .../offers/fit)
  PARTNER_KEY_FESCO — optional Bearer (public FIT often works without it)
  FESCO_OWNER — COC (default) or SOC
  FESCO_HTTP_PROXY — optional SOCKS/HTTP proxy if host TLS to FESCO is blocked
  FESCO_HTTP_PROXY_FALLBACK — comma-separated extra proxies to try on disconnect
"""

from __future__ import annotations

import os
import re
from datetime import date, datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlencode, urlsplit, urlunsplit

from common.http_client import partner_get, partner_ssl_verify, partner_http_timeout as partner_http_timeout_seconds


DEFAULT_CALC = "https://api.fesco.com/api/v1/lk/calc/fit"
DEFAULT_OFFERS = "https://my.fesco.com/api/v2/lk/offers/fit"

_CITY_ALIASES = {
    "moscow": ("москва", "moscow", "msk"),
    "vladivostok": ("владивосток", "vladivostok"),
    "korsakov": ("корсаков", "korsakov"),
    "spb": ("санкт-петербург", "saint petersburg", "st petersburg", "спб", "petersburg"), 
    "novosibirsk": ("новосибирск", "novosibirsk"),
    "yekaterinburg": ("екатеринбург", "yekaterinburg", "ekaterinburg"),
    "khabarovsk": ("хабаровск", "khabarovsk"),
    "nakhodka": ("находка", "nakhodka"),
    "vrangel": ("врангель", "vrangel"),
}


def _env(name: str, default: str = "") -> str:
    return (os.getenv(name) or default).strip()


def fesco_calc_base() -> str:
    return (
        _env("FESCO_API_BASE")
        or _env("PARTNER_HTTP_FESCO")
        or _env("SUPPLIER_HTTP_FESCO")
        or DEFAULT_CALC
    ).rstrip("/")


def fesco_offers_url() -> str:
    return (_env("FESCO_OFFERS_URL") or DEFAULT_OFFERS).rstrip("?&")


def fesco_owner() -> str:
    raw = (_env("FESCO_OWNER") or "COC").upper()
    return raw if raw in ("COC", "SOC") else "COC"


def _api_key() -> str | None:
    key = _env("PARTNER_KEY_FESCO") or _env("SUPPLIER_KEY_FESCO")
    return key or None


def _headers() -> dict[str, str]:
    h = {
        "Accept": "application/json",
        "Cache-Control": "no-cache",
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
        ),
        "Referer": "https://my.fesco.com/",
        "Origin": "https://my.fesco.com",
    }
    key = _api_key()
    if key:
        h["Authorization"] = f"Bearer {key}"
    return h


def _normalize_proxy(url: str) -> str:
    """Prefer socks5h (remote DNS) — socks5 often breaks TLS to Russian operator APIs."""
    raw = (url or "").strip()
    if not raw:
        return raw
    parts = urlsplit(raw)
    scheme = (parts.scheme or "").lower()
    if scheme == "socks5":
        return urlunsplit(("socks5h", parts.netloc, parts.path, parts.query, parts.fragment))
    return raw


def _proxy() -> str | None:
    for name in ("FESCO_HTTP_PROXY", "HTTPS_PROXY", "HTTP_PROXY"):
        raw = _env(name)
        if raw:
            return _normalize_proxy(raw)
    return None


def _proxy_candidates() -> list[str | None]:
    """Primary + fallbacks. None = direct (no proxy) as last resort."""
    out: list[str | None] = []
    seen: set[str] = set()

    def add(raw: str | None) -> None:
        if raw is None:
            if None not in out:
                out.append(None)
            return
        norm = _normalize_proxy(raw)
        if not norm or norm in seen:
            return
        seen.add(norm)
        out.append(norm)
        # Also keep original socks5 form if different (some exits only accept it).
        if raw.strip() != norm and raw.strip() not in seen:
            seen.add(raw.strip())
            out.append(raw.strip())

    add(_env("FESCO_HTTP_PROXY") or _env("HTTPS_PROXY") or _env("HTTP_PROXY") or None)
    for part in (_env("FESCO_HTTP_PROXY_FALLBACK") or "").split(","):
        add(part.strip() or None)
    # Direct last — usually blocked from RU residential, but cheap to try once.
    add(None)
    return out or [None]


def _get(url: str, **kwargs) -> Any:
    """GET with proxy fallbacks + short retries — FESCO often drops mid-FIT / blocks exits."""
    import time

    last_exc: Exception | None = None
    candidates = _proxy_candidates()
    for proxy in candidates:
        opts = dict(kwargs)
        if proxy:
            opts["proxy"] = proxy
        else:
            opts.pop("proxy", None)
        for attempt in range(3):
            try:
                return partner_get(url, headers=_headers(), **opts)
            except Exception as exc:
                last_exc = exc
                msg = str(exc).lower()
                transient = any(
                    t in msg
                    for t in (
                        "disconnected",
                        "timeout",
                        "timed out",
                        "connection reset",
                        "eof",
                        "proxy",
                        "connect",
                        "protocol",
                        "ssl",
                    )
                ) or any(
                    x in type(exc).__name__
                    for x in (
                        "ConnectError",
                        "RemoteProtocolError",
                        "ReadTimeout",
                        "WriteTimeout",
                        "ConnectTimeout",
                        "ProxyError",
                    )
                )
                if not transient or attempt >= 2:
                    break
                time.sleep(0.6 * (attempt + 1))
        # Next proxy candidate
    assert last_exc is not None
    raise last_exc


def _date_dmy(d: date | None = None) -> str:
    d = d or (date.today() + timedelta(days=5))
    return d.strftime("%d-%m-%Y")


def _date_ymd(d: date | None = None) -> str:
    d = d or (date.today() + timedelta(days=5))
    return d.strftime("%Y-%m-%d")


def _cities_from_route(route_summary: str) -> tuple[str, str]:
    parts = re.split(r"\s*→\s*|\s*->\s*", route_summary or "", maxsplit=1)
    origin = (parts[0] if parts else "").split("(")[0].strip().lower()
    dest = (parts[1] if len(parts) > 1 else "").split("(")[0].strip().lower()
    return origin, dest


def _norm_list(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [x for x in payload if isinstance(x, dict)]
    if not isinstance(payload, dict):
        return []
    for key in ("data", "result", "locations", "containers"):
        val = payload.get(key)
        if isinstance(val, list):
            return [x for x in val if isinstance(x, dict)]
    return []


def _loc_label(loc: dict[str, Any]) -> str:
    name = str(loc.get("name") or loc.get("title") or loc.get("locationName") or "")
    latin = str(loc.get("nameLatin") or "")
    city = str(loc.get("city") or loc.get("cityName") or "")
    country = str(loc.get("country") or loc.get("countryName") or "")
    return " ".join(p for p in (city, name, latin, country) if p).lower()


def _match_location(locations: list[dict[str, Any]], needle: str) -> dict[str, Any] | None:
    n = (needle or "").strip().lower()
    if not n or not locations:
        return None
    aliases = [n]
    for group in _CITY_ALIASES.values():
        if any(a in n or n in a for a in group):
            aliases.extend(group)
            break

    scored: list[tuple[int, dict[str, Any]]] = []
    for loc in locations:
        label = _loc_label(loc)
        if not label:
            continue
        score = 0
        for a in aliases:
            if a and a in label:
                score = max(score, len(a))
        if score:
            scored.append((score, loc))
    if not scored:
        return None
    scored.sort(key=lambda x: x[0], reverse=True)
    return scored[0][1]


def _loc_id(loc: dict[str, Any] | None) -> str | None:
    if not loc:
        return None
    raw = loc.get("id") or loc.get("uuid") or loc.get("code")
    return str(raw) if raw is not None else None


def _pick_wte(containers: list[dict[str, Any]], ctx: dict[str, Any] | None) -> dict[str, Any] | None:
    if not containers:
        return None
    prefer = []
    cargo = str((ctx or {}).get("cargo_summary") or (ctx or {}).get("cargo_name") or "").lower()
    mode = str((ctx or {}).get("transport_mode") or "").lower()
    if "40" in cargo or "40ft" in cargo or "40'" in cargo or "hc" in cargo:
        prefer.extend(["40", "hc", "hq"])
    elif "20" in cargo:
        prefer.append("20")
    else:
        prefer.extend(["40", "20"])

    def label(c: dict[str, Any]) -> str:
        return " ".join(
            str(c.get(k) or "")
            for k in (
                "name",
                "nameLatin",
                "ContainerName",
                "ContainerNameEng",
                "title",
                "description",
                "size",
                "type",
                "code",
            )
        ).lower()

    for token in prefer:
        for c in containers:
            if token in label(c):
                return c
    return containers[0]


def _wte_id(c: dict[str, Any] | None) -> str | None:
    if not c:
        return None
    raw = c.get("id") or c.get("uuid") or c.get("code") or c.get("wte")
    return str(raw) if raw is not None else None


def _rub_from_cont_prices(items: list[Any]) -> tuple[float, str]:
    """Sum ContPrice-like rows; convert non-RUB via FX."""
    from common.fx import to_rub

    total_rub = 0.0
    currencies: set[str] = set()
    for cp in items:
        if not isinstance(cp, dict):
            continue
        cur = str(cp.get("Currency") or "RUB").upper()
        price = float(cp.get("Price") or 0)
        if not price:
            continue
        currencies.add(cur)
        if cur in ("RUB", "RUR"):
            total_rub += price
        else:
            total_rub += float(to_rub(price, cur))
    if not total_rub:
        return 0.0, "RUB"
    return round(total_rub, 2), ("RUB" if len(currencies) != 1 else next(iter(currencies)))


def _offer_total_rub(offer: dict[str, Any]) -> float:
    # Prefer segment container prices (main haul)
    segs = offer.get("Segments") or []
    cont_prices: list[Any] = []
    for seg in segs if isinstance(segs, list) else []:
        for cont in seg.get("Containers") or []:
            if isinstance(cont, dict) and cont.get("Price") is not None:
                cont_prices.append(
                    {"Currency": cont.get("Currency") or "RUB", "Price": cont.get("Price")}
                )
    if cont_prices:
        total, _ = _rub_from_cont_prices(cont_prices)
        if total > 0:
            return total

    # Fallback: default / included services ContPrice
    for svc in offer.get("Services") or []:
        if not isinstance(svc, dict):
            continue
        if svc.get("Default") or svc.get("InclMainServicePrice"):
            total, _ = _rub_from_cont_prices(list(svc.get("ContPrice") or []))
            if total > 0:
                return total
    # Last resort: sum all ContPrice on services
    all_cp: list[Any] = []
    for svc in offer.get("Services") or []:
        if isinstance(svc, dict):
            all_cp.extend(svc.get("ContPrice") or [])
    total, _ = _rub_from_cont_prices(all_cp)
    return total


def _error(route_summary: str, err: Exception | str) -> dict[str, Any]:
    from agents.adapters import _error_quote

    e = err if isinstance(err, Exception) else RuntimeError(str(err))
    q = _error_quote("fesco", route_summary, e)
    q["partner"] = "fesco"
    q["source"] = "api:fesco:error"
    return q


class FescoFitAdapter:
    """Live FESCO FIT calculator rates for container corridors."""

    code = "fesco"

    def quote(
        self,
        chargeable_kg: float,
        route_summary: str,
        ctx: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        calc = fesco_calc_base()
        # Login /auth URL is not FIT API — rewrite to default calc base.
        low = calc.lower()
        if "/auth" in low or "lk/calc/fit" not in low:
            if low.rstrip("/").endswith("my.fesco.com") or "my.fesco.com/auth" in low:
                calc = DEFAULT_CALC
            elif "api.fesco.com" in low and "/calc/fit" not in low:
                calc = DEFAULT_CALC
            elif "/auth" in low:
                calc = DEFAULT_CALC

        ship_date = date.today() + timedelta(days=5)
        ready = (ctx or {}).get("ready_date")
        if ready:
            try:
                ship_date = date.fromisoformat(str(ready)[:10])
            except ValueError:
                pass

        dmy = _date_dmy(ship_date)
        ymd = _date_ymd(ship_date)
        origin, dest = _cities_from_route(route_summary)
        if ctx:
            origin = str(ctx.get("origin_city") or origin).lower()
            dest = str(ctx.get("destination_city") or dest).lower()

        try:
            from_resp = _get(f"{calc}/from?{urlencode({'date': dmy})}")
            from_resp.raise_for_status()
            from_locs = _norm_list(from_resp.json())
            from_loc = _match_location(from_locs, origin)
            from_id = _loc_id(from_loc)
            if not from_id:
                return _error(
                    route_summary,
                    f"fesco_from_not_found:{origin or '?'} (got {len(from_locs)} locs)",
                )

            to_resp = _get(
                f"{calc}/to?{urlencode({'date': dmy, 'from': from_id})}"
            )
            to_resp.raise_for_status()
            to_locs = _norm_list(to_resp.json())
            to_loc = _match_location(to_locs, dest)
            to_id = _loc_id(to_loc)
            if not to_id:
                return _error(
                    route_summary,
                    f"fesco_to_not_found:{dest or '?'} (got {len(to_locs)} locs)",
                )

            wte_resp = _get(
                f"{calc}/wte?{urlencode({'date': dmy, 'from': from_id, 'to': to_id})}"
            )
            wte_resp.raise_for_status()
            containers = _norm_list(wte_resp.json())
            wte = _pick_wte(containers, ctx)
            wte_id = _wte_id(wte)
            if not wte_id:
                return _error(route_summary, "fesco_wte_empty")

            owner = fesco_owner()
            offers_base = fesco_offers_url()
            qs = urlencode(
                {
                    "date": ymd,
                    "from": from_id,
                    "to": to_id,
                    "wte": wte_id,
                    "co": owner,
                }
            )
            offers_resp = _get(f"{offers_base}?{qs}")
            offers_resp.raise_for_status()
            raw = offers_resp.json()
            rows = raw.get("data") if isinstance(raw, dict) else None
            if not isinstance(rows, list) or not rows:
                return _error(route_summary, "fesco_no_offers")

            priced: list[tuple[float, dict[str, Any]]] = []
            for row in rows:
                if not isinstance(row, dict):
                    continue
                total = _offer_total_rub(row)
                if total > 0:
                    priced.append((total, row))
            if not priced:
                return _error(route_summary, "fesco_offers_without_price")

            priced.sort(key=lambda x: x[0])
            best_price, best = priced[0]
            valid_to = best.get("DateTo") or best.get("validTo")
            valid_until = None
            if valid_to:
                try:
                    valid_until = (
                        datetime.fromisoformat(str(valid_to).replace("Z", "+00:00"))
                        .astimezone(timezone.utc)
                        .isoformat()
                    )
                except Exception:
                    valid_until = None
            if not valid_until:
                valid_until = (datetime.now(timezone.utc) + timedelta(hours=48)).isoformat()

            return {
                "source": "api:fesco",
                "partner": "fesco",
                "route_summary": route_summary,
                "price": best_price,
                "currency": "RUB",
                "eta_days_min": None,
                "eta_days_max": None,
                "hidden_fees": [],
                "reliability_score": 0.85,
                "valid_until": valid_until,
                "contact_email": None,
                "raw_http": {
                    "from_id": from_id,
                    "to_id": to_id,
                    "wte_id": wte_id,
                    "owner": owner,
                    "offers_count": len(rows),
                    "best_route_id": best.get("RouteID") or best.get("RouteVariantID"),
                    "ssl_verify": partner_ssl_verify(),
                    "timeout": str(partner_http_timeout_seconds()),
                },
            }
        except Exception as e:
            msg = str(e)
            low = msg.lower()
            if (
                "unexpected_eof" in low
                or "ssl" in low
                or "disconnected" in low
                or "timed out" in low
                or "timeout" in low
                or "ConnectError" in type(e).__name__
                or "RemoteProtocolError" in type(e).__name__
                or "ConnectTimeout" in type(e).__name__
            ):
                return _error(
                    route_summary,
                    RuntimeError(
                        "fesco_tls_blocked: direct TLS to api.fesco.com/my.fesco.com failed; "
                        "set FESCO_HTTP_PROXY (or FESCO_HTTP_PROXY_FALLBACK) to an exit that "
                        "FESCO does not drop — current PROXY6 exit is often blocked"
                    ),
                )
            return _error(route_summary, e)


def build_fesco_adapter() -> FescoFitAdapter | None:
    """Register when FESCO key or HTTP base is configured."""
    if _api_key() or _env("PARTNER_HTTP_FESCO") or _env("FESCO_API_BASE") or _env(
        "CABINET_HTTP_FESCO"
    ):
        return FescoFitAdapter()
    return None
