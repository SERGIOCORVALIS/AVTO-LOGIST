"""Configurable TRANSINVEST business rules (TZ v1). Mutable numbers live in policy_config.

Env overlays (optional): TARGET_MARGIN_PCT, RU_VAT_PCT, RFQ_TARGET_*, ACADEMY_*, …
DB policy_config wins over env; env wins over hard-coded defaults.
"""

from __future__ import annotations

import os
from typing import Any

# Default values from TRANSINVEST_AI_Logist_Business_Logic_v1.
# Penalties, importer scheme, VAT rate and similar rules MUST stay configurable.
DEFAULT_TZ_POLICY: dict[str, Any] = {
    "target_margin_pct": 18,
    "floor_margin_pct": 10,
    "max_discount_pct": 8,
    "min_gross_profit_rub": 3000,
    "ru_vat_pct": 22,
    "client_ru_sells_with_vat": True,
    "intl_freight_vat_pct": 0,
    "broker_cost_rub": 15000,
    "broker_client_price_rub": 20000,
    "broker_dt_item_limit": 4,
    "certification_markup_pct": 5,
    "buyout_commission_pct": 5,
    "buyout_fx_markup_rub": 0.45,
    "prepay_preferred_pct": 100,
    "prepay_min_pct_under_1m": 50,
    "staged_payment_threshold_rub": 1_000_000,
    "rfq_target_min": 10,
    "rfq_target_max": 20,
    "rfq_target_count": 15,
    "customs_confirmed_autonomy_threshold": 500,
    "hs_always_preliminary_for_client": True,
    "importer_scheme": "manual",
    "carrier_penalty_client_rub": None,
    "carrier_penalty_supplier_rub": None,
    "followup_default_hours": [24, 72, 168],
    "followup_urgent_hours": 2,
    "followup_operational_silence_hours": 2.5,
    "shipment_urgent_days": 14,
    "vip_volume_min": 5,
    "vip_volume_max": 50,
    "long_route_compare_km": 2100,
    "night_express_enabled": True,
    # Academy of the logist — operational technology (TZ numbers still win).
    "academy_enabled": True,
    "academy_in_kp": True,
    "academy_in_rfq": True,
    "academy_in_prompts": True,
    "academy_in_voice": True,
    # Communication coaching (overridable via policy_config / playbook)
    "comm_tone": "commercial",
    "always_ask_client": ["weight_kg", "ready_date"],
    "client_do_not_say": [
        "внутренние ставки поставщиков",
        "маржа",
        "себестоимость RFQ",
    ],
    "staff_coaching_rules": [
        "Один уточняющий вопрос за раз",
        "Не выдумывать ставки",
        "Клиенту — только белые схемы",
    ],
    "staff_coach_ttl_days": 30,
}

# .env key → policy key
_ENV_FLOAT = {
    "TARGET_MARGIN_PCT": "target_margin_pct",
    "FLOOR_MARGIN_PCT": "floor_margin_pct",
    "MAX_DISCOUNT_PCT": "max_discount_pct",
    "MIN_GROSS_PROFIT_RUB": "min_gross_profit_rub",
    "RU_VAT_PCT": "ru_vat_pct",
    "DEFAULT_VAT_PCT": "ru_vat_pct",  # alias → same as RU_VAT_PCT
    "INTL_FREIGHT_VAT_PCT": "intl_freight_vat_pct",
    "BROKER_COST_RUB": "broker_cost_rub",
    "BROKER_CLIENT_PRICE_RUB": "broker_client_price_rub",
    "BROKER_DT_ITEM_LIMIT": "broker_dt_item_limit",
    "CERTIFICATION_MARKUP_PCT": "certification_markup_pct",
    "BUYOUT_COMMISSION_PCT": "buyout_commission_pct",
    "BUYOUT_FX_MARKUP_RUB": "buyout_fx_markup_rub",
    "PREPAY_PREFERRED_PCT": "prepay_preferred_pct",
    "PREPAY_MIN_PCT_UNDER_1M": "prepay_min_pct_under_1m",
    "STAGED_PAYMENT_THRESHOLD_RUB": "staged_payment_threshold_rub",
    "RFQ_TARGET_MIN": "rfq_target_min",
    "RFQ_TARGET_MAX": "rfq_target_max",
    "RFQ_TARGET_COUNT": "rfq_target_count",
    "CUSTOMS_CONFIRMED_AUTONOMY_THRESHOLD": "customs_confirmed_autonomy_threshold",
    "FOLLOWUP_URGENT_HOURS": "followup_urgent_hours",
    "FOLLOWUP_OPERATIONAL_SILENCE_HOURS": "followup_operational_silence_hours",
    "SHIPMENT_URGENT_DAYS": "shipment_urgent_days",
    "VIP_VOLUME_MIN": "vip_volume_min",
    "VIP_VOLUME_MAX": "vip_volume_max",
    "LONG_ROUTE_COMPARE_KM": "long_route_compare_km",
    "CARRIER_PENALTY_CLIENT_RUB": "carrier_penalty_client_rub",
    "CARRIER_PENALTY_SUPPLIER_RUB": "carrier_penalty_supplier_rub",
}
_ENV_BOOL = {
    "ACADEMY_ENABLED": "academy_enabled",
    "ACADEMY_IN_KP": "academy_in_kp",
    "ACADEMY_IN_RFQ": "academy_in_rfq",
    "ACADEMY_IN_PROMPTS": "academy_in_prompts",
    "ACADEMY_IN_VOICE": "academy_in_voice",
    "NIGHT_EXPRESS_ENABLED": "night_express_enabled",
    "CLIENT_RU_SELLS_WITH_VAT": "client_ru_sells_with_vat",
    "HS_ALWAYS_PRELIMINARY_FOR_CLIENT": "hs_always_preliminary_for_client",
}
_ENV_STR = {
    "IMPORTER_SCHEME": "importer_scheme",
    # comma-separated hours, e.g. 24,72,168
    "FOLLOWUP_DEFAULT_HOURS": "followup_default_hours",
}


def _parse_bool(raw: str) -> bool:
    return raw.strip().lower() in ("1", "true", "yes", "on", "y")


def policy_from_env() -> dict[str, Any]:
    """Read commercial / Academy overrides from process environment."""
    out: dict[str, Any] = {}
    for env_key, policy_key in _ENV_FLOAT.items():
        raw = os.getenv(env_key)
        if raw is None or str(raw).strip() == "":
            continue
        try:
            out[policy_key] = float(str(raw).strip().replace(",", "."))
        except ValueError:
            continue
    # Explicit RU_VAT_PCT wins over legacy DEFAULT_VAT_PCT alias
    ru_vat = os.getenv("RU_VAT_PCT")
    if ru_vat is not None and str(ru_vat).strip() != "":
        try:
            out["ru_vat_pct"] = float(str(ru_vat).strip().replace(",", "."))
        except ValueError:
            pass
    for env_key, policy_key in _ENV_BOOL.items():
        raw = os.getenv(env_key)
        if raw is None or str(raw).strip() == "":
            continue
        out[policy_key] = _parse_bool(str(raw))
    for env_key, policy_key in _ENV_STR.items():
        raw = os.getenv(env_key)
        if raw is None or str(raw).strip() == "":
            continue
        text = str(raw).strip()
        if policy_key == "followup_default_hours":
            hours: list[float] = []
            for part in text.replace(";", ",").split(","):
                part = part.strip()
                if not part:
                    continue
                try:
                    hours.append(float(part.replace(",", ".")))
                except ValueError:
                    continue
            if hours:
                out[policy_key] = hours
            continue
        out[policy_key] = text
    if "rfq_target_min" in out and "rfq_target_max" in out:
        lo, hi = int(out["rfq_target_min"]), int(out["rfq_target_max"])
        out["rfq_target_count"] = out.get("rfq_target_count") or max(lo, min(hi, (lo + hi) // 2))
    return out


def merge_tz_policy(policy: dict[str, Any] | None = None) -> dict[str, Any]:
    """defaults ← env ← explicit policy (e.g. DB / deal)."""
    out = dict(DEFAULT_TZ_POLICY)
    out.update(policy_from_env())
    for k, v in (policy or {}).items():
        if v is None:
            continue
        out[k] = v
    return out


def academy_active(policy: dict[str, Any] | None = None, *, layer: str = "enabled") -> bool:
    """layer: enabled | kp | rfq | prompts | voice."""
    cfg = merge_tz_policy(policy)
    if not cfg.get("academy_enabled", True):
        return False
    key = {
        "enabled": "academy_enabled",
        "kp": "academy_in_kp",
        "rfq": "academy_in_rfq",
        "prompts": "academy_in_prompts",
        "voice": "academy_in_voice",
    }.get(layer, "academy_enabled")
    return bool(cfg.get(key, True))
