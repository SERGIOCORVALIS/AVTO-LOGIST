"""Customs clearance: GPT computes duty + VAT; Python only converts invoice FX and stores the result.

GPT is asked to apply:

  customs_value_rub  ≈ invoice value already converted to RUB
  duty_rub           = customs_value_rub * duty_pct / 100
  vat_base           = customs_value_rub + duty_rub + excise_rub
  vat_rub            = vat_base * vat_pct / 100
  clearance_total    = duty + vat + excise + broker + cert_fees

Python does not recompute those ruble amounts.
"""

from __future__ import annotations

import json
from typing import Any

from common.fx import to_rub

from agents.tz_policy import DEFAULT_TZ_POLICY

DEFAULT_VAT_PCT = float(DEFAULT_TZ_POLICY["ru_vat_pct"])
MIN_BROKER_FEE_RUB = float(DEFAULT_TZ_POLICY["broker_cost_rub"])
CLIENT_BROKER_FEE_RUB = float(DEFAULT_TZ_POLICY["broker_client_price_rub"])
GPT_FORMULA = "duty=CV*duty_pct/100; vat=(CV+duty+excise)*vat_pct/100; total=duty+vat+excise+broker+certs"

CUSTOMS_ESTIMATE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "customs_value_rub": {"type": ["number", "null"]},
        "invoice_value_rub": {"type": ["number", "null"]},
        "duty_pct": {"type": ["number", "null"]},
        "duty_rub": {"type": ["number", "null"]},
        "vat_pct": {"type": ["number", "null"]},
        "vat_rub": {"type": ["number", "null"]},
        "vat_base_rub": {"type": ["number", "null"]},
        "excise_rub": {"type": "number"},
        "broker_fee_rub": {"type": "number"},
        "cert_fee_rub": {"type": "number"},
        "clearance_total_rub": {"type": ["number", "null"]},
        "missing_invoice": {"type": "boolean"},
        "is_estimate": {"type": "boolean"},
        "disclaimer": {"type": "string"},
        "formula": {"type": "string"},
        "battery": {"type": "boolean"},
        "restricted": {"type": "boolean"},
        "hs_code": {"type": "string"},
        "hs_description": {"type": "string"},
        "notes": {"type": "string"},
    },
    "required": [
        "customs_value_rub",
        "invoice_value_rub",
        "duty_pct",
        "duty_rub",
        "vat_pct",
        "vat_rub",
        "vat_base_rub",
        "excise_rub",
        "broker_fee_rub",
        "cert_fee_rub",
        "clearance_total_rub",
        "missing_invoice",
        "is_estimate",
        "disclaimer",
        "formula",
        "battery",
        "restricted",
        "hs_code",
        "hs_description",
        "notes",
    ],
}


def _log_warn(event: str, error: str) -> None:
    try:
        from common.logutil import log as file_log

        file_log("orchestrator", "warn", event, error=error[:400])
    except Exception:
        pass


def _num(value: Any) -> float | None:
    if value is None or value is False:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        cleaned = value.replace("%", "").replace(",", ".").strip()
        try:
            return float(cleaned)
        except ValueError:
            return None
    return None


def _round_or_none(value: Any) -> float | None:
    n = _num(value)
    return None if n is None else round(n, 2)


def gpt_compute_customs(
    deal: dict[str, Any],
    cargo: dict[str, Any],
    hs_candidates: list[dict[str, Any]],
    invoice_rub: float | None,
    freight_rub: float = 0.0,
    *,
    include_freight_in_cv: bool = False,
) -> dict[str, Any] | None:
    from common import load_prompt, settings
    from common.llm import chat_parsed, gpt_client, model_for

    if not settings.openai_api_key:
        return None
    try:
        system = load_prompt("gpt", "customs.md")
        user = json.dumps(
            {
                "cargo": cargo,
                "route": deal.get("route") or {},
                "hs_candidates": hs_candidates,
                "invoice_value_rub": invoice_rub,
                "freight_rub": freight_rub,
                "include_freight_in_cv": include_freight_in_cv,
                "amount_rub": deal.get("amount_rub"),
                "compute_duty_and_vat_yourself": True,
            },
            ensure_ascii=False,
        )
        return chat_parsed(
            gpt_client(),
            model_for("document"),
            system,
            user,
            CUSTOMS_ESTIMATE_SCHEMA,
            schema_name="customs_estimate",
            temperature=0.1,
            trace_name="customs",
        )
    except Exception as exc:
        _log_warn("customs_llm_failed", str(exc))
        return None


def gpt_infer_customs_rates(
    deal: dict[str, Any],
    cargo: dict[str, Any],
    hs_candidates: list[dict[str, Any]],
    invoice_rub: float | None,
) -> dict[str, Any] | None:
    """Back-compat alias — full GPT estimate including duty_rub / vat_rub."""
    return gpt_compute_customs(deal, cargo, hs_candidates, invoice_rub)


def resolve_invoice_value_rub(cargo: dict[str, Any], deal: dict[str, Any] | None = None) -> tuple[float | None, str]:
    """Extract invoice / declared value and convert to RUB (FX only, not duty/VAT)."""
    deal = deal or {}
    for key in ("invoice_value_rub", "customs_value_rub", "declared_value_rub"):
        if cargo.get(key) is not None:
            return float(cargo[key]), key
    if cargo.get("invoice_value") is not None:
        cur = (cargo.get("invoice_currency") or cargo.get("currency") or "USD").upper()
        return to_rub(float(cargo["invoice_value"]), cur), f"invoice_value:{cur}"
    meta = deal.get("metadata") or {}
    if isinstance(meta, dict) and meta.get("invoice_value") is not None:
        cur = (meta.get("invoice_currency") or "USD").upper()
        return to_rub(float(meta["invoice_value"]), cur), f"metadata:{cur}"
    return None, "missing"


def _gpt_has_amounts(est: dict[str, Any], *, has_invoice: bool) -> bool:
    if not isinstance(est, dict) or not est:
        return False
    if _num(est.get("duty_rub")) is not None and _num(est.get("vat_rub")) is not None:
        return True
    return bool(est.get("missing_invoice")) and not has_invoice


def _pending_invoice(value_source: str, existing: dict[str, Any]) -> dict[str, Any]:
    broker = _num(existing.get("broker_fee_rub"))
    cert = _num(existing.get("cert_fee_rub")) or 0
    if broker is None:
        broker = MIN_BROKER_FEE_RUB
    return {
        "customs_value_rub": None,
        "invoice_value_rub": None,
        "value_source": value_source,
        "duty_pct": _num(existing.get("duty_pct")),
        "duty_rub": None,
        "vat_pct": _num(existing.get("vat_pct")) or DEFAULT_VAT_PCT,
        "vat_rub": None,
        "vat_base_rub": None,
        "excise_rub": _num(existing.get("excise_rub")) or 0,
        "broker_fee_rub": broker,
        "cert_fee_rub": cert,
        "clearance_total_rub": round(broker + cert, 2),
        "missing_invoice": True,
        "is_estimate": True,
        "preliminary": True,
        "must_approve": True,
        "battery": bool(existing.get("battery")),
        "restricted": bool(existing.get("restricted")),
        "disclaimer": existing.get("disclaimer")
        or (
            "Нет суммы инвойса — пошлина и НДС не рассчитаны. "
            "В КП заложены только брокер/сертификация; пошлина+НДС — после инвойса."
        ),
        "duty_source": existing.get("duty_source") or "gpt",
        "formula": existing.get("formula") or GPT_FORMULA,
        "source": "pending_invoice",
    }


def _normalize_gpt_estimate(
    est: dict[str, Any],
    *,
    invoice_rub: float | None,
    value_source: str,
    source: str,
    hs: list[dict[str, Any]],
    legal: dict[str, Any],
) -> dict[str, Any]:
    missing = bool(est.get("missing_invoice")) or invoice_rub is None or (invoice_rub or 0) <= 0
    duty_rub = None if missing else _round_or_none(est.get("duty_rub"))
    vat_rub = None if missing else _round_or_none(est.get("vat_rub"))
    cv = None if missing else _round_or_none(est.get("customs_value_rub")) or _round_or_none(invoice_rub)
    inv = None if missing else _round_or_none(est.get("invoice_value_rub")) or _round_or_none(invoice_rub)
    broker = _round_or_none(est.get("broker_fee_rub"))
    if broker is None:
        broker = MIN_BROKER_FEE_RUB
    cert = _round_or_none(est.get("cert_fee_rub")) or 0
    excise = _round_or_none(est.get("excise_rub")) or 0
    total = _round_or_none(est.get("clearance_total_rub"))
    if missing:
        total = round(broker + cert, 2)
        duty_rub = None
        vat_rub = None
        cv = None
        inv = None
    elif total is None and duty_rub is not None and vat_rub is not None:
        total = round(duty_rub + vat_rub + excise + broker + cert, 2)

    vat_pct = _num(est.get("vat_pct"))
    if vat_pct is None and not missing:
        vat_pct = DEFAULT_VAT_PCT

    extra_code = str(est.get("hs_code") or "").strip()
    if extra_code and not any(str(h.get("code")) == extra_code for h in hs):
        hs.append(
            {
                "code": extra_code,
                "description": est.get("hs_description") or "",
                "duty_rate": est.get("duty_pct"),
                "uncertainty": 0.45,
            }
        )
        legal["hs_candidates"] = hs

    return {
        "customs_value_rub": cv,
        "invoice_value_rub": inv,
        "value_source": value_source,
        "duty_pct": _num(est.get("duty_pct")),
        "duty_rub": duty_rub,
        "vat_pct": vat_pct,
        "vat_rub": vat_rub,
        "vat_base_rub": None if missing else _round_or_none(est.get("vat_base_rub")),
        "excise_rub": excise,
        "broker_fee_rub": broker,
        "cert_fee_rub": cert,
        "clearance_total_rub": total,
        "missing_invoice": missing,
        "is_estimate": True,
        "preliminary": True,
        "must_approve": bool(est.get("restricted") or est.get("battery") or missing),
        "battery": bool(est.get("battery")),
        "restricted": bool(est.get("restricted")),
        "disclaimer": est.get("disclaimer")
        or "Предварительная оценка GPT (пошлина+НДС). Финально после ТН ВЭД и инвойса брокером.",
        "duty_source": est.get("duty_source") or source,
        "formula": est.get("formula") or GPT_FORMULA,
        "source": source,
        "notes": est.get("notes") or "",
    }


def compute_customs_clearance(
    deal: dict[str, Any],
    legal: dict[str, Any] | None = None,
    freight_rub: float = 0.0,
    *,
    include_freight_in_cv: bool = False,
    use_gpt: bool = True,
) -> dict[str, Any]:
    """Keep GPT duty/VAT amounts; convert invoice to RUB; do not recompute the formula."""
    legal = legal or {}
    cargo = deal.get("cargo") or {}
    hs = list(legal.get("hs_candidates") or [])
    existing = legal.get("duties_estimate") if isinstance(legal.get("duties_estimate"), dict) else {}

    invoice_rub, value_source = resolve_invoice_value_rub(cargo, deal)
    missing_invoice = invoice_rub is None or invoice_rub <= 0

    if _gpt_has_amounts(existing, has_invoice=not missing_invoice):
        if missing_invoice:
            merged = {**existing, "missing_invoice": True, "duty_rub": None, "vat_rub": None}
            return _normalize_gpt_estimate(
                merged,
                invoice_rub=None,
                value_source=value_source,
                source=str(existing.get("source") or "gpt:legal"),
                hs=hs,
                legal=legal,
            )
        return _normalize_gpt_estimate(
            existing,
            invoice_rub=invoice_rub,
            value_source=value_source,
            source=str(existing.get("source") or "gpt:legal"),
            hs=hs,
            legal=legal,
        )

    if missing_invoice:
        return _pending_invoice(value_source, existing)

    if use_gpt:
        gpt = gpt_compute_customs(
            deal,
            cargo,
            hs,
            invoice_rub,
            freight_rub,
            include_freight_in_cv=include_freight_in_cv,
        )
        if gpt and _gpt_has_amounts(gpt, has_invoice=True):
            return _normalize_gpt_estimate(
                gpt,
                invoice_rub=invoice_rub,
                value_source=value_source,
                source="gpt:customs",
                hs=hs,
                legal=legal,
            )

    return {
        "customs_value_rub": round(float(invoice_rub), 2),
        "invoice_value_rub": round(float(invoice_rub), 2),
        "value_source": value_source,
        "duty_pct": _num(existing.get("duty_pct")),
        "duty_rub": None,
        "vat_pct": _num(existing.get("vat_pct")) or DEFAULT_VAT_PCT,
        "vat_rub": None,
        "vat_base_rub": None,
        "excise_rub": _num(existing.get("excise_rub")) or 0,
        "broker_fee_rub": _num(existing.get("broker_fee_rub")) or MIN_BROKER_FEE_RUB,
        "cert_fee_rub": _num(existing.get("cert_fee_rub")) or 0,
        "clearance_total_rub": None,
        "missing_invoice": False,
        "is_estimate": True,
        "preliminary": True,
        "must_approve": True,
        "battery": bool(existing.get("battery")),
        "restricted": bool(existing.get("restricted")),
        "disclaimer": "Нет расчёта пошлины/НДС от GPT — суммы не выдумываем.",
        "duty_source": "pending_gpt",
        "formula": GPT_FORMULA,
        "source": "pending_gpt_amounts",
    }


def format_customs_for_client(est: dict[str, Any]) -> str:
    client_broker = float(est.get("client_broker_fee_rub") or CLIENT_BROKER_FEE_RUB)
    if est.get("missing_invoice"):
        return (
            "Таможня: предварительный расчёт. Для пошлины и НДС нужна сумма инвойса (и валюта). "
            f"Брокер клиенту {client_broker:.0f} ₽ фикс (ДТ до 4 товаров)."
        )
    if est.get("duty_rub") is None or est.get("vat_rub") is None:
        return (
            "Таможня: предварительный расчёт, пошлина и НДС ещё уточняются. "
            f"Брокер клиенту {client_broker:.0f} ₽ фикс."
        )
    return (
        f"Таможня (предварительный расчёт): ТСст ≈{est.get('customs_value_rub', 0):.0f} ₽ → "
        f"пошлина {est.get('duty_pct')}% ≈{est.get('duty_rub', 0):.0f} ₽, "
        f"НДС {est.get('vat_pct')}% ≈{est.get('vat_rub', 0):.0f} ₽, "
        f"брокер клиенту {client_broker:.0f} ₽"
        + (f", сертификация ≈{est.get('cert_fee_rub', 0):.0f} ₽" if est.get("cert_fee_rub") else "")
        + f". Итого очистка ≈{est.get('clearance_total_rub', 0):.0f} ₽. После сверки с брокером сумма может измениться."
    )
