"""Agent package exports."""

from agents.concierge import run_concierge
from agents.cargo import estimate_cargo, search_web_analog
from agents.rates import compare_quotes, fetch_mock_quotes, negotiate_carrier
from agents.adapters import all_adapters
from agents.negotiator import negotiate_client_messages, price_offer
from agents.legal import run_legal_research
from agents.customs import compute_customs_clearance, format_customs_for_client


def fetch_partner_quotes(chargeable_kg: float, route_summary: str) -> list[dict]:
    quotes = [a.quote(chargeable_kg, route_summary) for a in all_adapters()]
    return [
        q
        for q in quotes
        if not q.get("error") and float(q.get("price") or 0) < 999999999
    ]


__all__ = [
    "run_concierge",
    "estimate_cargo",
    "search_web_analog",
    "compare_quotes",
    "fetch_mock_quotes",
    "negotiate_carrier",
    "negotiate_client_messages",
    "price_offer",
    "run_legal_research",
    "fetch_partner_quotes",
    "all_adapters",
    "compute_customs_clearance",
    "format_customs_for_client",
]
