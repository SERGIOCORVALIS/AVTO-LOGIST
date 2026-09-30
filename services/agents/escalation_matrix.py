"""Unified escalation matrix (TZ v1).

Legal/compliance decisions go to a human. Ordinary quoting does not.
"""

from __future__ import annotations

from typing import Any

# reason → (needed_decision, notify, stop_client_flow)
MATRIX: dict[str, dict[str, Any]] = {
    "grey_scheme_request": {
        "needed_decision": "acknowledge_block",
        "notify": "director",
        "stop": True,
        "severity": "critical",
    },
    "forbidden_cargo_liquid": {
        "needed_decision": "acknowledge_block",
        "notify": "manager",
        "stop": True,
        "severity": "high",
    },
    "private_move": {
        "needed_decision": "acknowledge_block",
        "notify": "manager",
        "stop": True,
        "severity": "high",
    },
    "sanctioned_goods": {
        "needed_decision": "compliance_review",
        "notify": "director",
        "stop": True,
        "severity": "critical",
    },
    "dual_use_hold": {
        "needed_decision": "compliance_route_and_broker",
        "notify": "logist_and_broker",
        "stop": False,
        "severity": "high",
        "note": "не автоматический отказ; hold → живой логист + брокер",
    },
    "dangerous_goods_review": {
        "needed_decision": "expert_rate",
        "notify": "logist",
        "stop": False,
        "severity": "medium",
        "note": "опасный груз сам по себе не стоп; нужен профильный перевозчик",
    },
    "oversized_expert": {
        "needed_decision": "expert_rate",
        "notify": "logist",
        "stop": False,
        "severity": "medium",
    },
    "margin_or_discount_policy": {
        "needed_decision": "approve_price",
        "notify": "director",
        "stop": False,
        "severity": "high",
    },
    "profit_below_minimum": {
        "needed_decision": "approve_strategic_loss",
        "notify": "director",
        "stop": False,
        "severity": "high",
    },
    "cashflow_gap": {
        "needed_decision": "approve_financing_or_align_supplier",
        "notify": "director",
        "stop": False,
        "severity": "high",
    },
    "amount_threshold": {
        "needed_decision": "approve_price",
        "notify": "director",
        "stop": False,
        "severity": "medium",
    },
    "missing_invoice_for_vat_duty": {
        "needed_decision": "request_invoice_or_approve_partial_kp",
        "notify": "manager",
        "stop": False,
        "severity": "low",
    },
    "missing_partner_channels": {
        "needed_decision": "configure_suppliers",
        "notify": "director",
        "stop": False,
        "severity": "high",
    },
    "legal_must_approve": {
        "needed_decision": "approve_legal",
        "notify": "logist_and_broker",
        "stop": False,
        "severity": "high",
    },
    "claim_or_incident": {
        "needed_decision": "human_legal",
        "notify": "logist",
        "stop": False,
        "severity": "high",
        "note": "юридически значимые решения самостоятельно не принимать",
    },
    "execution_playbook_escalation": {
        "needed_decision": "follow_playbook",
        "notify": "logist",
        "stop": False,
        "severity": "medium",
    },
    "procurement_loss_pattern": {
        "needed_decision": "strengthen_buy_and_volume_report",
        "notify": "director",
        "stop": False,
        "severity": "medium",
    },
    "cn_ops_rfq": {
        "needed_decision": "process_ops_request",
        "notify": "manager",
        "stop": False,
        "severity": "low",
    },
}


def resolve_escalation(reason: str, **extra: Any) -> dict[str, Any]:
    row = dict(MATRIX.get(reason) or {
        "needed_decision": "review",
        "notify": "manager",
        "stop": False,
        "severity": "medium",
    })
    row["reason"] = reason
    row.update({k: v for k, v in extra.items() if v is not None})
    return row
