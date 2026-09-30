"""Enqueue BullMQ jobs via API (Node Queue.add — reliable protocol)."""

from __future__ import annotations

import os
import time
from typing import Any

import httpx

from common import settings
from common.logutil import error as log_error, info as log_info

# Cabinets that make sense for container / rail / sea (PSZhVS etc.)
_RAIL_SEA_CABINET_CODES = frozenset(
    {"fesco", "transcontainer", "sasco", "kasco", "dvlk", "isales", "rzd"}
)


def _job_id_suffix() -> str:
    """Unique suffix so re-RFQ is not blocked by deterministic Bull job ids."""
    return str(int(time.time() * 1000) % 10_000_000)


def _safe_job_token(value: str, *, max_len: int = 36) -> str:
    """Bull jobId-safe fragment (emails / codes with @ or unicode)."""
    import hashlib
    import re

    raw = str(value or "").strip().lower()
    if not raw:
        return "x"
    cleaned = re.sub(r"[^a-z0-9._-]+", "_", raw)
    if cleaned != raw or len(cleaned) > max_len:
        return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]
    return cleaned[:max_len]


def _cabinet_rfq_enabled() -> bool:
    """Cabinet/Playwright RFQ is opt-in — login portals are noisy and often dead HTTPS."""
    for key in ("CABINET_RFQ_ENABLED", "CABINET_PLAYWRIGHT"):
        v = (os.getenv(key) or "").strip().lower()
        if v in ("1", "true", "yes", "on"):
            return True
    return False


def _make_job_id(prefix: str, deal_id: str, *parts: str) -> str:
    bits = [prefix, str(deal_id)[:36]]
    bits.extend(_safe_job_token(p) for p in parts if p is not None)
    bits.append(_job_id_suffix())
    return "-".join(bits)


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
            log_error(
                "internal_job_http_error",
                path=path,
                status=r.status_code,
                body=r.text[:300],
            )
            return None
        return r.json()
    except Exception as exc:
        log_error("internal_job_failed", path=path, error=str(exc)[:300])
        return None


def enqueue_email_job(
    name: str,
    data: dict[str, Any],
    *,
    job_id: str | None = None,
    delay_ms: int | None = None,
) -> dict[str, Any] | None:
    """POST /internal/jobs/email. Returns job meta or None on soft failure."""
    payload: dict[str, Any] = {"name": name, "data": data}
    if job_id:
        payload["job_id"] = job_id
    if delay_ms is not None and int(delay_ms) > 0:
        payload["delay_ms"] = int(delay_ms)
    return _post_internal("/internal/jobs/email", payload)


def enqueue_api_quote_fallback(
    deal_id: str,
    *,
    reason: str = "cabinet_no_reply",
    delay_ms: int = 90_000,
) -> dict[str, Any] | None:
    """After cabinet/operator silence — retry partner HTTP/API quotes."""
    return enqueue_email_job(
        "api_quote_fallback",
        {"deal_id": deal_id, "reason": reason},
        job_id=_make_job_id("api-fallback", deal_id, reason),
        delay_ms=delay_ms,
    )


def enqueue_calendar_sync() -> dict[str, Any] | None:
    return _post_internal("/internal/jobs/calendar", {})


def _not_suppliers() -> set[str]:
    try:
        from agents.restrictions import NOT_SUPPLIERS

        return set(NOT_SUPPLIERS)
    except Exception:
        return {"cdek", "keycloak"}


def _dedupe_emails(targets: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for e in targets:
        low = e.lower()
        if low in seen:
            continue
        seen.add(low)
        out.append(e)
    return out


def _csv_env(*names: str) -> list[str]:
    out: list[str] = []
    for name in names:
        raw = os.getenv(name) or ""
        out.extend(e.strip() for e in raw.split(",") if e.strip())
    return out


def _emails_with_prefixes(*prefixes: str) -> list[str]:
    skip = _not_suppliers()
    targets: list[str] = []
    for key, val in os.environ.items():
        code = None
        for prefix in prefixes:
            if key.startswith(prefix):
                code = key[len(prefix) :].lower()
                break
        if not code or code in skip:
            continue
        email = (val or "").strip()
        if "@" in email:
            targets.append(email)
    return targets


def _freight_email_targets() -> list[str]:
    """Rate-supplier inboxes (FESCO / TransContainer). Not China factory sourcing."""
    targets = _csv_env("SUPPLIER_QUOTE_EMAILS", "PARTNER_QUOTE_EMAILS")
    targets.extend(_emails_with_prefixes("SUPPLIER_EMAIL_", "PARTNER_EMAIL_"))
    return _dedupe_emails(targets)


def _sourcing_email_targets() -> list[str]:
    """China buyout / factory sourcing inboxes. Never FESCO cabinets."""
    targets = _csv_env("SOURCING_QUOTE_EMAILS", "SUPPLIER_SOURCING_EMAILS")
    targets.extend(_emails_with_prefixes("SOURCING_EMAIL_"))
    return _dedupe_emails(targets)


def _partner_email_targets() -> list[str]:
    """Backward-compatible alias of freight rate inboxes."""
    return _freight_email_targets()


def _is_login_cabinet_url(url: str) -> bool:
    try:
        from agents.adapters import _is_quote_api_url

        return not _is_quote_api_url(url)
    except Exception:
        low = (url or "").lower()
        return any(h in low for h in ("/auth", "/login", "keycloak", "/cabinet"))


def list_cabinet_partners() -> list[dict[str, str]]:
    """Portal logins (FESCO / iSales) — not quote HTTP APIs."""
    skip = _not_suppliers()
    out: list[dict[str, str]] = []
    seen: set[str] = set()
    for key, url in os.environ.items():
        code = None
        force_cabinet = False
        if key.startswith("CABINET_HTTP_"):
            code = key.replace("CABINET_HTTP_", "").lower()
            force_cabinet = True
        elif key.startswith("SUPPLIER_HTTP_"):
            code = key.replace("SUPPLIER_HTTP_", "").lower()
        elif key.startswith("PARTNER_HTTP_"):
            code = key.replace("PARTNER_HTTP_", "").lower()
        if not code or not (url or "").startswith("http") or code in skip:
            continue
        if not force_cabinet and not _is_login_cabinet_url(url):
            continue
        if code in seen:
            continue
        seen.add(code)
        upper = code.upper()
        user = (
            os.getenv(f"CABINET_USERNAME_{upper}")
            or os.getenv(f"SUPPLIER_USERNAME_{upper}")
            or os.getenv(f"PARTNER_USERNAME_{upper}")
            or ""
        ).strip()
        password = (
            os.getenv(f"CABINET_PASSWORD_{upper}")
            or os.getenv(f"SUPPLIER_PASSWORD_{upper}")
            or os.getenv(f"PARTNER_PASSWORD_{upper}")
            or ""
        ).strip()
        email = (
            os.getenv(f"SUPPLIER_EMAIL_{upper}")
            or os.getenv(f"PARTNER_EMAIL_{upper}")
            or ""
        ).strip()
        out.append(
            {
                "code": code,
                "url": url,
                "user": user,
                "has_password": "1" if password else "0",
                "email": email,
            }
        )
    return out


def _enqueue_email_targets(
    *,
    job_name: str,
    deal_id: str,
    targets: list[str],
    payload_base: dict[str, Any],
    id_prefix: str,
) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for to in targets:
        job = enqueue_email_job(
            job_name,
            {**payload_base, "to": to},
            job_id=_make_job_id(id_prefix, deal_id, to),
        )
        if not job:
            log_error("supplier_email_enqueue_failed", to=to, deal_id=deal_id, job=job_name)
        else:
            log_info(
                "supplier_email_enqueued",
                to=to,
                deal_id=deal_id,
                job_id=job.get("id"),
                kind=job_name,
            )
        results.append({"to": to, "job": job, "rfq_kind": payload_base.get("rfq_kind")})
    return results


def enqueue_cabinet_rfq(
    deal_id: str,
    payload_base: dict[str, Any],
    *,
    already_emailed: set[str] | None = None,
    preferred_codes: list[str] | None = None,
    transport_mode: str | None = None,
) -> list[dict[str, Any]]:
    """Queue operator/Playwright cabinet tasks. Does not treat login pages as APIs.

    Portal logins (FESCO/iSales/DHL) are skipped unless CABINET_RFQ_ENABLED or
    CABINET_PLAYWRIGHT is on. Preferred/rail-sea emails still get a mail RFQ.
    """
    emailed = already_emailed or set()
    results: list[dict[str, Any]] = []
    preferred = {str(c).strip().lower() for c in (preferred_codes or []) if c}
    mode = str(transport_mode or payload_base.get("transport_mode") or "").lower()
    specialized = mode in ("container", "rail", "sea") or bool(preferred)
    run_cabinet = _cabinet_rfq_enabled()
    if not run_cabinet:
        log_info(
            "cabinet_rfq_skipped",
            deal_id=deal_id,
            reason="CABINET_RFQ_ENABLED/CABINET_PLAYWRIGHT off",
        )

    for cab in list_cabinet_partners():
        code = str(cab["code"] or "").lower()
        if preferred and code not in preferred:
            continue
        if specialized and not preferred and code not in _RAIL_SEA_CABINET_CODES:
            continue
        if code in ("cdek", "keycloak"):
            continue
        if specialized and code == "dhl":
            # DHL login noise on domestic container/rail lanes.
            continue

        if run_cabinet:
            job = enqueue_email_job(
                "cabinet_rfq",
                {
                    **payload_base,
                    "code": cab["code"],
                    "url": cab["url"],
                    "user": cab["user"],
                    "to": cab.get("email") or "",
                },
                job_id=_make_job_id("cabinet", deal_id, cab["code"]),
            )
            results.append(
                {
                    "code": cab["code"],
                    "cabinet": True,
                    "url": cab["url"],
                    "user": cab["user"],
                    "to": cab.get("email") or None,
                    "job": job,
                    "rfq_kind": "cabinet",
                }
            )
            log_info(
                "cabinet_rfq_enqueued",
                deal_id=deal_id,
                code=cab["code"],
                url=cab["url"],
                has_password=cab["has_password"] == "1",
                job_id=(job or {}).get("id") if job else None,
            )

        email = (cab.get("email") or "").strip()
        if email and email.lower() not in emailed:
            # Prefer email RFQ over dead HTTPS logins when cabinet job is off.
            if preferred or not specialized or code in _RAIL_SEA_CABINET_CODES:
                mail_job = enqueue_email_job(
                    "request_quote",
                    {**payload_base, "to": email, "rfq_kind": "freight"},
                    job_id=_make_job_id("quote", deal_id, email),
                )
                results.append(
                    {
                        "to": email,
                        "code": cab["code"],
                        "job": mail_job,
                        "rfq_kind": "freight",
                    }
                )
                emailed.add(email.lower())
    return results


def enqueue_sourcing_emails(
    deal_id: str,
    *,
    route_summary: str,
    cargo_summary: str,
    weight_kg: float | None = None,
    volume_m3: float | None = None,
    ready_date: str | None = None,
    emails: list[str] | None = None,
    corridor: str | None = None,
    transport_mode: str | None = None,
    cargo_class: str | None = None,
    origin_incoterm: str | None = None,
    dest_incoterm: str | None = None,
    incoterms: str | None = None,
    services: list[str] | None = None,
) -> list[dict[str, Any]]:
    """RFQ to China factory / buyout desks — never freight cabinets."""
    targets = list(emails or []) or _sourcing_email_targets()
    payload_base = {
        "deal_id": deal_id,
        "rfq_kind": "sourcing",
        "route_summary": route_summary,
        "cargo_summary": cargo_summary,
        "weight_kg": weight_kg,
        "volume_m3": volume_m3,
        "ready_date": ready_date,
        "corridor": corridor,
        "transport_mode": transport_mode,
        "cargo_class": cargo_class,
        "origin_incoterm": origin_incoterm,
        "dest_incoterm": dest_incoterm,
        "incoterms": incoterms,
        "services": services,
        "subject": f"Запрос выкупа/подбора поставщика Ref: {deal_id}",
    }
    try:
        from agents.procurement import sanitize_rfq_payload
        from common.db import get_deal

        deal = get_deal(deal_id) if deal_id else None
        payload_base = sanitize_rfq_payload(
            payload_base, deal=deal, allow_factory=False
        )
    except Exception as exc:
        log_error(
            "rfq_sanitize_failed",
            deal_id=deal_id,
            kind="sourcing",
            error=str(exc)[:400],
        )
        return []
    return _enqueue_email_targets(
        job_name="request_sourcing",
        deal_id=deal_id,
        targets=targets,
        payload_base=payload_base,
        id_prefix="sourcing",
    )


def enqueue_staff_channel(
    *,
    kind: str,
    text: str,
    deal_id: str | None = None,
    job_id: str | None = None,
    notify_director: bool = False,
) -> dict[str, Any] | None:
    """POST staff alert/info/digest to TG channel queue via API."""
    payload: dict[str, Any] = {"kind": kind, "text": text}
    if deal_id:
        payload["deal_id"] = deal_id
    if job_id:
        payload["job_id"] = job_id
    if notify_director:
        payload["notify_director"] = True
    return _post_internal("/internal/jobs/channel", payload)


def _rfq_preflight_enabled(
    *,
    preferred_codes: list[str] | None,
    transport_mode: str | None,
) -> bool:
    """Whether RFQ emails wait for staff «одобри RFQ».

    Env RFQ_PREFLIGHT:
      off/false — never hold (full auto)
      on/true  — always hold
      auto     — only when caller passes preflight=True (manager_gate cards).
                 Preferred operators / container mode alone must NOT stall deals.
    """
    v = (os.getenv("RFQ_PREFLIGHT") or "auto").strip().lower()
    if v in ("0", "false", "off", "no"):
        return False
    if v in ("1", "true", "yes", "on"):
        return True
    # auto: do not infer hold from preferred/container — quote_pipeline sets
    # preflight=True only for manager_gate / require_manager_approve.
    _ = preferred_codes, transport_mode
    return False


def _store_rfq_preflight(
    deal_id: str,
    *,
    targets: list[str],
    payload_base: dict[str, Any],
    preferred_codes: list[str] | None,
) -> list[dict[str, Any]]:
    from datetime import datetime, timezone

    from common.db import get_deal, update_deal

    deal = get_deal(deal_id) or {}
    meta = dict(deal.get("metadata") or {})
    preview_body = "\n".join(
        [
            f"Маршрут: {payload_base.get('route_summary') or '—'}",
            f"Груз: {payload_base.get('cargo_summary') or '—'}",
            f"Режим: {payload_base.get('transport_mode') or '—'}",
            f"Коридор: {payload_base.get('corridor') or '—'}",
        ]
    )
    meta["rfq_preflight"] = {
        "targets": targets,
        "payload_base": payload_base,
        "preferred_codes": preferred_codes or [],
        "created_at": datetime.now(timezone.utc).isoformat(),
        "status": "pending",
    }
    update_deal(deal_id, metadata=meta, status="awaiting_manager", escalate=True)
    try:
        from common.db import create_escalation

        create_escalation(
            deal_id,
            reason="rfq_preflight",
            summary=f"Preflight RFQ: {len(targets)} адрес(ов). Проверьте scrub и список.",
            numbers={
                "targets": targets[:40],
                "preview": preview_body,
                "preferred_codes": preferred_codes or [],
            },
            recommendation="Одобрить = отправить RFQ поставщикам. Отклонить = не слать (сделка не отменяется).",
            needed_decision="approve_rfq",
        )
    except Exception as exc:
        log_error("rfq_preflight_escalation_failed", deal_id=deal_id, error=str(exc)[:300])
    to_lines = "\n".join(f"• {t}" for t in targets[:25])
    more = f"\n… ещё {len(targets) - 25}" if len(targets) > 25 else ""
    text = "\n".join(
        [
            "🛂 Preflight RFQ — проверьте перед отправкой",
            f"Сделка: {deal_id}",
            "",
            "Кому:",
            to_lines + more,
            "",
            "Текст (после scrub):",
            preview_body,
            "",
            "Скрыто: клиент / получатель / ИНН.",
            "В эскалациях: «Согласовать» = отправить RFQ.",
            f"Или: одобри RFQ {deal_id[:8]}",
        ]
    )
    enqueue_staff_channel(
        kind="info",
        text=text,
        deal_id=deal_id,
        job_id=_make_job_id("rfq-preflight", deal_id),
    )
    log_info(
        "rfq_preflight_pending",
        deal_id=deal_id,
        targets=len(targets),
        preferred=preferred_codes,
    )
    return [
        {
            "to": t,
            "job": None,
            "rfq_kind": "freight",
            "preflight": True,
        }
        for t in targets
    ]


def flush_rfq_preflight(deal_id: str) -> list[dict[str, Any]]:
    """Send emails held in metadata.rfq_preflight after staff approval."""
    from common.db import get_deal, update_deal

    deal = get_deal(deal_id)
    if not deal:
        return []
    meta = dict(deal.get("metadata") or {})
    pending = meta.get("rfq_preflight")
    if not isinstance(pending, dict) or pending.get("status") != "pending":
        log_info("rfq_preflight_missing", deal_id=deal_id)
        return []
    targets = [str(t) for t in (pending.get("targets") or []) if t]
    payload_base = dict(pending.get("payload_base") or {})
    preferred = pending.get("preferred_codes") or []
    if not targets or not payload_base:
        return []
    results = _enqueue_email_targets(
        job_name="request_quote",
        deal_id=deal_id,
        targets=targets,
        payload_base=payload_base,
        id_prefix="quote",
    )
    emailed = {str(j.get("to") or "").lower() for j in results if j.get("to")}
    results.extend(
        enqueue_cabinet_rfq(
            deal_id,
            payload_base,
            already_emailed=emailed,
            preferred_codes=list(preferred) if preferred else None,
            transport_mode=payload_base.get("transport_mode"),
        )
    )
    pending["status"] = "sent"
    from datetime import datetime, timezone

    pending["sent_at"] = datetime.now(timezone.utc).isoformat()
    meta["rfq_preflight"] = pending
    meta["rfq_attempted"] = True
    meta["partner_email_jobs"] = results
    update_deal(
        deal_id,
        metadata=meta,
        status="quoting",
        escalate=False,
        paused=False,
    )
    log_info("rfq_preflight_flushed", deal_id=deal_id, sent=len(results))
    return results


def enqueue_freight_quote_emails(
    deal_id: str,
    *,
    route_summary: str,
    cargo_summary: str,
    weight_kg: float | None = None,
    volume_m3: float | None = None,
    ready_date: str | None = None,
    emails: list[str] | None = None,
    corridor: str | None = None,
    transport_mode: str | None = None,
    cargo_class: str | None = None,
    origin_incoterm: str | None = None,
    dest_incoterm: str | None = None,
    incoterms: str | None = None,
    services: list[str] | None = None,
    preferred_codes: list[str] | None = None,
    origin_city: str | None = None,
    destination_city: str | None = None,
    require_mode: bool = False,
    preflight: bool | None = None,
    skip_cabinets: bool = False,
    blocklist: list[str] | None = None,
    rfq_body_override: str | None = None,
) -> list[dict[str, Any]]:
    """Enqueue request_quote jobs for each supplier email + cabinet RFQ markers."""
    targets = list(emails or [])
    if not targets:
        targets = _partner_email_targets()
    if not targets:
        try:
            from agents.procurement import rfq_target_count
            from common.db import list_approved_partner_emails, list_supplier_rfq_emails

            _min_n, max_n = rfq_target_count()
            limit = max(max_n, 10)
            targets = list_supplier_rfq_emails(
                transport_mode=transport_mode,
                corridor=corridor,
                limit=limit,
                preferred_codes=preferred_codes,
                origin_city=origin_city,
                destination_city=destination_city,
                require_mode=require_mode
                or bool(preferred_codes)
                or str(transport_mode or "") in ("container", "rail", "sea"),
            )
            if not targets:
                targets = list_approved_partner_emails(limit=limit)
        except Exception:
            targets = []

    block = {str(e).strip().lower() for e in (blocklist or []) if e}
    if block:
        targets = [t for t in targets if str(t).strip().lower() not in block]

    payload_base = {
        "deal_id": deal_id,
        "rfq_kind": "freight",
        "route_summary": route_summary,
        "cargo_summary": cargo_summary,
        "weight_kg": weight_kg,
        "volume_m3": volume_m3,
        "ready_date": ready_date,
        "corridor": corridor,
        "transport_mode": transport_mode,
        "cargo_class": cargo_class,
        "origin_incoterm": origin_incoterm,
        "dest_incoterm": dest_incoterm,
        "incoterms": incoterms,
        "services": services,
    }
    if rfq_body_override and str(rfq_body_override).strip():
        payload_base["rfq_body_override"] = str(rfq_body_override).strip()[:4000]
    try:
        from agents.procurement import sanitize_rfq_payload
        from common.db import get_deal

        deal = get_deal(deal_id) if deal_id else None
        payload_base = sanitize_rfq_payload(
            payload_base, deal=deal, allow_factory=False
        )
    except Exception as exc:
        log_error(
            "rfq_sanitize_failed",
            deal_id=deal_id,
            kind="freight",
            error=str(exc)[:400],
        )
        return []

    do_preflight = (
        _rfq_preflight_enabled(
            preferred_codes=preferred_codes, transport_mode=transport_mode
        )
        if preflight is None
        else bool(preflight)
    )
    if do_preflight and targets:
        return _store_rfq_preflight(
            deal_id,
            targets=targets,
            payload_base=payload_base,
            preferred_codes=preferred_codes,
        )

    results = _enqueue_email_targets(
        job_name="request_quote",
        deal_id=deal_id,
        targets=targets,
        payload_base=payload_base,
        id_prefix="quote",
    )
    if not skip_cabinets:
        emailed = {str(j.get("to") or "").lower() for j in results if j.get("to")}
        results.extend(
            enqueue_cabinet_rfq(
                deal_id,
                payload_base,
                already_emailed=emailed,
                preferred_codes=preferred_codes,
                transport_mode=transport_mode,
            )
        )
    return results


def enqueue_partner_quote_emails(*args: Any, **kwargs: Any) -> list[dict[str, Any]]:
    """Alias: freight rate RFQ (kept for existing imports)."""
    return enqueue_freight_quote_emails(*args, **kwargs)


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
        job_id=_make_job_id("negotiate", deal_id, to, str(asked)),
    )
