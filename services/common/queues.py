"""Enqueue BullMQ jobs via API (Node Queue.add — reliable protocol)."""

from __future__ import annotations

import os
from typing import Any

import httpx

from common import settings


def _internal_headers() -> dict[str, str]:
    token = os.getenv("INTERNAL_API_TOKEN") or ""
    if not token:
        return {"Content-Type": "application/json"}
    return {
        "Content-Type": "application/json",
        "x-internal-token": token,
    }


def _post_internal(path: str, payload: dict[str, Any]) -> dict[str, Any] | None:
    try:
        r = httpx.post(
            f"{settings.api_url.rstrip('/')}{path}",
            json=payload,
            headers=_internal_headers(),
            timeout=8.0,
        )
        if r.status_code >= 400:
            return None
        return r.json()
    except Exception:
        return None


def enqueue_email_job(
    name: str,
    data: dict[str, Any],
    *,
    job_id: str | None = None,
) -> dict[str, Any] | None:
    """POST /internal/jobs/email. Returns job meta or None on soft failure."""
    payload: dict[str, Any] = {"name": name, "data": data}
    if job_id:
        payload["job_id"] = job_id
    return _post_internal("/internal/jobs/email", payload)


def enqueue_calendar_sync() -> dict[str, Any] | None:
    return _post_internal("/internal/jobs/calendar", {})


def enqueue_partner_quote_emails(
    deal_id: str,
    *,
    route_summary: str,
    cargo_summary: str,
    weight_kg: float | None = None,
    volume_m3: float | None = None,
    ready_date: str | None = None,
    emails: list[str] | None = None,
) -> list[dict[str, Any]]:
    """Enqueue request_quote jobs for each partner email."""
    targets = list(emails or [])
    if not targets:
        env_emails = os.getenv("PARTNER_QUOTE_EMAILS", "")
        targets = [e.strip() for e in env_emails.split(",") if e.strip()]
    if not targets:
        try:
            from common.db import list_approved_partner_emails

            targets = list_approved_partner_emails()
        except Exception:
            targets = []

    results: list[dict[str, Any]] = []
    for to in targets:
        job = enqueue_email_job(
            "request_quote",
            {
                "to": to,
                "deal_id": deal_id,
                "route_summary": route_summary,
                "cargo_summary": cargo_summary,
                "weight_kg": weight_kg,
                "volume_m3": volume_m3,
                "ready_date": ready_date,
            },
            job_id=f"quote-{deal_id}-{to}",
        )
        results.append({"to": to, "job": job})
    return results


def enqueue_negotiate_email(
    deal_id: str,
    *,
    to: str,
    route_summary: str,
    current_price: float,
    currency: str,
    ask_pct: float,
) -> dict[str, Any] | None:
    asked = round(current_price * (1 - ask_pct), 2)
    return enqueue_email_job(
        "request_quote",
        {
            "to": to,
            "deal_id": deal_id,
            "subject": f"Контрпредложение Ref: {deal_id}",
            "route_summary": route_summary,
            "cargo_summary": (
                f"Просим улучшить ставку. Текущая: {current_price} {currency}. "
                f"Целевая: ~{asked} {currency} (−{ask_pct * 100:.0f}%)."
            ),
        },
        job_id=f"negotiate-{deal_id}-{to}-{asked}",
    )
