from __future__ import annotations

import os
import sys
from pathlib import Path

# Allow `uvicorn orchestrator.app:app` from services/
ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from fastapi import FastAPI
from pydantic import BaseModel, Field 
from common import detect_grey_scheme, settings
from common.db import (
    add_message,
    add_voice_message,
    client_memory_for_prompt,
    create_escalation,
    create_fresh_deal,
    escalation_notify_payload,
    get_or_create_deal,
    get_or_create_deal_by_email,
    get_or_create_deal_by_phone,
    get_deal,
    list_recent_messages,
    get_policy,
    idempotent_get,
    idempotent_set,
    log_learning,
    resolve_client,
    set_active_deal,
    update_deal,
)
from common.logutil import audit, ensure_log_tree, error as log_error, info as log_info
from common.secrets import load_secrets
from common.license import enforce_license

load_secrets()
ensure_log_tree()
enforce_license(service="orchestrator", allow_prompt=sys.stdin.isatty())

from common.boot_guard import assert_production_ready, inspect_boot_config

try:
    _boot = assert_production_ready()
    log_info("boot_guard_ok", boot=_boot)
except RuntimeError as _boot_err:
    log_error("boot_guard_failed", error=str(_boot_err))
    raise

# Idempotent import of Trans Russia 2026 supplier book (skip if SEED_SUPPLIERS_ON_BOOT=false)
_seed_flag = (os.getenv("SEED_SUPPLIERS_ON_BOOT") or "true").strip().lower()
if _seed_flag not in ("0", "false", "no", "off"):
    try:
        from agents.seed_suppliers import seed_suppliers

        _seed_stats = seed_suppliers()
        log_info("suppliers_seeded", **_seed_stats)
    except Exception as _seed_err:
        log_error("suppliers_seed_failed", error=str(_seed_err)[:400])

from common.proxy import http_proxy_url

_px = http_proxy_url()
if _px:
    # host:port only — never log credentials
    log_info("outbound proxy enabled for GPT", host_port=_px.split("@")[-1])

from agents.cargo import has_client_chargeable_basis, search_web_analog
from agents.concierge import run_concierge
from agents.catalog import (
    apply_route_defaults,
    normalize_deal_status,
    ready_to_quote,
    services_from_list,
)
from agents.lifecycle import apply_lifecycle
from agents.order_split import looks_like_new_order
from agents.quote_pipeline import run_api_quote_fallback, run_freight_quote, run_ops_rfq
from agents.restrictions import evaluate_restrictions
from learning.loop import (
    merge_playbook_into_policy,
    select_playbook,
)

app = FastAPI(title="AutoLogistics Orchestrator", version="0.1.0")


class ProcessRequest(BaseModel):
    deal_id: str | None = None
    channel: str = "telegram"
    chat_id: int | None = None
    message_id: int | None = None
    external_id: str | None = None
    call_session_id: str | None = None
    user_id: int | None = None
    text: str
    client_name: str | None = None
    client_email: str | None = None
    idempotency_key: str = Field(..., min_length=1)
    full_quote: bool = False


def _shorten_for_voice(text: str, max_chars: int = 320) -> str:
    import re

    t = re.sub(r"\*\*|__|`", "", text)
    t = re.sub(r"\s+", " ", t).strip()
    if len(t) <= max_chars:
        return t
    cut = t[:max_chars]
    last = cut.rfind(". ")
    if last > 80:
        return cut[: last + 1].strip()
    return cut.rstrip() + "…"


_PRICE_LINE = __import__("re").compile(
    r"("
    r"\d[\d\s]{2,9}\s*(?:₽|руб(?:лей|ля)?|\brub\b|\$|usd|€|eur)"
    r"|примерно\s+\d{4,}"
    r"|(?:цена|стоимость|тариф|ставка)\s*[—:\- ]*\d{4,}"
    r")",
    __import__("re").I,
)


def _strip_invented_prices(replies: list[str]) -> list[str]:
    """Drop GPT lines that invent a freight price before partner rates exist."""
    out: list[str] = []
    for r in replies:
        low = (r or "").lower()
        if "инвойс" in low or "invoice" in low:
            out.append(r)
            continue
        if _PRICE_LINE.search(r or ""):
            continue
        out.append(r)
    return out


_STAGE_RANK = {
    "intake": 0,
    "sizing": 1,
    "customs": 2,
    "quoting": 3,
    "pricing": 4,
    "negotiation": 5,
    "contract": 6,
    "execution": 7,
}


def _hold_deal_stage(prev: str, nxt: str) -> str:
    """Keep GPT from walking a live deal backwards (intake after quoting)."""
    if nxt == "awaiting_manager":
        return prev if prev != "awaiting_manager" else "intake"
    if nxt in ("closed_won", "closed_lost", "cancelled"):
        return nxt
    pr, nr = _STAGE_RANK.get(prev), _STAGE_RANK.get(nxt)
    if pr is not None and nr is not None and nr < pr:
        return prev
    return nxt


def _merge_quote_result(out: dict, escalate: bool, payload: dict | None):
    new_payload = out.get("escalation_payload")
    if new_payload:
        if new_payload.get("duplicate"):
            if not escalate:
                payload = new_payload
        else:
            payload = new_payload
            escalate = True
    elif out.get("escalate"):
        escalate = True
    return out["deal"], out["replies"], escalate, payload


def _write_message(
    req: ProcessRequest,
    deal_id: str,
    direction: str,
    sender: str,
    text: str,
) -> None:
    if req.channel == "voice" and req.call_session_id:
        add_voice_message(deal_id, req.call_session_id, direction, sender, text)
    else:
        add_message(
            deal_id,
            direction,
            sender,
            text,
            tg_chat_id=req.chat_id,
            channel=req.channel,
            tg_message_id=req.message_id if direction == "inbound" else None,
        )


@app.get("/health")
def health():
    from urllib.parse import urlparse

    import redis as redis_lib

    from common.db import db as db_ctx

    checks: dict[str, str] = {}
    try:
        with db_ctx() as conn:
            conn.execute("SELECT 1")
        checks["postgres"] = "ok"
    except Exception:
        checks["postgres"] = "fail"

    try:
        r = redis_lib.from_url(settings.redis_url, socket_connect_timeout=2)
        checks["redis"] = "ok" if r.ping() else "fail"
        r.close()
    except Exception:
        checks["redis"] = "fail"

    ok = checks.get("postgres") == "ok" and checks.get("redis") == "ok"
    db = urlparse(settings.database_url)
    payload = {
        "ok": ok,
        "service": "orchestrator",
        "checks": checks,
        "db_host": db.hostname,
        "db_port": db.port,
        "boot": inspect_boot_config(),
    }
    if not ok:
        from fastapi.responses import JSONResponse

        return JSONResponse(status_code=503, content=payload)
    return payload


@app.post("/process")
def process(req: ProcessRequest):
    try:
        return _process_inner(req)
    except Exception as exc:
        import traceback

        log_error("process_failed", error=str(exc), key=req.idempotency_key)
        traceback.print_exc()
        return {
            "error": "process_failed",
            "fallback_replies": [
                "Принял запрос. Сейчас уточняю детали по маршруту и вернусь с расчётом в ближайшее время.",
            ],
        }


def _process_inner(req: ProcessRequest):
    client_email = (req.client_email or "").strip() or None
    if not client_email and req.channel == "email" and req.external_id and "@" in str(req.external_id):
        client_email = str(req.external_id).strip()

    if req.deal_id:
        pass
    elif req.channel == "voice":
        if not req.external_id:
            return {"error": "external_id (phone) required for voice channel"}
    elif req.channel == "email":
        if not client_email and req.chat_id is None:
            return {"error": "client_email (or external_id email) required for email channel"}
    elif req.chat_id is None:
        return {"error": "chat_id required for telegram channel"}

    log_info(
        "process_start",
        channel=req.channel,
        chat_id=req.chat_id,
        external_id=req.external_id,
        client_email=client_email,
        key=req.idempotency_key,
    )
    cached = idempotent_get(req.idempotency_key)
    if cached:
        return {**cached, "cached": True}

    if req.deal_id:
        deal = get_deal(req.deal_id)
        if not deal:
            return {"error": "deal_not_found"}
        try:
            set_active_deal(
                str(deal["id"]),
                chat_id=deal.get("tg_chat_id") or req.chat_id,
                client_id=deal.get("client_id"),
            )
        except Exception:
            pass
    elif req.channel == "voice":
        deal = get_or_create_deal_by_phone(req.external_id, req.client_name)
    elif req.channel == "email" and client_email:
        deal = get_or_create_deal_by_email(client_email, req.client_name)
    else:
        deal = get_or_create_deal(req.chat_id, req.user_id, req.client_name)
    deal_id = str(deal["id"])

    if deal.get("paused") or deal.get("takeover"):
        _write_message(req, deal_id, "inbound", "client", req.text)
        result = {
            "deal_id": deal_id,
            "channel": req.channel,
            "replies": [],
            "escalate": False,
            "note": "paused_or_takeover",
        }
        idempotent_set(req.idempotency_key, "process", result)
        return result

    policy = get_policy()
    playbook = select_playbook(policy)
    policy = merge_playbook_into_policy(policy, playbook)

    # Hard block grey schemes immediately
    if detect_grey_scheme(req.text):
        esc = create_escalation(
            deal_id,
            reason="grey_scheme_hard_block",
            summary="Клиент запросил потенциально незаконную схему.",
            recommendation="Отказ + объяснить белый процесс",
            needed_decision="acknowledge",
            risks=[{"code": "compliance", "severity": "critical", "description": "grey scheme"}],
        )
        replies = [
            "Такие схемы не сопровождаем. Работаем только легально с полной декларацией.", 
        ]
        result = {
            "deal_id": deal_id,
            "replies": replies,
            "escalate": not bool(esc.get("duplicate")),
            "escalation": escalation_notify_payload(esc),
        }
        _write_message(req, deal_id, "inbound", "client", req.text)
        for r in replies:
            _write_message(req, deal_id, "outbound", "ai", r)
        log_learning(deal_id, "hard_block_grey", {"text": req.text[:500]})
        audit(
            "grey_scheme_hard_block",
            deal_id=deal_id,
            channel=req.channel,
            chat_id=req.chat_id,
        )
        idempotent_set(req.idempotency_key, "process", result)
        return result

    history = list_recent_messages(deal_id, limit=16)
    client_mem = client_memory_for_prompt(
        str(deal["client_id"]) if deal.get("client_id") else None
    )
    if not client_mem:
        # Late bind from channel keys (archive identities)
        resolved = None
        if req.channel == "voice" and req.external_id:
            resolved = resolve_client(phone=req.external_id)
        elif client_email:
            resolved = resolve_client(email=client_email)
        elif req.chat_id is not None:
            resolved = resolve_client(tg_chat_id=req.chat_id)
        if resolved:
            from common.db import link_deal_client

            linked = link_deal_client(deal_id, str(resolved["id"]))
            if linked:
                deal = linked
            client_mem = client_memory_for_prompt(str(resolved["id"]))

    concierge = run_concierge(
        deal, req.text, history=history, client_memory=client_mem
    )
    split = looks_like_new_order(
        req.text,
        deal,
        concierge.get("cargo_updates") or {},
        concierge.get("route_updates") or {},
        hinted=bool(concierge.get("new_order")),
    )
    if split and str(req.text or "").startswith("[system]"):
        split = False
    if split:
        prev_id = deal_id
        if req.channel == "voice":
            deal = create_fresh_deal(
                channel="voice",
                phone=req.external_id,
                client_name=req.client_name or deal.get("client_name"),
                client_id=str(deal["client_id"]) if deal.get("client_id") else None,
            )
        elif req.channel == "email":
            deal = create_fresh_deal(
                channel="email",
                client_email=client_email,
                client_name=req.client_name or deal.get("client_name"),
                client_id=str(deal["client_id"]) if deal.get("client_id") else None,
            )
        else:
            deal = create_fresh_deal(
                channel="telegram",
                chat_id=req.chat_id or deal.get("tg_chat_id"),
                user_id=req.user_id or deal.get("tg_user_id"),
                client_name=req.client_name or deal.get("client_name"),
                client_id=str(deal["client_id"]) if deal.get("client_id") else None,
            )
        deal_id = str(deal["id"])
        client_mem = client_memory_for_prompt(
            str(deal["client_id"]) if deal.get("client_id") else None
        )
        concierge = run_concierge(
            deal, req.text, history=[], client_memory=client_mem
        )
        log_info("new_order_split", prev_deal_id=prev_id, deal_id=deal_id)
        split_note = (
            "Это отдельная заявка — не смешиваю с предыдущим заказом. "
            "Считаю только этот груз и маршрут."
        )
        msgs = list(concierge.get("reply_messages") or [])
        if split_note not in msgs:
            concierge["reply_messages"] = [split_note, *msgs]

    _write_message(req, deal_id, "inbound", "client", req.text)
    cargo = {**(deal.get("cargo") or {}), **(concierge.get("cargo_updates") or {})} 
    route = apply_route_defaults(
        {**(deal.get("route") or {}), **(concierge.get("route_updates") or {})}
    )
    meta = dict(deal.get("metadata") or {})
    services = services_from_list(
        concierge.get("services"),
        route.get("corridor"),
        meta.get("services") if isinstance(meta.get("services"), dict) else None, 
    )
    restriction = evaluate_restrictions(req.text, cargo, route, services)
    if restriction.cargo_updates:
        cargo.update(restriction.cargo_updates)
    if restriction.services_override:
        services = restriction.services_override
    prev_inv = (deal.get("cargo") or {}).get("invoice_value")
    prev_status = deal.get("status") or "intake"
    stage = _hold_deal_stage(
        prev_status,
        normalize_deal_status(concierge.get("next_stage"), prev_status),
    )

    deal = update_deal(
        deal_id,
        cargo=cargo,
        route=route,
        status=stage,
        playbook_version=playbook.get("version"),
        confidence=concierge.get("confidence"),
        metadata={**meta, "services": services},
    )

    replies: list[str] = _strip_invented_prices(list(concierge.get("reply_messages") or []))
    # GPT needs_escalation is ignored except explicit handoff reasons below.
    escalate = False
    escalation_payload = None
    hard = bool(concierge.get("hard_block") or restriction.hard_block)

    if hard:
        if restriction.hard_block and restriction.reply_messages:
            replies = list(restriction.reply_messages)
        elif restriction.note:
            replies.append(restriction.note)
    elif restriction.reply_messages:
        prefix = list(restriction.reply_messages)
        replies = prefix + [m for m in replies if m not in prefix]
    elif restriction.note:
        replies.append(restriction.note)

    if (
        not hard
        and concierge.get("needs_escalation")
        and concierge.get("escalation_reason") == "product_url_unresolved"
    ):
        url_hint = str(cargo.get("url") or "")[:160]
        esc = create_escalation(
            deal_id,
            reason="product_url_unresolved",
            summary=(
                "Товар по ссылке не определён автоматически, клиент название не указал."
                + (f" URL: {url_hint}" if url_hint else "")
            )[:500],
            needed_decision="identify_product",
        )
        escalate = not bool(esc.get("duplicate"))
        escalation_payload = escalation_notify_payload(esc)
        deal = get_deal(deal_id) or deal

    if hard:
        if restriction.escalate or concierge.get("hard_block"):
            esc = create_escalation(
                deal_id,
                reason=str(
                    restriction.escalation_reason
                    or concierge.get("escalation_reason")
                    or "product_restriction"
                ),
                summary="; ".join(replies)[:500],
                needed_decision="acknowledge",
            )
            escalate = not bool(esc.get("duplicate"))
            escalation_payload = escalation_notify_payload(esc)
        deal = update_deal(
            deal_id,
            cargo=cargo,
            route=route,
            status="awaiting_manager" if escalate else "intake",
            metadata={**(deal.get("metadata") or {}), "services": services},
        )
    else:
        ready_for_quote = ready_to_quote(
            cargo, route, services, full_quote=req.full_quote
        )
        offer_body = (deal.get("offer") if isinstance(deal.get("offer"), dict) else {}) or {}
        has_offer = bool(offer_body.get("price")) and not offer_body.get("quotes_pending")
        intent = concierge.get("client_intent")
        asked_discount = intent == "request_discount" and has_offer
        already_rfq = bool(
            (deal.get("metadata") or {}).get("rfq_attempted")
            or (deal.get("metadata") or {}).get("partner_email_jobs")
            or (deal.get("metadata") or {}).get("freight_email_jobs")
            or (deal.get("metadata") or {}).get("sourcing_email_jobs")
        )
        want_recalc = (
            intent == "recalculate"
            or (
                cargo.get("invoice_value") is not None
                and cargo.get("invoice_value") != prev_inv
            )
        )
        can_quote = ready_for_quote and stage not in ("contract", "execution")
        first_quote = not already_rfq and not has_offer
        imap_reprice = bool(req.full_quote) and not has_offer
        # Do not re-run on every intake/sizing/customs turn: that re-sends
        # "собираю ставки" after RFQ. IMAP worker uses full_quote=true.
        if can_quote and (
            first_quote or want_recalc or asked_discount or imap_reprice
        ):
            ops_only = (not services.get("logistics")) and (
                services.get("buyout") or services.get("supplier_sourcing")
            )
            send_rfq = first_quote or want_recalc
            if ops_only:
                out = run_ops_rfq(
                    deal=deal,
                    deal_id=deal_id,
                    cargo=cargo,
                    route=route,
                    services=services,
                    playbook=playbook,
                )
            else:
                analog = (
                    None
                    if has_client_chargeable_basis(cargo)
                    else search_web_analog(str(cargo.get("name") or ""))
                )
                out = run_freight_quote(
                    deal=deal,
                    deal_id=deal_id,
                    cargo=cargo,
                    route=route,
                    services=services,
                    policy=policy,
                    playbook=playbook,
                    analog=analog,
                    replies=replies,
                    escalate=False,
                    escalation_payload=None,
                    client_asked_discount=asked_discount,
                    send_rfq=send_rfq,
                )
            deal, replies, escalate, escalation_payload = _merge_quote_result(
                out, escalate, escalation_payload
            )

        life = apply_lifecycle(
            deal=deal,
            deal_id=deal_id,
            text=req.text,
            cargo=cargo,
            route=route,
            concierge=concierge,
            replies=replies,
        )
        deal = life["deal"]
        if life.get("recalculate") and can_quote and not want_recalc:
            analog = (
                None
                if has_client_chargeable_basis(cargo)
                else search_web_analog(str(cargo.get("name") or ""))
            )
            out = run_freight_quote(
                deal=deal,
                deal_id=deal_id,
                cargo=cargo,
                route=route,
                services=services,
                policy=policy,
                playbook=playbook,
                analog=analog,
                replies=replies,
                escalate=False,
                escalation_payload=None,
                client_asked_discount=asked_discount,
                send_rfq=True,
            )
            deal, replies, escalate, escalation_payload = _merge_quote_result(
                out, escalate, escalation_payload
            )
        elif life.get("replies"):
            replies = life["replies"]

    if escalate and not escalation_payload and concierge.get("escalation_reason"):
        esc = create_escalation(
            deal_id,
            reason=str(concierge["escalation_reason"]),
            summary="Concierge requested escalation",
            needed_decision="review",
        )
        escalation_payload = escalation_notify_payload(esc)
        if escalation_payload.get("duplicate"):
            escalate = False

    if escalate and escalation_payload and escalation_payload.get("duplicate"):
        escalate = False

    for r in replies:
        _write_message(req, deal_id, "outbound", "ai", r)

    if req.channel == "voice":
        replies = [_shorten_for_voice(r) for r in replies if (r or "").strip()]

    result = {
        "deal_id": deal_id,
        "channel": req.channel,
        "replies": replies,
        "escalate": escalate,
        "escalation": escalation_payload,
        "status": deal.get("status"),
        "playbook": playbook,
    }
    idempotent_set(req.idempotency_key, "process", result)
    log_info(
        "process_done",
        deal_id=deal_id,
        status=result.get("status"),
        escalate=escalate,
        replies=len(replies),
    )
    return result


@app.get("/deals/{deal_id}/status")
def deal_status(deal_id: str):
    deal = get_deal(deal_id)
    if not deal:
        return {"error": "not_found"}
    return {
        "deal_id": deal_id,
        "channel": deal.get("channel"),
        "status": deal.get("status"),
        "client_phone": deal.get("client_phone"),
        "client_name": deal.get("client_name"),
        "cargo": deal.get("cargo"),
        "route": deal.get("route"),
        "offer": deal.get("offer"),
        "amount_rub": deal.get("amount_rub"),
        "escalate": deal.get("escalate"),
        "takeover": deal.get("takeover"),
        "services": (deal.get("metadata") or {}).get("services"),
    }


@app.post("/deals/{deal_id}/apply-ops-hint")
def apply_ops_hint(deal_id: str, body: dict):
    """Apply staff logistics hint and optionally re-send freight RFQ."""
    from fastapi import HTTPException

    deal = get_deal(deal_id)
    if not deal:
        raise HTTPException(status_code=404, detail="deal_not_found")

    route = dict(deal.get("route") or {})
    if isinstance(body.get("route"), dict):
        route.update({k: v for k, v in body["route"].items() if v is not None})
    meta = dict(deal.get("metadata") or {})
    if isinstance(body.get("metadata"), dict):
        meta.update(body["metadata"])
    meta["staff_ops_hint_applied_at"] = meta.get("staff_ops_hint_at") or True
    # Allow re-RFQ even if partner_email_jobs already exist
    meta.pop("rfq_attempted", None)

    cargo = dict(deal.get("cargo") or {})
    if isinstance(body.get("cargo"), dict):
        cargo.update({k: v for k, v in body["cargo"].items() if v is not None})
    services = dict(meta.get("services") or {"logistics": True})
    keep_paused = bool(meta.get("paused_keep") or body.get("paused_keep"))
    # Staff allowlist send clears hold.
    if meta.get("staff_rfq_emails") and body.get("rerun_rfq", True) and not meta.get("hold_rfq"):
        meta["hold_rfq"] = False
        meta["consult_manager"] = False
        meta["staff_rfq_send_approved"] = True
        keep_paused = False
    deal = update_deal(
        deal_id,
        route=route,
        cargo=cargo,
        metadata=meta,
        status="quoting",
        paused=True if keep_paused else False,
    )
    try:
        set_active_deal(
            deal_id,
            chat_id=deal.get("tg_chat_id") if deal else None,
            client_id=deal.get("client_id") if deal else None,
        )
    except Exception:
        pass
    rerun = body.get("rerun_rfq", True)
    rfq_sent = 0
    if rerun:
        policy = get_policy() or {}
        playbook = {"id": "ops_hint"}
        out = run_freight_quote(
            deal=deal,
            deal_id=deal_id,
            cargo=cargo,
            route=route,
            services=services,
            policy=policy,
            playbook=playbook,
            analog=None,
            replies=[],
            escalate=False,
            escalation_payload=None,
            send_rfq=True,
        )
        jobs = (out.get("deal") or {}).get("metadata") or {}
        for key in ("partner_email_jobs", "freight_email_jobs"):
            lst = jobs.get(key) or []
            if isinstance(lst, list):
                rfq_sent = max(rfq_sent, len([j for j in lst if j.get("to") or j.get("cabinet")]))
        deal = out.get("deal") or deal
    log_info(
        "ops_hint_applied",
        deal_id=deal_id,
        scheme=route.get("scheme") or meta.get("scheme"),
        rfq_sent=rfq_sent,
        preferred=meta.get("preferred_operators"),
    )
    return {
        "ok": True,
        "deal_id": deal_id,
        "route": route,
        "rfq_sent": rfq_sent,
        "status": (deal or {}).get("status"),
    }


@app.post("/deals/{deal_id}/set-active")
def pin_active_deal(deal_id: str):
    """Pin deal as the active card for its TG chat / client."""
    from fastapi import HTTPException

    deal = get_deal(deal_id)
    if not deal:
        raise HTTPException(status_code=404, detail="deal_not_found")
    updated = set_active_deal(
        deal_id,
        chat_id=deal.get("tg_chat_id"),
        client_id=deal.get("client_id"),
    )
    return {"ok": True, "deal_id": deal_id, "deal": updated}


@app.post("/deals/{deal_id}/flush-rfq")
def flush_pending_rfq(deal_id: str):
    """Staff approved preflight RFQ — enqueue supplier emails now."""
    from fastapi import HTTPException

    from common.queues import flush_rfq_preflight

    deal = get_deal(deal_id)
    if not deal:
        raise HTTPException(status_code=404, detail="deal_not_found")
    results = flush_rfq_preflight(deal_id)
    return {
        "ok": True,
        "deal_id": deal_id,
        "sent": len(results),
        "jobs": results[:30],
    }


@app.post("/deals/{deal_id}/api-quote-fallback")
def api_quote_fallback(deal_id: str, body: dict | None = None):
    """Cabinet/operator did not return a rate — pull live partner HTTP/API quotes."""
    from fastapi import HTTPException

    deal = get_deal(deal_id)
    if not deal:
        raise HTTPException(status_code=404, detail="deal_not_found")
    reason = "cabinet_no_reply"
    if isinstance(body, dict) and body.get("reason"):
        reason = str(body.get("reason"))[:120]
    out = run_api_quote_fallback(deal_id, reason=reason)
    if not out.get("ok") and out.get("error") == "deal_not_found":
        raise HTTPException(status_code=404, detail="deal_not_found")
    return out


@app.get("/deals/{deal_id}/quote-compare")
def quote_compare(deal_id: str, notify: int = 0):
    from fastapi import HTTPException

    from agents.quote_compare import compare_deal_quotes
    from common.queues import enqueue_staff_channel

    out = compare_deal_quotes(deal_id)
    if not out.get("ok"):
        raise HTTPException(status_code=404, detail=out.get("error") or "failed")
    if notify and out.get("count", 0) >= 2:
        enqueue_staff_channel(
            kind="info",
            text=str(out.get("text") or ""),
            deal_id=deal_id,
            job_id=f"quote-compare-{deal_id}-{out.get('count')}",
        )
    return out


@app.post("/deals/{deal_id}/close")
def close_deal(deal_id: str, body: dict):
    from fastapi import HTTPException

    from learning.loop import record_outcome

    deal = get_deal(deal_id)
    if not deal:
        raise HTTPException(status_code=404, detail="deal_not_found")
    status = body.get("status", "closed_won")
    if status in ("closed_won", "closed_lost"):
        if body.get("actual_weight_kg") is None:
            raise HTTPException(
                status_code=400,
                detail="actual_weight_kg required for closed deals (calibration)",
            )
    update_deal(
        deal_id,
        status=status,
        margin_pct=body.get("margin_pct"),
        amount_rub=body.get("amount_rub"),
    )
    from common.db import db

    with db() as conn:
        conn.execute(
            "UPDATE deals SET closed_at = NOW(), updated_at = NOW() WHERE id = %s",
            (deal_id,),
        )
    record_outcome(deal_id, body)
    try:
        from common.tz_store import on_deal_closed

        on_deal_closed(deal, status, body)
    except Exception:
        pass
    return {"ok": True, "deal_id": deal_id, "status": status}
