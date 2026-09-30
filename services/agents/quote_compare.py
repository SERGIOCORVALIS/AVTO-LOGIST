"""Compare supplier quotes for staff (station–port / PSZhVS ranking)."""

from __future__ import annotations

from typing import Any


def _price_key(q: dict[str, Any]) -> float:
    for k in ("effective_supplier_cost", "price", "amount_rub", "amount"):
        v = q.get(k)
        if v is None:
            continue
        try:
            return float(v)
        except (TypeError, ValueError):
            continue
    return float("inf")


def rank_quotes(quotes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ranked = sorted(quotes or [], key=_price_key)
    out: list[dict[str, Any]] = []
    for i, q in enumerate(ranked, 1):
        row = dict(q)
        row["rank"] = i
        row["_sort_price"] = _price_key(q)
        out.append(row)
    return out


def format_quote_compare(
    deal_id: str,
    quotes: list[dict[str, Any]],
    *,
    scheme: str | None = None,
    route_summary: str | None = None,
    compare_kind: str = "generic",
) -> str:
    ranked = rank_quotes(quotes)
    lines = [
        "📊 Сравнение ставок поставщиков",
        f"Сделка: {deal_id}",
    ]
    if scheme:
        lines.append(f"Схема: {scheme}")
    if route_summary:
        lines.append(f"Маршрут: {route_summary}")
    if compare_kind == "station_port":
        lines.append("Тип: станция–порт (ПСЖВС) — ниже = дешевле на плече.")
    lines.append("")
    if not ranked:
        lines.append("Ставок пока нет — ждём ответы на RFQ.")
        return "\n".join(lines)

    for q in ranked:
        price = q.get("_sort_price")
        price_s = f"{price:,.0f}".replace(",", " ") if price != float("inf") else "—"
        cur = q.get("currency") or "RUB"
        partner = (
            q.get("partner")
            or q.get("source")
            or (
                (q.get("raw") or {}).get("from")
                if isinstance(q.get("raw"), dict)
                else None
            )
            or "—"
        )
        eta = ""
        if q.get("eta_days_min") is not None:
            eta = f", ETA {q.get('eta_days_min')}"
            if q.get("eta_days_max") is not None:
                eta += f"–{q.get('eta_days_max')} дн"
            else:
                eta += " дн"
        lines.append(f"{q['rank']}. {partner}: {price_s} {cur}{eta}")

    best = ranked[0]
    if best.get("_sort_price") != float("inf"):
        lines.append("")
        lines.append(
            f"Лидер: {best.get('partner') or best.get('source') or '—'} "
            f"@ {best['_sort_price']:,.0f} {best.get('currency') or 'RUB'}".replace(",", " ")
        )
    lines.append(f"Команда: /deal {deal_id}")
    return "\n".join(lines)


def compare_deal_quotes(deal_id: str) -> dict[str, Any]:
    from agents.schemes import resolve_scheme_defaults
    from common.db import get_deal, list_deal_quotes

    deal = get_deal(deal_id)
    if not deal:
        return {"ok": False, "error": "deal_not_found"}
    quotes = list_deal_quotes(deal_id, limit=40)
    route = deal.get("route") if isinstance(deal.get("route"), dict) else {}
    meta = deal.get("metadata") if isinstance(deal.get("metadata"), dict) else {}
    scheme = meta.get("scheme") or route.get("scheme")
    resolved = resolve_scheme_defaults(
        scheme=scheme,
        transport_mode=route.get("transport_mode"),
        corridor=route.get("corridor"),
        preferred=meta.get("preferred_operators"),
    )
    route_summary = " → ".join(
        p
        for p in (
            route.get("origin_city") or route.get("pickup_city"),
            route.get("destination_city"),
        )
        if p
    )
    text = format_quote_compare(
        deal_id,
        quotes,
        scheme=resolved.get("label") or scheme,
        route_summary=route_summary or None,
        compare_kind=str(resolved.get("compare") or "generic"),
    )
    ranked = rank_quotes(quotes)
    return {
        "ok": True,
        "deal_id": deal_id,
        "count": len(ranked),
        "text": text,
        "best": ranked[0] if ranked else None,
        "scheme_id": resolved.get("scheme_id"),
    }
