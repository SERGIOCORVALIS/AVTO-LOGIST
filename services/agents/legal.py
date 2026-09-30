from __future__ import annotations

import json
from typing import Any

from common import extract_json, load_prompt, settings
from common.company import company_as_dict, company_requisites_md, load_company
from common.llm import chat_parsed, gpt_client, model_for
from agents.legal_corpus import load_legal_context
from agents.customs import compute_customs_clearance, resolve_invoice_value_rub


_NULLABLE_NUM = {"type": ["number", "null"]}

LEGAL_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "hs_candidates": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "code": {"type": "string"},
                    "description": {"type": "string"},
                    "duty_rate": {"type": "number"},
                    "uncertainty": {"type": "number"},
                },
                "required": ["code", "description", "duty_rate", "uncertainty"],
            },
        },
        "duties_estimate": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "customs_value_rub": _NULLABLE_NUM,
                "invoice_value_rub": _NULLABLE_NUM,
                "duty_pct": _NULLABLE_NUM,
                "duty_rub": _NULLABLE_NUM,
                "vat_pct": _NULLABLE_NUM,
                "vat_rub": _NULLABLE_NUM,
                "vat_base_rub": _NULLABLE_NUM,
                "excise_rub": {"type": "number"},
                "broker_fee_rub": {"type": "number"},
                "cert_fee_rub": {"type": "number"},
                "clearance_total_rub": _NULLABLE_NUM,
                "missing_invoice": {"type": "boolean"},
                "is_estimate": {"type": "boolean"},
                "disclaimer": {"type": "string"},
                "formula": {"type": "string"},
                "battery": {"type": "boolean"},
                "restricted": {"type": "boolean"},
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
            ],
        },
        "compliance_flags": {"type": "array", "items": {"type": "string"}},
        "law_changes_relevant": {"type": "array", "items": {"type": "string"}},
        "contract_draft_md": {"type": "string"},
        "client_risk_summary": {"type": "string"},
        "must_approve": {"type": "boolean"},
        "confidence": {"type": "number"},
        "sources": {"type": "array", "items": {"type": "string"}},
        "risk_matrix": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "code": {"type": "string"},
                    "severity": {"type": "string"},
                    "description": {"type": "string"},
                    "mitigation": {"type": "string"},
                },
                "required": ["code", "severity", "description", "mitigation"],
            },
        },
    },
    "required": [
        "hs_candidates",
        "duties_estimate",
        "compliance_flags",
        "law_changes_relevant",
        "contract_draft_md",
        "client_risk_summary",
        "must_approve",
        "confidence",
        "sources",
        "risk_matrix",
    ],
}


def _log_warn(event: str, error: str) -> None:
    try:
        from common.logutil import log as file_log

        file_log("orchestrator", "warn", event, error=error[:400])
    except Exception:
        pass


def run_legal_research(deal: dict[str, Any], cargo_est: dict[str, Any] | None = None) -> dict[str, Any]:
    data = _gpt_legal(deal, cargo_est)
    flags = list(data.get("compliance_flags") or [])
    duties_in = data.get("duties_estimate") if isinstance(data.get("duties_estimate"), dict) else {}
    if duties_in.get("restricted") and "restricted_goods" not in flags:
        flags.append("restricted_goods")
    if duties_in.get("battery") and "battery_transport_rules" not in flags:
        flags.append("battery_transport_rules")
    data["compliance_flags"] = flags
    if duties_in.get("restricted") or "restricted_goods" in flags:
        data["must_approve"] = True
    if duties_in.get("battery"):
        data["must_approve"] = True

    data["duties_estimate"] = compute_customs_clearance(
        deal, data, freight_rub=0.0
    )
    data.setdefault("risk_matrix", [])
    return data


def _gpt_legal(deal: dict[str, Any], cargo_est: dict[str, Any] | None) -> dict[str, Any]:
    cargo = deal.get("cargo") or {}
    if not settings.openai_api_key:
        _log_warn("legal_llm_missing_key", "OPENAI_API_KEY empty")
        return _unavailable_legal(deal, "no_openai_key")

    system = load_prompt("gpt", "legal.md")
    try:
        from agents.tz_policy import academy_active

        if academy_active(layer="prompts"):
            academy = load_prompt("gpt", "academy.md")
            system = system + "\n\n## Академия (таможня/документы/риски)\n" + "\n".join(
                line
                for line in academy.splitlines()
                if any(
                    k in line.lower()
                    for k in (
                        "тамож",
                        "втт",
                        "инвойс",
                        "msds",
                        "опасн",
                        "документ",
                        "инкотерм",
                        "предварительн",
                        "не выдумывай",
                    )
                )
            )[:3500]
    except Exception:
        pass
    company = load_company()
    corpus = load_legal_context(
        str(cargo.get("name") or cargo.get("category") or "ндс пошлина батареи ограничения")
    )
    invoice_rub, invoice_src = resolve_invoice_value_rub(cargo, deal)
    user = json.dumps(
        {
            "company": company_as_dict(company),
            "company_requisites_md": company_requisites_md(company),
            "cargo": cargo,
            "route": deal.get("route"),
            "cargo_estimate": cargo_est,
            "amount_rub": deal.get("amount_rub"),
            "invoice_value_rub": invoice_rub,
            "invoice_value_source": invoice_src,
            "legal_corpus_excerpt": corpus,
            "compute_duty_and_vat_yourself": True,
        },
        ensure_ascii=False,
    )
    last_err: Exception | None = None
    for _ in range(2):
        try:
            data = chat_parsed(
                gpt_client(),
                model_for("document"),
                system,
                user,
                LEGAL_SCHEMA,
                schema_name="legal_research",
                temperature=0.2,
                trace_name="legal",
            )
            if not isinstance(data, dict):
                data = extract_json(str(data))
            data.setdefault("hs_candidates", [])
            data.setdefault("duties_estimate", {})
            data.setdefault("compliance_flags", [])
            data.setdefault("law_changes_relevant", [])
            data.setdefault("contract_draft_md", "")
            data.setdefault("client_risk_summary", "")
            data.setdefault("risk_matrix", [])
            data.setdefault("sources", ["gpt"])
            return data
        except Exception as exc:
            last_err = exc
            continue
    _log_warn("legal_llm_failed", str(last_err or "unknown"))
    return _unavailable_legal(deal, str(last_err or "gpt_failed"))


def _unavailable_legal(deal: dict[str, Any], reason: str) -> dict[str, Any]:
    """No template contract / HS guesses — GPT is the classifier; this is only if the model is down."""
    return {
        "hs_candidates": [],
        "duties_estimate": {},
        "compliance_flags": ["gpt_unavailable"],
        "law_changes_relevant": [],
        "contract_draft_md": "",
        "client_risk_summary": "Юридическая оценка через GPT недоступна — нужна проверка менеджером.",
        "must_approve": True,
        "confidence": 0.0,
        "sources": [f"gpt_unavailable:{reason}"],
        "risk_matrix": [
            {
                "code": "gpt_unavailable",
                "severity": "high",
                "description": "Legal/customs GPT call failed",
                "mitigation": "retry GPT; broker review before contract",
            }
        ],
    }
