from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta, timezone
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
    create_calendar_event,
    create_escalation,
    get_or_create_deal,
    get_or_create_deal_by_phone,
    get_deal,
    get_policy,
    idempotent_get,
    idempotent_set,
    log_learning,
    save_cargo_estimate,
    save_contract,
    save_quote,
    update_deal,
)
from common.queues import enqueue_partner_quote_emails
from common.logutil import audit, ensure_log_tree, error as log_error, info as log_info
from common.secrets import load_secrets

load_secrets()
ensure_log_tree()
from agents import (
    compare_quotes,
    estimate_cargo,
    fetch_mock_quotes,
    fetch_partner_quotes,
    negotiate_carrier,
    negotiate_client_messages,
    price_offer,
    run_concierge,
    run_legal_research,
    search_web_analog,
)
from agents.customs import compute_customs_clearance, format_customs_for_client
from common.fx import normalize_quote_price, to_rub
from learning.loop import (
    merge_playbook_into_policy,
    on_deal_progress,
    select_playbook,
    similar_deals,
)
from agents.rates import allow_mock_rates

app = FastAPI(title="AutoLogistics Orchestrator", version="0.1.0")


class ProcessRequest(BaseModel):
    deal_id: str | None = None
    channel: str = "telegram"
    chat_id: int | None = None
    external_id: str | None = None
    call_session_id: str | None = None
    user_id: int | None = None
    text: str
    client_name: str | None = None
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
        )


@app.get("/health")
def health():
    return {"ok": True, "service": "orchestrator"}


@app.post("/process")
def process(req: ProcessRequest):
    if req.channel == "voice":
        if not req.external_id:
            return {"error": "external_id (phone) required for voice channel"}
    elif req.chat_id is None:
        return {"error": "chat_id required for telegram channel"}

    log_info(
        "process_start",
        channel=req.channel,
        chat_id=req.chat_id,
        external_id=req.external_id,
        key=req.idempotency_key,
    )
    cached = idempotent_get(req.idempotency_key)
    if cached:
        return {**cached, "cached": True}

    if req.channel == "voice":
        deal = get_or_create_deal_by_phone(req.external_id, req.client_name)
    else:
        deal = get_or_create_deal(req.chat_id, req.user_id, req.client_name)
    deal_id = str(deal["id"])

    if deal.get("paused") or deal.get("takeover"):
        result = {
            "deal_id": deal_id,
            "channel": req.channel,
            "replies": [],
            "escalate": False,
            "note": "paused_or_takeover",
        }
        idempotent_set(req.idempotency_key, "process", result)
        return result

    _write_message(req, deal_id, "inbound", "client", req.text)

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
            "escalate": True,
            "escalation": {
                "reason": esc["reason"],
                "summary": esc["summary"],
                "needed_decision": esc["needed_decision"],
                "id": str(esc["id"]),
            },
        }
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

    concierge = run_concierge(deal, req.text)
    cargo = {**(deal.get("cargo") or {}), **(concierge.get("cargo_updates") or {})}
    route = {**(deal.get("route") or {}), **(concierge.get("route_updates") or {})}
    stage = concierge.get("next_stage") or deal.get("status") or "intake"

    deal = update_deal(
        deal_id,
        cargo=cargo,
        route=route,
        status=stage if stage != "awaiting_manager" else "awaiting_manager",
        playbook_version=playbook.get("version"),
        confidence=concierge.get("confidence"),
    )

    replies: list[str] = list(concierge.get("reply_messages") or [])
    escalate = bool(concierge.get("needs_escalation"))
    escalation_payload = None

    # Auto pipeline when enough data
    ready_for_quote = bool(
        req.full_quote
        or (
            cargo.get("name")
            and route.get("origin_city")
            and route.get("destination_city")
        )
    )

    if ready_for_quote and stage in ("sizing", "quoting", "pricing", "negotiation", "customs", "intake"):
        # If invoice missing — still size/rates but ask for invoice for duty+VAT
        analog = search_web_analog(str(cargo.get("name")))
        est = estimate_cargo({**deal, "cargo": cargo}, analog)
        save_cargo_estimate(deal_id, est)
        deal = update_deal(
            deal_id,
            status="customs",
            dims_source=est["source"],
            metadata={**(deal.get("metadata") or {}), "cargo_estimate": est},
            cargo=cargo,
        )

        legal = run_legal_research({**deal, "cargo": cargo}, est)
        # Recompute clearance with freight later; first pass without freight
        duties = legal.get("duties_estimate") or compute_customs_clearance(
            {**deal, "cargo": cargo}, legal
        )
        legal["duties_estimate"] = duties
        save_contract(deal_id, legal)
        deal = update_deal(
            deal_id,
            hs_codes=legal.get("hs_candidates", []),
            risks=legal.get("risk_matrix", []),
            status="quoting",
            metadata={
                **(deal.get("metadata") or {}),
                "cargo_estimate": est,
                "duties_estimate": duties,
            },
        )

        restricted = "restricted_goods" in (legal.get("compliance_flags") or [])
        if restricted:
            esc = create_escalation(
                deal_id,
                reason="legal_must_approve",
                summary=legal.get("client_risk_summary") or "Restricted goods",
                numbers={"confidence": legal.get("confidence"), "duties": duties},
                risks=legal.get("risk_matrix"),
                recommendation="Стоп до проверки compliance",
                needed_decision="approve_legal",
            )
            escalate = True
            escalation_payload = {
                "reason": esc["reason"],
                "summary": esc["summary"],
                "needed_decision": esc["needed_decision"],
                "id": str(esc["id"]),
            }
            replies = list(replies) + [
                "По этому грузу нужны проверки по ограничениям — эскалировал менеджеру. Без «серых» схем работаем только вбелую."
            ]
        else:
            route_summary = f"{route.get('origin_city')} → {route.get('destination_city')}"
            cargo_summary = (
                f"{cargo.get('name') or 'cargo'} × {cargo.get('quantity') or 1}; "
                f"chargeable ~{est['chargeable_weight_kg']} кг"
            )
            try:
                quotes = fetch_partner_quotes(
                    float(est["chargeable_weight_kg"]), route_summary
                )
            except Exception:
                quotes = []
            if not quotes and allow_mock_rates():
                quotes = fetch_mock_quotes(
                    deal, float(est["chargeable_weight_kg"]), route_summary
                )

            # Auto-enqueue rate requests to logistics partners (IMAP replies fill quotes)
            email_jobs = enqueue_partner_quote_emails(
                deal_id,
                route_summary=route_summary,
                cargo_summary=cargo_summary,
                weight_kg=float(est.get("chargeable_weight_kg") or 0),
                volume_m3=float(est.get("volume_m3") or 0),
            )
            quotes_pending = not bool(quotes)
            partner_channels_ok = bool(email_jobs) or bool(quotes)
            if not partner_channels_ok and not allow_mock_rates():
                esc = create_escalation(
                    deal_id,
                    reason="missing_partner_channels",
                    summary="Нет HTTP-ставок и PARTNER_QUOTE_EMAILS / approved contacts",
                    recommendation="Настроить PARTNER_HTTP_*/CDEK или PARTNER_QUOTE_EMAILS",
                    needed_decision="configure_partners",
                )
                escalate = True
                escalation_payload = {
                    "reason": esc["reason"],
                    "summary": esc["summary"],
                    "needed_decision": esc["needed_decision"],
                    "id": str(esc["id"]),
                }

            ranked = compare_quotes(quotes)
            if ranked:
                ranked[0] = negotiate_carrier(
                    ranked[0], aggression=0.04, deal_id=deal_id
                )
                ranked = compare_quotes(ranked)
            ranked = [normalize_quote_price(q) for q in ranked]
            for q in ranked[:3]:
                save_quote(deal_id, q)

            best = ranked[0] if ranked else {
                "price": 0,
                "price_rub": 0,
                "currency": "RUB",
                "quotes_pending": True,
            }
            freight = float(
                best.get("price_rub")
                or to_rub(best.get("price") or 0, best.get("currency"))
            )

            # Customs + VAT (НДС) based on invoice / HS — not a % of freight
            duties = compute_customs_clearance(
                {**deal, "cargo": cargo},
                {**legal, "duties_estimate": duties},
                freight_rub=freight,
            )
            legal["duties_estimate"] = duties

            duty = float(duties.get("duty_rub") or 0)
            vat = float(duties.get("vat_rub") or 0)
            excise = float(duties.get("excise_rub") or 0)
            broker = float(duties.get("broker_fee_rub") or 0)
            certs = float(duties.get("cert_fee_rub") or 0)
            customs_total = float(duties.get("clearance_total_rub") or (duty + vat + excise + broker + certs))

            local = float(os.getenv("OPS_LOCAL_RUB", policy.get("local_delivery_rub", 8000)))
            insurance_pct = float(os.getenv("OPS_INSURANCE_PCT", policy.get("insurance_pct", 0.02)))
            ops = float(os.getenv("OPS_FEE_RUB", policy.get("ops_fee_rub", 5000)))
            insurance = freight * insurance_pct
            risk_buf = freight * 0.03 + (5000 if duties.get("missing_invoice") else 0)
            # Soft hint from similar closed deals (RAG / keyword)
            try:
                peers = similar_deals(str(cargo.get("name") or route_summary), limit=3)
            except Exception:
                peers = []
            cost_total = freight + customs_total + local + insurance + ops + risk_buf

            # SLA calendar row (quote validity follow-up)
            try:
                due = (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat()
                create_calendar_event(
                    deal_id,
                    "quote_sla",
                    f"Quote SLA: {route_summary}",
                    due,
                    {"email_jobs": email_jobs, "peers": [str(p.get("id")) for p in peers]},
                )
            except Exception:
                pass

            from common.fx import get_rates_to_rub

            offer = price_offer(cost_total, policy)
            offer["fx_locked_at"] = datetime.now(timezone.utc).isoformat()
            offer["fx_rates"] = get_rates_to_rub()
            offer["quotes_pending"] = quotes_pending
            offer["playbook"] = {
                "name": playbook.get("name"),
                "version": playbook.get("version"),
                "lane": playbook.get("lane"),
            }
            amount = offer["offer_price"]

            # Escalate: legal uncertainty OR missing invoice on large deals OR must_approve
            if legal.get("must_approve") and not duties.get("missing_invoice"):
                # soft: still quote but may escalate on amount/policy below
                pass

            if duties.get("missing_invoice") and amount >= 150_000:
                esc = create_escalation(
                    deal_id,
                    reason="missing_invoice_for_vat_duty",
                    summary="Нет инвойса — пошлина и НДС не посчитаны; КП без налоговых строк",
                    numbers={"offer": amount, "duties": duties},
                    risks=legal.get("risk_matrix"),
                    recommendation="Запросить инвойс у клиента и пересчитать",
                    needed_decision="request_invoice_or_approve_partial_kp",
                )
                escalate = True
                escalation_payload = {
                    "reason": esc["reason"],
                    "summary": esc["summary"],
                    "needed_decision": esc["needed_decision"],
                    "id": str(esc["id"]),
                }

            if amount >= float(policy.get("escalate_amount_rub", settings.escalate_amount_rub)):
                esc = create_escalation(
                    deal_id,
                    reason="amount_threshold",
                    summary=f"Сумма КП {amount:.0f} превышает порог эскалации",
                    numbers={
                        "offer": amount,
                        "margin_pct": offer["margin_pct"],
                        "cost": cost_total,
                        "duty": duty,
                        "vat": vat,
                    },
                    recommendation="Approve large deal pricing",
                    needed_decision="approve_price",
                )
                escalate = True
                escalation_payload = {
                    "reason": esc["reason"],
                    "summary": esc["summary"],
                    "needed_decision": esc["needed_decision"],
                    "id": str(esc["id"]),
                }

            if offer["needs_approve"]:
                esc = create_escalation(
                    deal_id,
                    reason="margin_or_discount_policy",
                    summary=offer.get("reason") or "Policy breach",
                    numbers=offer,
                    recommendation="Approve below-floor or excess discount",
                    needed_decision="approve_price",
                )
                escalate = True
                escalation_payload = {
                    "reason": esc["reason"],
                    "summary": esc["summary"],
                    "needed_decision": esc["needed_decision"],
                    "id": str(esc["id"]),
                }

            includes = ["freight_estimate", "broker_estimate"]
            excludes = ["final_hs_confirmation"]
            if duties.get("missing_invoice"):
                excludes.extend(["import_duty", "import_vat"])
            else:
                includes.extend(["duty_estimate", "vat_estimate"])

            deal = update_deal(
                deal_id,
                status="negotiation" if not escalate else "awaiting_manager",
                cost_breakdown={
                    "freight": freight,
                    "customs": customs_total,
                    "duty": duty,
                    "vat": vat,
                    "excise": excise,
                    "broker": broker,
                    "certs": certs,
                    "local": local,
                    "insurance": insurance,
                    "ops": ops,
                    "risk_buffer": risk_buf,
                    "total": cost_total,
                    "duties_estimate": duties,
                },
                offer={
                    "price": offer["offer_price"],
                    "currency": "RUB",
                    "is_estimate": True,
                    "eta_days_min": best.get("eta_days_min"),
                    "eta_days_max": best.get("eta_days_max"),
                    "valid_until": best.get("valid_until"),
                    "includes": includes,
                    "excludes": excludes,
                    "customs_summary": format_customs_for_client(duties),
                },
                margin_pct=offer["margin_pct"],
                amount_rub=amount,
                risks=legal.get("risk_matrix", []),
                metadata={
                    **(deal.get("metadata") or {}),
                    "cargo_estimate": est,
                    "duties_estimate": duties,
                    "top_quotes": ranked[:3],
                    "partner_email_jobs": email_jobs,
                    "similar_deals": [
                        {
                            "id": str(p.get("id")),
                            "amount_rub": p.get("amount_rub"),
                            "margin_pct": p.get("margin_pct"),
                        }
                        for p in (peers or [])[:3]
                    ],
                },
            )

            if not escalate:
                msg = negotiate_client_messages(deal, offer, ranked)
                msg.append(
                    f"Оценка габаритов: chargeable ~{est['chargeable_weight_kg']} кг "
                    f"(источник {est['source']}, погрешность ±{est['error_band_pct']}%)."
                )
                msg.append(format_customs_for_client(duties))
                if legal.get("client_risk_summary"):
                    msg.append(legal["client_risk_summary"])
                msg.append(
                    "Финально после инвойса, подтверждения ТН ВЭД и ставок перевозчика. "
                    "Пошлина и НДС — предварительная оценка."
                )
                if duties.get("missing_invoice"):
                    msg.append(
                        "Чтобы посчитать пошлину и НДС точно — пришлите сумму инвойса и валюту (USD/CNY/RUB)."
                    )
                replies = msg

            on_deal_progress(
                deal_id,
                "quote_generated",
                {"offer": offer, "best": best, "duties": duties},
            )

    if escalate and not escalation_payload and concierge.get("escalation_reason"):
        esc = create_escalation(
            deal_id,
            reason=str(concierge["escalation_reason"]),
            summary="Concierge requested escalation",
            needed_decision="review",
        )
        escalation_payload = {
            "reason": esc["reason"],
            "summary": esc["summary"],
            "needed_decision": esc["needed_decision"],
            "id": str(esc["id"]),
        }

    for r in replies:
        _write_message(req, deal_id, "outbound", "ai", r)

    if req.channel == "voice":
        replies = [_shorten_for_voice(r) for r in replies if r.strip()]

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
    }


@app.post("/deals/{deal_id}/close")
def close_deal(deal_id: str, body: dict):
    from fastapi import HTTPException

    from learning.loop import record_outcome

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
    return {"ok": True, "deal_id": deal_id, "status": status}
