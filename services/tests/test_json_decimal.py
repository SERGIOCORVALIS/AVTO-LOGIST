"""Postgres Decimals in deal payloads must not crash GPT JSON serialization."""

from __future__ import annotations

import json
from decimal import Decimal


def test_legal_payload_accepts_decimal_amount():
    from agents.legal import run_legal_research

    deal = {
        "cargo": {"name": "одежда", "invoice_value_rub": Decimal("50000.50")},
        "route": {"origin": "CN", "destination": "RU"},
        "amount_rub": Decimal("120000.00"),
    }
    # No OpenAI key → unavailable path, but must not raise TypeError on dumps.
    data = run_legal_research(deal, None)
    assert "gpt_unavailable" in (data.get("compliance_flags") or [])
    # Round-trip sanity: legal response itself is JSON-serializable
    json.dumps(data, ensure_ascii=False, default=str)


def test_json_dumps_decimal_with_default_str():
    payload = {"amount": Decimal("99.5"), "nested": {"w": Decimal("1")}}
    text = json.dumps(payload, ensure_ascii=False, default=str)
    assert "99.5" in text
