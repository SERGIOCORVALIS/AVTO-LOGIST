"""Customs clearance estimator: duty (пошлина) + VAT (НДС) + broker + optional excise.

Simplified EAEU/RF import model for commercial estimates (not a substitute for a broker):

  customs_value_rub  ≈ invoice value converted to RUB
                       (+ optional freight share if include_freight_in_cv=True)
  duty_rub           = customs_value_rub * duty_pct / 100
  excise_rub         = ... (0 by default unless flagged)
  vat_base           = customs_value_rub + duty_rub + excise_rub
  vat_rub            = vat_base * vat_pct / 100   # RF default 20%
  broker_fee_rub     = max(min_broker, customs_value_rub * broker_pct/100)
  clearance_total    = duty + vat + excise + broker + cert_fees

All amounts are preliminary; client must see disclaimer until invoice/HS confirmed.
"""

from __future__ import annotations

from typing import Any

from common.fx import to_rub

# Default RF import VAT
DEFAULT_VAT_PCT = 20.0

# Rough HS / category duty bands for heuristic (provisional %)
CATEGORY_DUTY_PCT: dict[str, float] = {
    "powerbank": 5.0,
    "electronics": 5.0,
    "textile": 10.0,
    "general": 5.0,
    "furniture": 10.0,
    "toys": 8.0,
    "cosmetics": 6.5,
}

DEFAULT_BROKER_PCT = 0.35  # of customs value
MIN_BROKER_FEE_RUB = 8_000.0
CERT_FEE_BATTERY_RUB = 15_000.0


def _infer_duty_pct(
    cargo: dict[str, Any], hs_candidates: list[dict[str, Any]]
) -> tuple[float, str, float | None, bool]:
    """Return (duty_pct, source, vat_pct|None, heuristic_fallback)."""
    # 1) Official DB feed by HS code
    try:
        from common.db import lookup_hs_duty

        for hs in hs_candidates or []:
            code = hs.get("code")
            row = lookup_hs_duty(str(code) if code else None)
            if row:
                return (
                    float(row["duty_pct"]),
                    f"db:{row['hs_code']}:{row.get('source')}",
                    float(row.get("vat_pct") or DEFAULT_VAT_PCT),
                    False,
                )
    except Exception:
        pass

    # 2) Rate attached on HS candidate (DeepSeek / feed merge)
    for hs in hs_candidates or []:
        rate = hs.get("duty_rate")
        if isinstance(rate, (int, float)):
            return float(rate), f"hs:{hs.get('code')}", None, False
        if isinstance(rate, str):
            cleaned = rate.replace("%", "").replace(",", ".").strip()
            try:
                return float(cleaned), f"hs:{hs.get('code')}", None, False
            except ValueError:
                pass

    # 3) Category band — last resort, requires broker approve
    cat = (cargo.get("category") or "general").lower()
    name = (cargo.get("name") or "").lower()
    if "powerbank" in name or "пауэр" in name or "аккумул" in name:
        cat = "powerbank"
    return (
        CATEGORY_DUTY_PCT.get(cat, CATEGORY_DUTY_PCT["general"]),
        f"heuristic_fallback:category:{cat}",
        None,
        True,
    )


def resolve_invoice_value_rub(cargo: dict[str, Any], deal: dict[str, Any] | None = None) -> tuple[float | None, str]:
    """Extract invoice / declared value and convert to RUB."""
    deal = deal or {}
    # explicit fields
    for key in ("invoice_value_rub", "customs_value_rub", "declared_value_rub"):
        if cargo.get(key) is not None:
            return float(cargo[key]), key
    if cargo.get("invoice_value") is not None:
        cur = (cargo.get("invoice_currency") or cargo.get("currency") or "USD").upper()
        return to_rub(float(cargo["invoice_value"]), cur), f"invoice_value:{cur}"
    # metadata
    meta = deal.get("metadata") or {}
    if isinstance(meta, dict) and meta.get("invoice_value") is not None:
        cur = (meta.get("invoice_currency") or "USD").upper()
        return to_rub(float(meta["invoice_value"]), cur), f"metadata:{cur}"
    return None, "missing"


def compute_customs_clearance(
    deal: dict[str, Any],
    legal: dict[str, Any] | None = None,
    freight_rub: float = 0.0,
    *,
    include_freight_in_cv: bool = False,
) -> dict[str, Any]:
    """Return structured duties_estimate + totals suitable for cost_breakdown."""
    legal = legal or {}
    cargo = deal.get("cargo") or {}
    hs = legal.get("hs_candidates") or []

    invoice_rub, value_source = resolve_invoice_value_rub(cargo, deal)
    missing_invoice = invoice_rub is None or invoice_rub <= 0

    # If DeepSeek already returned numeric estimate — prefer / merge
    existing = legal.get("duties_estimate") or {}
    if isinstance(existing, dict) and existing.get("vat_rub") is not None and existing.get("duty_rub") is not None:
        total = float(existing.get("clearance_total_rub") or 0)
        if total <= 0:
            total = (
                float(existing.get("duty_rub") or 0)
                + float(existing.get("vat_rub") or 0)
                + float(existing.get("excise_rub") or 0)
                + float(existing.get("broker_fee_rub") or 0)
                + float(existing.get("cert_fee_rub") or 0)
            )
        return {
            **existing,
            "clearance_total_rub": round(total, 2),
            "source": existing.get("source", "legal_model"),
            "is_estimate": True,
            "missing_invoice": bool(existing.get("missing_invoice", False)),
        }

    duty_pct, duty_src, vat_from_db, heuristic_fb = _infer_duty_pct(cargo, hs)
    vat_pct = float(
        vat_from_db
        if vat_from_db is not None
        else (existing.get("vat_pct") or DEFAULT_VAT_PCT)
    )
    excise_rub = float(existing.get("excise_rub") or 0)

    battery = bool(cargo.get("battery")) or any(
        x in (cargo.get("name") or "").lower() for x in ("powerbank", "пауэр", "аккумул", "li-ion", "литий")
    )
    cert_fee = float(existing.get("cert_fee_rub") or (CERT_FEE_BATTERY_RUB if battery else 0))

    if missing_invoice:
        return {
            "customs_value_rub": None,
            "invoice_value_rub": None,
            "value_source": value_source,
            "duty_pct": duty_pct,
            "duty_rub": None,
            "vat_pct": vat_pct,
            "vat_rub": None,
            "excise_rub": excise_rub or 0,
            "broker_fee_rub": MIN_BROKER_FEE_RUB,
            "cert_fee_rub": cert_fee,
            "clearance_total_rub": round(MIN_BROKER_FEE_RUB + cert_fee, 2),
            "missing_invoice": True,
            "is_estimate": True,
            "preliminary": True,
            "must_approve": True if heuristic_fb else False,
            "disclaimer": (
                "Нет суммы инвойса — пошлина и НДС не рассчитаны. "
                "В КП заложены только брокер/сертификация; пошлина+НДС — после инвойса."
            ),
            "duty_source": duty_src,
            "formula": "vat=(CV+duty+excise)*vat_pct; duty=CV*duty_pct",
            "source": "pending_invoice",
        }

    cv = float(invoice_rub)
    if include_freight_in_cv and freight_rub:
        cv = cv + float(freight_rub) * 0.3

    duty_rub = round(cv * duty_pct / 100.0, 2)
    vat_base = cv + duty_rub + excise_rub
    vat_rub = round(vat_base * vat_pct / 100.0, 2)
    broker = max(MIN_BROKER_FEE_RUB, round(cv * DEFAULT_BROKER_PCT / 100.0, 2))
    clearance = round(duty_rub + vat_rub + excise_rub + broker + cert_fee, 2)
    src = "db_hs_feed" if duty_src.startswith("db:") else (
        "heuristic_fallback" if heuristic_fb else "hs_candidate"
    )

    return {
        "customs_value_rub": round(cv, 2),
        "invoice_value_rub": round(float(invoice_rub), 2),
        "value_source": value_source,
        "duty_pct": duty_pct,
        "duty_rub": duty_rub,
        "vat_pct": vat_pct,
        "vat_rub": vat_rub,
        "vat_base_rub": round(vat_base, 2),
        "excise_rub": excise_rub,
        "broker_fee_rub": broker,
        "cert_fee_rub": cert_fee,
        "clearance_total_rub": clearance,
        "missing_invoice": False,
        "is_estimate": True,
        "preliminary": True,
        "must_approve": bool(heuristic_fb),
        "disclaimer": (
            f"Предварительно: пошлина {duty_pct}% + НДС {vat_pct}% от (ТСст+пошлина). "
            "Финально после подтверждения ТН ВЭД и инвойса брокером."
        ),
        "duty_source": duty_src,
        "formula": "duty=CV*duty_pct; vat=(CV+duty+excise)*vat_pct; total=duty+vat+excise+broker+certs",
        "source": src,
    }


def format_customs_for_client(est: dict[str, Any]) -> str:
    if est.get("missing_invoice"):
        return (
            "Таможня: для расчёта пошлины и НДС нужна сумма инвойса (и валюта). "
            f"Пока заложены брокер ≈{est.get('broker_fee_rub', 0):.0f} ₽"
            + (f" + сертификация ≈{est.get('cert_fee_rub', 0):.0f} ₽" if est.get("cert_fee_rub") else "")
            + "."
        )
    return (
        f"Таможня (оценка): ТСст ≈{est.get('customs_value_rub', 0):.0f} ₽ → "
        f"пошлина {est.get('duty_pct')}% ≈{est.get('duty_rub', 0):.0f} ₽, "
        f"НДС {est.get('vat_pct')}% ≈{est.get('vat_rub', 0):.0f} ₽, "
        f"брокер ≈{est.get('broker_fee_rub', 0):.0f} ₽"
        + (f", сертификация ≈{est.get('cert_fee_rub', 0):.0f} ₽" if est.get("cert_fee_rub") else "")
        + f". Итого очистка ≈{est.get('clearance_total_rub', 0):.0f} ₽ (предварительно)."
    )
