"""VAT-comparable supplier costs, margin/profit validator, payments and cashflow.

Russia: sell to client with VAT only.
Never compare a VAT-excluded supplier rate to a VAT-included one as equal sums.
International freight VAT is 0% but legs may differ — do not break the chain.
"""

from __future__ import annotations

from typing import Any

from agents.geography import DOMESTIC, is_international
from agents.tz_policy import merge_tz_policy

VAT_INCLUDED = "included"
VAT_EXCLUDED = "excluded"
VAT_ZERO = "zero"


def detect_vat_mode(quote: dict[str, Any] | None, corridor: str | None) -> str:
    q = quote or {}
    explicit = str(q.get("supplier_vat_mode") or q.get("vat_mode") or "").lower()
    if explicit in (VAT_INCLUDED, VAT_EXCLUDED, VAT_ZERO):
        return explicit
    blob = " ".join(
        str(x)
        for x in (
            q.get("vat_note"),
            q.get("notes"),
            " ".join(str(f) for f in (q.get("hidden_fees") or [])),
        )
        if x
    ).lower()
    if any(s in blob for s in ("без ндс", "без ндс", "ex vat", "excl. vat", "excluding vat", "w/o vat")):
        return VAT_EXCLUDED
    if any(s in blob for s in ("ндс 0", "vat 0", "zero vat", "ставка 0")):
        return VAT_ZERO
    if is_international(corridor) and corridor != DOMESTIC:
        return VAT_ZERO
    return VAT_INCLUDED


def effective_supplier_cost(
    raw: float,
    vat_mode: str,
    *,
    ru_vat_pct: float = 22,
    corridor: str | None = None,
) -> float:
    """Bring supplier quotes to a comparable tax base before ranking."""
    raw = float(raw or 0)
    if vat_mode == VAT_EXCLUDED:
        return round(raw * (1 + float(ru_vat_pct) / 100), 2)
    if vat_mode == VAT_ZERO:
        return round(raw, 2)
    return round(raw, 2)


def client_price_vat_mode(corridor: str | None) -> str:
    if corridor == DOMESTIC or not is_international(corridor):
        return VAT_INCLUDED
    return VAT_ZERO


def normalize_quote_tax(
    quote: dict[str, Any],
    *,
    corridor: str | None,
    policy: dict[str, Any] | None = None,
) -> dict[str, Any]:
    cfg = merge_tz_policy(policy)
    raw = float(quote.get("price_rub") or quote.get("price") or 0)
    mode = detect_vat_mode(quote, corridor)
    effective = effective_supplier_cost(
        raw, mode, ru_vat_pct=float(cfg["ru_vat_pct"]), corridor=corridor
    )
    out = dict(quote)
    out["raw_supplier_quote"] = round(raw, 2)
    out["supplier_vat_mode"] = mode
    out["effective_supplier_cost"] = effective
    out["client_price_vat_mode"] = client_price_vat_mode(corridor)
    return out


def price_offer(
    cost_total: float,
    policy: dict[str, Any],
    client_ask_discount_pct: float = 0,
) -> dict[str, Any]:
    cfg = merge_tz_policy(policy)
    target = float(cfg.get("target_margin_pct", 18))
    floor = float(cfg.get("floor_margin_pct", 10))
    max_disc = float(cfg.get("max_discount_pct", 8))
    min_profit = float(cfg.get("min_gross_profit_rub", 3000))

    offer = cost_total * (1 + target / 100)
    margin = target
    needs_approve = False
    reason = ""
    margin_path = [
        "check_comparability",
        "handle_objection",
        "negotiate_supplier",
        "new_supplier",
        "new_scheme",
        "then_reduce_margin",
    ]

    disc = min(max(client_ask_discount_pct, 0), max_disc + 5)
    if disc:
        offer = offer * (1 - disc / 100)
        margin = (offer - cost_total) / offer * 100 if offer else 0

    if margin < floor:
        needs_approve = True
        reason = f"margin {margin:.1f}% < floor {floor}%"
        offer = cost_total / (1 - floor / 100) if floor < 100 else cost_total
        margin = floor

    if disc > max_disc:
        needs_approve = True
        reason = f"discount {disc}% > max {max_disc}%"

    gross = offer - cost_total
    if gross < min_profit:
        needs_approve = True
        extra = f"gross_profit {gross:.0f} ₽ < min {min_profit:.0f} ₽"
        reason = f"{reason}; {extra}" if reason else extra

    steps = []
    for s in (0, 3, 5, min(disc, max_disc)):
        p = cost_total * (1 + target / 100) * (1 - s / 100)
        m = (p - cost_total) / p * 100 if p else 0
        gp = p - cost_total
        if m >= floor and gp >= min_profit:
            steps.append(
                {
                    "discount_pct": s,
                    "price": round(p, 2),
                    "margin_pct": round(m, 2),
                    "gross_profit_rub": round(gp, 2),
                }
            )

    return {
        "offer_price": round(offer, 2),
        "margin_pct": round(margin, 2),
        "gross_profit_rub": round(gross, 2),
        "discount_steps": steps,
        "needs_approve": needs_approve,
        "reason": reason,
        "cost_total": round(cost_total, 2),
        "margin_reduction_path": margin_path,
        "client_price_vat_mode": client_price_vat_mode(
            str((policy or {}).get("corridor") or "")
        ),
    }


def validate_economics(
    *,
    cost_total: float,
    offer_price: float,
    corridor: str | None,
    policy: dict[str, Any] | None = None,
    client_prepay_pct: float | None = None,
    supplier_prepay_pct: float | None = None,
) -> dict[str, Any]:
    cfg = merge_tz_policy(policy)
    margin = (offer_price - cost_total) / offer_price * 100 if offer_price else 0
    profit = offer_price - cost_total
    issues: list[str] = []
    escalate = False
    if margin + 1e-9 < float(cfg["floor_margin_pct"]):
        issues.append("margin_below_floor")
        escalate = True
    if profit < float(cfg["min_gross_profit_rub"]):
        issues.append("profit_below_minimum")
        escalate = True
    if corridor == DOMESTIC or not is_international(corridor):
        if str(cfg.get("client_ru_sells_with_vat")) in ("True", "true", "1") or cfg.get(
            "client_ru_sells_with_vat"
        ):
            pass
    cashflow = assess_cashflow(
        offer_price,
        client_prepay_pct=client_prepay_pct,
        supplier_prepay_pct=supplier_prepay_pct,
        policy=cfg,
    )
    if cashflow.get("gap"):
        issues.append("cashflow_gap")
        escalate = True
    return {
        "margin_pct": round(margin, 2),
        "gross_profit_rub": round(profit, 2),
        "issues": issues,
        "needs_human": escalate,
        "cashflow": cashflow,
        "ok": not escalate,
    }


def assess_cashflow(
    amount_rub: float,
    *,
    client_prepay_pct: float | None = None,
    supplier_prepay_pct: float | None = None,
    policy: dict[str, Any] | None = None,
) -> dict[str, Any]:
    cfg = merge_tz_policy(policy)
    preferred = float(cfg["prepay_preferred_pct"])
    min_under = float(cfg["prepay_min_pct_under_1m"])
    staged_from = float(cfg["staged_payment_threshold_rub"])
    client_pct = preferred if client_prepay_pct is None else float(client_prepay_pct)
    supplier_pct = preferred if supplier_prepay_pct is None else float(supplier_prepay_pct)
    notes: list[str] = ["стремимся к 100% предоплате", "TRANSINVEST не финансирует перевозку своими деньгами"]
    if amount_rub <= staged_from:
        notes.append(f"до {staged_from:.0f} ₽ допустимо {min_under:.0f}–{preferred:.0f}%, предпочтительно 100%")
    else:
        notes.append("свыше 1 млн возможна поэтапная оплата")
    gap = client_pct + 1e-9 < supplier_pct
    if gap:
        notes.append("кассовый разрыв: согласовать этапность с поставщиком, не закрывать своими деньгами")
    return {
        "client_prepay_pct": client_pct,
        "supplier_prepay_pct": supplier_pct,
        "gap": gap,
        "staged_ok": amount_rub > staged_from,
        "notes": notes,
    }


def buyout_economics(goods_cny: float, fx_cny_rub: float, policy: dict[str, Any] | None = None) -> dict[str, Any]:
    cfg = merge_tz_policy(policy)
    commission = float(cfg["buyout_commission_pct"]) / 100
    markup = float(cfg["buyout_fx_markup_rub"])
    client_rate = fx_cny_rub + markup
    goods_rub = goods_cny * client_rate
    fee = goods_rub * commission
    return {
        "supplier_currency": "CNY",
        "client_currency": "RUB",
        "fx_client": client_rate,
        "commission_pct": float(cfg["buyout_commission_pct"]),
        "commission_rub": round(fee, 2),
        "goods_rub": round(goods_rub, 2),
        "invoice_packing_list_required": False,
        "sequence": ["сначала деньги клиента на товар", "после готовности — логистика, таможня и остальные этапы"],
    }


def certification_client_price(partner_cost: float, policy: dict[str, Any] | None = None) -> float:
    cfg = merge_tz_policy(policy)
    return round(float(partner_cost) * (1 + float(cfg["certification_markup_pct"]) / 100), 2)


def broker_client_price(policy: dict[str, Any] | None = None) -> dict[str, float]:
    cfg = merge_tz_policy(policy)
    return {
        "broker_cost_rub": float(cfg["broker_cost_rub"]),
        "client_price_rub": float(cfg["broker_client_price_rub"]),
    }
