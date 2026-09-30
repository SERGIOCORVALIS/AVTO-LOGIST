"""Quote / RFQ pipeline branched by corridor and selected services."""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from typing import Any

from agents.cargo import has_client_chargeable_basis
from agents.catalog import MODE_LABELS_RU, infer_corridor, selected_service_labels 
from agents.client_memory import followup_due_at, followup_schedule
from agents.customs import compute_customs_clearance, format_customs_for_client
from agents.escalation_matrix import resolve_escalation
from agents.finance import (
    normalize_quote_tax,
    validate_economics,
)
from agents.geography import DOMESTIC, is_international
from agents.legal import run_legal_research
from agents.pek_benchmark import format_own_product
from agents.readiness import classify_calculation, client_readiness_messages
from agents.tz_policy import merge_tz_policy
from agents.negotiator import factual_quote_messages, negotiate_client_messages, price_offer
from agents.rates import allow_mock_rates, compare_quotes, fetch_mock_quotes, is_real_quote, negotiate_carrier
from common import settings
from common.db import (
    create_calendar_event,
    create_escalation,
    escalation_notify_payload,
    list_deal_quotes,
    save_cargo_estimate,
    save_contract,
    save_quote,
    update_deal,
)
from common.fx import get_rates_to_rub, normalize_quote_price, to_rub
from common.queues import (
    enqueue_api_quote_fallback,
    enqueue_freight_quote_emails,
    enqueue_sourcing_emails,
)
from common.logutil import error as log_error, info as log_info
from learning.loop import on_deal_progress, similar_deals


def _require_human_kp_approve(policy: dict[str, Any]) -> bool:
    if "require_human_kp_approve" in policy and policy.get("require_human_kp_approve") is not None:
        return bool(policy.get("require_human_kp_approve"))
    env = os.getenv("REQUIRE_HUMAN_KP_APPROVE")
    if env is not None and str(env).strip() != "":
        return str(env).strip().lower() in ("1", "true", "yes", "on")
    return bool(getattr(settings, "require_human_kp_approve", True))


def fetch_partner_quotes(
    chargeable_kg: float,
    route_summary: str,
    ctx: dict[str, Any] | None = None,
    *,
    deal_id: str | None = None,
) -> list[dict]:
    from agents.adapters import all_adapters

    raw = [a.quote(chargeable_kg, route_summary, ctx=ctx) for a in all_adapters()]
    if deal_id:
        try:
            raw.extend(list_deal_quotes(deal_id))
        except Exception as exc:
            log_error("list_deal_quotes_failed", error=str(exc), deal_id=deal_id)
    good: list[dict] = []
    for q in raw:
        if q.get("error") or float(q.get("price") or 0) >= 999999999:
            log_error(
                "partner_http_quote_rejected",
                deal_id=deal_id,
                partner=q.get("partner") or q.get("source"),
                error=str(q.get("error") or q.get("hidden_fees") or "")[:400],
            )
            continue
        good.append(q)
    return good


def _quote_ctx(route: dict[str, Any], cargo: dict[str, Any]) -> dict[str, Any]:
    name = str(cargo.get("name") or cargo.get("description") or "")
    return {
        "corridor": route.get("corridor"),
        "transport_mode": route.get("transport_mode"),
        "cargo_class": cargo.get("cargo_class"),
        "origin_incoterm": route.get("origin_incoterm"),
        "dest_incoterm": route.get("dest_incoterm"),
        "incoterms": route.get("incoterms"),
        "origin_city": route.get("origin_city") or route.get("pickup_city"),
        "destination_city": route.get("destination_city"),
        "ready_date": route.get("ready_date"),
        "cargo_name": name,
        "cargo_summary": name,
    }


def run_ops_rfq(
    *,
    deal: dict[str, Any],
    deal_id: str,
    cargo: dict[str, Any],
    route: dict[str, Any],
    services: dict[str, Any],
    playbook: dict[str, Any],
) -> dict[str, Any]:
    """Buyout / supplier sourcing without a freight formula."""
    labels = selected_service_labels(services)
    route_summary = f"{route.get('origin_city') or 'CN'} → {route.get('destination_city') or 'RU'} ({route.get('incoterms') or '—'})"
    cargo_summary = (   
        f"{cargo.get('name') or cargo.get('url') or 'SKU'} × {cargo.get('quantity') or 1}; "
        f"class={cargo.get('cargo_class') or '—'}; "
        f"mode={MODE_LABELS_RU.get(str(route.get('transport_mode') or ''), route.get('transport_mode') or '')}; "
        f"chargeable ~{cargo.get('weight_kg') or 0} кг"
    )
    email_jobs = enqueue_sourcing_emails(
        deal_id,
        route_summary=route_summary,
        cargo_summary=cargo_summary,
        weight_kg=float(cargo.get("weight_kg") or 0) or None,
        volume_m3=float(cargo.get("volume_m3") or 0) or None,
        ready_date=route.get("ready_date"),
        corridor=route.get("corridor"),
        transport_mode=route.get("transport_mode"),
        cargo_class=cargo.get("cargo_class"),
        origin_incoterm=route.get("origin_incoterm"),
        dest_incoterm=route.get("dest_incoterm"),
        incoterms=route.get("incoterms"),
        services=labels,
    )
    esc = create_escalation(
        deal_id,
        reason="cn_ops_rfq",
        summary=f"Заявка на {', '.join(labels)} без авторасчёта фрахта",
        recommendation="Менеджер/поставщик: выкуп или подбор поставщика товара в Китае",
        needed_decision="process_ops_request",
    )
    deal = update_deal(
        deal_id,
        status="awaiting_manager",
        cargo=cargo,
        route=route,
        playbook_version=playbook.get("version"),
        metadata={
            **(deal.get("metadata") or {}),
            "services": services,
            "sourcing_email_jobs": email_jobs,
            "partner_email_jobs": email_jobs,
            "rfq_attempted": True,
        },
    )
    replies = [
        f"Принял: {', '.join(labels)}. Это не тариф на перевозку — запрос ушёл поставщикам товара в Китае (выкуп/подбор), не в кабинеты FESCO.",
        "Если ещё нет — пришлите ссылку/SKU, количество и город/рынок в Китае.",
    ]
    return {
        "deal": deal,
        "replies": replies,
        "escalate": not bool(esc.get("duplicate")),
        "escalation_payload": escalation_notify_payload(esc),
    }


def run_freight_quote(
    *,
    deal: dict[str, Any],
    deal_id: str,
    cargo: dict[str, Any],
    route: dict[str, Any],
    services: dict[str, Any],
    policy: dict[str, Any],
    playbook: dict[str, Any],
    analog: dict[str, Any] | None,
    replies: list[str],
    escalate: bool,
    escalation_payload: dict[str, Any] | None,
    client_asked_discount: bool = False,
    send_rfq: bool = True,
) -> dict[str, Any]:
    from agents.cargo import estimate_cargo

    if analog and has_client_chargeable_basis(cargo):
        analog = None

    policy = merge_tz_policy(policy)
    corridor = route.get("corridor") or infer_corridor(route) or DOMESTIC
    ru = corridor == DOMESTIC
    intl = is_international(corridor)
    want_customs = intl and bool(services.get("customs_clearance"))
    want_insurance = bool(services.get("insurance"))
    want_certs = intl and (
        bool(services.get("certification")) or bool(cargo.get("battery"))
    )
    ready = classify_calculation(cargo, route, services)

    est = estimate_cargo({**deal, "cargo": cargo, "route": route}, analog)
    save_cargo_estimate(deal_id, est)
    next_status = "quoting" if ru or not want_customs else "customs"
    deal = update_deal(
        deal_id,
        status=next_status,
        dims_source=est["source"],
        metadata={
            **(deal.get("metadata") or {}),
            "cargo_estimate": est,
            "services": services,
            "calculation_assumptions": ready.get("calculation_assumptions") or [],
            "quote_fidelity": ready.get("level"),
        },
        cargo=cargo,
        route=route,
        calculation_assumptions=ready.get("calculation_assumptions") or [],
        quote_fidelity=ready.get("level"),
    )

    legal: dict[str, Any] = {}
    duties: dict[str, Any] = {}
    if want_customs:
        legal = run_legal_research({**deal, "cargo": cargo, "route": route}, est) 
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
                "services": services,
            },
        )
        restricted = "restricted_goods" in (legal.get("compliance_flags") or [])
        dual = "dual_use" in (legal.get("compliance_flags") or []) or cargo.get("dual_use")
        if restricted or dual:
            reason = "dual_use_hold" if dual and not restricted else "legal_must_approve"
            spec = resolve_escalation(reason)
            esc = create_escalation(
                deal_id,
                reason=reason,
                summary=legal.get("client_risk_summary") or spec.get("note") or "Compliance hold",
                numbers={"confidence": legal.get("confidence"), "duties": duties},
                risks=legal.get("risk_matrix"),
                recommendation=spec.get("note") or "Живой логист + брокер: маршрут/погранпереход/допустимость",
                needed_decision=spec["needed_decision"],
            )
            hold_msg = (
                "По этому грузу compliance hold: не автоматический отказ. "
                "Живой логист и брокер согласуют допустимость. Продолжаю собирать данные и ставки."
                if dual
                else "По этому грузу есть ограничения (compliance). Без серых схем: уточняю нормы и не везу запрещённое."
            )
            if spec.get("stop"):
                return {
                    "deal": deal,
                    "replies": list(replies) + [hold_msg],
                    "escalate": not bool(esc.get("duplicate")),
                    "escalation_payload": escalation_notify_payload(esc),
                }
            escalate = not bool(esc.get("duplicate"))
            escalation_payload = escalation_notify_payload(esc)
            replies = list(replies) + [hold_msg]

    route_summary = f"{route.get('origin_city')} → {route.get('destination_city')}"  
    if route.get("incoterms"):
        route_summary = f"{route_summary} ({route['incoterms']})"
    mode_label = MODE_LABELS_RU.get(str(route.get("transport_mode") or ""), route.get("transport_mode") or "") 
    cargo_summary = (
        f"{cargo.get('name') or 'cargo'} × {cargo.get('quantity') or 1}; "
        f"class={cargo.get('cargo_class') or '—'}; mode={mode_label}; "
        f"chargeable ~{est['chargeable_weight_kg']} кг"
    )
    meta_early = deal.get("metadata") if isinstance(deal.get("metadata"), dict) else {}
    staff_body = (
        meta_early.get("staff_rfq_body")
        or meta_early.get("rfq_body_override")
        or ""
    )
    if isinstance(staff_body, str) and staff_body.strip():
        # Manager-corrected RFQ draft replaces auto cargo blurb.
        cargo_summary = staff_body.strip()[:4000]
        first_line = next(
            (ln.strip() for ln in staff_body.splitlines() if "→" in ln or "->" in ln),
            "",
        )
        if first_line:
            route_summary = first_line.replace("Маршрут:", "").strip() or route_summary
    ctx = _quote_ctx(route, cargo)
    try:
        quotes = fetch_partner_quotes(
            float(est["chargeable_weight_kg"]),
            route_summary,
            ctx=ctx,
            deal_id=deal_id,
        )
    except Exception as exc:
        log_error("partner_http_quote_failed", error=str(exc)[:400])
        quotes = []
    quotes = [q for q in quotes if is_real_quote(q)]
    # Live channels first (email/HTTP/IMAP); file tariffs only as fallback
    live = [q for q in quotes if not str(q.get("source") or "").startswith("file:")]
    if live:
        quotes = live
    quotes = [normalize_quote_tax(q, corridor=corridor, policy=policy) for q in quotes]
    if not quotes and allow_mock_rates():
        quotes = fetch_mock_quotes(
            deal, float(est["chargeable_weight_kg"]), route_summary
        )

    svc_labels = selected_service_labels(services)
    sourcing_jobs: list[dict[str, Any]] = []
    email_hold = False
    if send_rfq:
        meta = deal.get("metadata") if isinstance(deal.get("metadata"), dict) else {}
        # Hold only email blast — partner HTTP/API quotes already fetched above
        # and must still apply (staff email allowlist never disables API).
        email_hold = bool(meta.get("hold_rfq")) or (
            bool(meta.get("consult_manager")) and not meta.get("staff_rfq_send_approved")
        )
        preferred = meta.get("preferred_operators") or meta.get("preferred_codes") or []
        if isinstance(preferred, str):
            preferred = [p.strip() for p in preferred.split(",") if p.strip()]
        staff_emails = meta.get("staff_rfq_emails") or meta.get("rfq_emails") or []
        if isinstance(staff_emails, str):
            staff_emails = [p.strip() for p in staff_emails.split(",") if p.strip()]
        staff_emails = [str(e).strip().lower() for e in staff_emails if e]
        block = meta.get("staff_rfq_blocklist") or []
        if isinstance(block, str):
            block = [p.strip() for p in block.split(",") if p.strip()]
        block_set = {str(e).strip().lower() for e in block if e}
        from agents.schemes import resolve_scheme_defaults

        scheme_raw = str(meta.get("scheme") or route.get("scheme") or "")
        resolved = resolve_scheme_defaults(
            scheme=scheme_raw,
            transport_mode=route.get("transport_mode"),
            corridor=corridor,
            preferred=list(preferred) if preferred else None,
        )
        preferred = list(resolved.get("preferred_operators") or [])
        if resolved.get("scheme_id") and not meta.get("scheme"):
            # Persist catalog scheme onto card for later compare / RFQ.
            try:
                from common.db import update_deal as _upd

                _upd(
                    deal_id,
                    metadata={
                        **meta,
                        "scheme": resolved["scheme_id"],
                        "preferred_operators": preferred,
                    },
                    route={
                        **route,
                        **(
                            {"scheme": resolved["scheme_id"]}
                            if not route.get("scheme")
                            else {}
                        ),
                        **(
                            {"transport_mode": resolved["transport_mode"]}
                            if resolved.get("transport_mode")
                            and not route.get("transport_mode")
                            else {}
                        ),
                    },
                )
            except Exception:
                pass
        if email_hold:
            email_jobs = []
            allow = staff_emails or meta.get("staff_rfq_emails") or []
            hold_msg = (
                "Почта RFQ на паузе по указанию менеджера."
                + (
                    f" Почты: {', '.join(str(x) for x in allow[:8])}."
                    if allow
                    else " Жду список почт."
                )
                + " API-ставки всё равно запрашиваю. В группе: «отправляй» / «одобри RFQ»."
            )
            replies = list(replies) + [hold_msg]
            escalate = True
            escalation_payload = {
                "reason": "rfq_preflight",
                "summary": hold_msg,
                "needed_decision": "approve_rfq",
            }
            try:
                from common.db import update_deal as _upd

                _upd(
                    deal_id,
                    metadata={
                        **(deal.get("metadata") or {}),
                        **meta,
                        "cargo_estimate": est,
                        "services": services,
                        "rfq_hold_reason": "staff_consult",
                        "api_quote_always": True,
                    },
                )
            except Exception:
                pass
        else:
            # Preflight only when manager explicitly gates the card.
            # test_mode alone must NOT block automatic RFQ (staff can still coach).
            # Staff email allowlist filters mail only — never skips FESCO FIT / cabinets.
            gate_rfq = bool(
                meta.get("manager_gate") or meta.get("require_manager_approve")
            ) and not staff_emails
            email_jobs = enqueue_freight_quote_emails(
                deal_id,
                route_summary=route_summary,
                cargo_summary=cargo_summary,
                weight_kg=float(est.get("chargeable_weight_kg") or 0),
                volume_m3=float(est.get("volume_m3") or 0),
                ready_date=route.get("ready_date"),
                corridor=corridor,
                transport_mode=resolved.get("transport_mode") or route.get("transport_mode"),
                cargo_class=cargo.get("cargo_class"),
                origin_incoterm=route.get("origin_incoterm"),
                dest_incoterm=route.get("dest_incoterm"),
                incoterms=route.get("incoterms"),
                services=svc_labels,
                preferred_codes=None if staff_emails else (preferred or None),
                origin_city=route.get("origin_city") or route.get("pickup_city"),
                destination_city=route.get("destination_city"),
                require_mode=bool(resolved.get("require_mode"))
                or bool(preferred)
                or str(route.get("transport_mode") or "") in ("container", "rail", "sea"),
                preflight=True if gate_rfq else False,
                emails=staff_emails or None,
                skip_cabinets=bool(meta.get("skip_cabinets")),
                blocklist=list(block_set) or None,
                rfq_body_override=str(staff_body).strip() if staff_body else None,
            )
        # Reload: preflight path writes metadata.rfq_preflight; stale deal would wipe it.
        try:
            from common.db import get_deal as _get_deal

            deal = _get_deal(deal_id) or deal
        except Exception:
            pass
        if services.get("buyout") or services.get("supplier_sourcing"):
            sourcing_jobs = enqueue_sourcing_emails(
                deal_id,
                route_summary=route_summary,
                cargo_summary=cargo_summary,
                weight_kg=float(cargo.get("weight_kg") or est.get("weight_kg") or 0) or None,
                volume_m3=float(cargo.get("volume_m3") or 0) or None,
                ready_date=route.get("ready_date"),
                corridor=corridor,
                transport_mode=route.get("transport_mode"),
                cargo_class=cargo.get("cargo_class"),
                origin_incoterm=route.get("origin_incoterm"),
                dest_incoterm=route.get("dest_incoterm"),
                incoterms=route.get("incoterms"),
                services=svc_labels,
            )
            email_jobs = list(email_jobs) + list(sourcing_jobs)
    else:
        meta0 = deal.get("metadata") or {}
        email_jobs = list(
            meta0.get("partner_email_jobs")
            or meta0.get("freight_email_jobs")
            or []
        )
        sourcing_jobs = list(meta0.get("sourcing_email_jobs") or [])
    sent_emails = [
        j
        for j in email_jobs
        if j.get("job") and j.get("rfq_kind") != "cabinet" and j.get("to")
    ]
    cabinet_jobs = [j for j in email_jobs if j.get("cabinet")]
    preflight_held = any(j.get("preflight") for j in email_jobs) or bool(
        ((deal.get("metadata") or {}).get("rfq_preflight") or {}).get("status")
        == "pending"
    )
    log_info(
        "supplier_rfq",
        deal_id=deal_id,
        http_quotes=len(quotes),
        email_enqueued=len(sent_emails),
        cabinets=len(cabinet_jobs),
        sourcing=len(sourcing_jobs),
        preflight_held=preflight_held,
    )
    # Cabinet login pages rarely return a rate — schedule API pull if still empty.
    if send_rfq and not quotes and cabinet_jobs and not email_hold:
        try:
            fb = enqueue_api_quote_fallback(
                deal_id,
                reason="cabinet_pending_no_http",
                delay_ms=int(os.getenv("API_QUOTE_FALLBACK_DELAY_MS") or "90000"),
            )
            log_info(
                "api_quote_fallback_scheduled",
                deal_id=deal_id,
                job_id=(fb or {}).get("id"),
                delay_ms=int(os.getenv("API_QUOTE_FALLBACK_DELAY_MS") or "90000"),
            )
        except Exception as exc:
            log_error("api_quote_fallback_schedule_failed", deal_id=deal_id, error=str(exc)[:300])
    client_dims_ok = has_client_chargeable_basis(cargo)
    quotes_pending = not bool(quotes) or not client_dims_ok
    partner_channels_ok = (
        bool(sent_emails)
        or bool(quotes)
        or bool(cabinet_jobs)
        or preflight_held
        or email_hold
    )
    if not partner_channels_ok and not allow_mock_rates():
        esc = create_escalation(
            deal_id,
            reason="missing_partner_channels",
            summary="Нет HTTP-ставок и SUPPLIER_QUOTE_EMAILS / PARTNER_QUOTE_EMAILS / SUPPLIER_EMAIL_* / approved contacts",
            recommendation="Настроить SUPPLIER_EMAIL_* или SUPPLIER_QUOTE_EMAILS (алиасы PARTNER_* тоже читаются; не логин кабинета)",
            needed_decision="configure_suppliers",
        )
        escalate = not bool(esc.get("duplicate"))
        escalation_payload = escalation_notify_payload(esc)

    ranked = compare_quotes(quotes)
    if ranked and client_asked_discount:
        ranked[0] = negotiate_carrier(ranked[0], aggression=0.04, deal_id=deal_id)
        ranked = compare_quotes(ranked)
    ranked = [normalize_quote_price(q) for q in ranked]
    ranked = [normalize_quote_tax(q, corridor=corridor, policy=policy) for q in ranked]
    for q in ranked[:3]:
        save_quote(deal_id, q)

    if quotes_pending or not ranked:
        pending_offer = {
            "price": None,
            "currency": "RUB",
            "is_estimate": True,
            "quotes_pending": True,
            "includes": ["partner_rfq_sent"],
            "excludes": ["client_price_until_carrier_reply"],
        }
        meta_now = dict(deal.get("metadata") or {})
        pf = meta_now.get("rfq_preflight") if isinstance(meta_now.get("rfq_preflight"), dict) else {}
        next_status = "awaiting_manager" if pf.get("status") == "pending" else "quoting"
        deal = update_deal(
            deal_id,
            status=next_status,
            paused=False,
            escalate=bool(pf.get("status") == "pending"),
            offer=pending_offer,
            cargo=cargo,
            route=route,
            metadata={
                **meta_now,
                "cargo_estimate": est,
                "services": services,
                "partner_email_jobs": email_jobs,
                "freight_email_jobs": [j for j in email_jobs if j.get("rfq_kind") != "sourcing"],
                "sourcing_email_jobs": sourcing_jobs,
                "quotes_pending": True,
                "rfq_attempted": True,
            },
        )
        mail_who = [str(j.get("to")) for j in sent_emails if j.get("to")]
        cab_who = [str(j.get("code")) for j in cabinet_jobs if j.get("code")]
        msg = []
        if mail_who:
            msg.append(
                f"По {route_summary} запросила ставки у поставщиков по почте: {', '.join(mail_who[:6])}."
            )
        elif cab_who:
            msg.append(f"По {route_summary} поставила задачу в кабинеты: {', '.join(cab_who)}.")
        else:
            msg.append(f"По {route_summary} собираю ставки поставщиков.")
        if cab_who:
            msg.append(
                f"Кабинеты {', '.join(cab_who)} — если ставка оттуда не придёт, автоматически запрошу по API."
            )
        if sourcing_jobs:
            msg.append("Выкуп/подбор завода в Китае ушёл отдельным письмом, не в кабинеты перевозки.")
        msg.append("Цифру клиенту не называю, пока нет ответа поставщика — не беру цену с потолка.")
        msg.extend(format_own_product(route))
        if not client_dims_ok:
            msg.extend(client_readiness_messages(ready) or [
                "Для точного расчёта нужны вес (кг) или объём (м³). Предварительно считаю по городам на допущениях — это не «невозможно считать»."
            ])
        elif est.get("source") != "client":
            msg.append(
                f"Габариты пока неполные (chargeable ~{est['chargeable_weight_kg']} кг, источник {est['source']}). "
                "Пришлите точный вес/объём — перезапрошу поставщиков и пересчитаю КП."
            )
        else:
            msg.append("Как придут ставки — сразу посчитаю КП с маржой и пришлю.")
        on_deal_progress(deal_id, "partner_rfq_sent", {"email_jobs": email_jobs}) 
        return {
            "deal": deal,
            "replies": msg,
            "escalate": escalate,
            "escalation_payload": escalation_payload,
        }

    best = ranked[0]
    freight = float(
        best.get("effective_supplier_cost")
        or best.get("price_rub")
        or to_rub(best.get("price") or 0, best.get("currency"))
    )

    duty = vat = excise = broker = certs = customs_total = 0.0
    if want_customs:
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
        flags = legal.get("compliance_flags") or []
        gpt_wants_certs = bool(duties.get("battery")) or any(
            "battery" in str(f).lower() or "cert" in str(f).lower() for f in flags
        )
        want_certs = want_certs or gpt_wants_certs or float(duties.get("cert_fee_rub") or 0) > 0
        certs = float(duties.get("cert_fee_rub") or 0) if want_certs else 0.0
        if not want_certs:
            duties = {**duties, "cert_fee_rub": 0}
        customs_total = float(
            duties.get("clearance_total_rub") or (duty + vat + excise + broker + certs)
        )
        if not want_certs:
            customs_total = duty + vat + excise + broker

    local = 0.0 if ru else float(os.getenv("OPS_LOCAL_RUB", policy.get("local_delivery_rub", 8000)))
    insurance_pct = float(os.getenv("OPS_INSURANCE_PCT", policy.get("insurance_pct", 0.02)))
    ops = float(os.getenv("OPS_FEE_RUB", policy.get("ops_fee_rub", 5000)))
    insurance = freight * insurance_pct if want_insurance else 0.0
    risk_buf = freight * 0.03 + (
        5000 if want_customs and duties.get("missing_invoice") else 0
    )
    try:
        peers = similar_deals(str(cargo.get("name") or route_summary), limit=3)
    except Exception:
        peers = []
    cost_total = freight + customs_total + local + insurance + ops + risk_buf

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

    offer = price_offer(
        cost_total,
        {**policy, "corridor": corridor},
        client_ask_discount_pct=0,
    )
    offer["fx_locked_at"] = datetime.now(timezone.utc).isoformat()
    offer["fx_rates"] = get_rates_to_rub()
    offer["quotes_pending"] = False
    offer["playbook"] = {
        "name": playbook.get("name"),
        "version": playbook.get("version"),
        "lane": playbook.get("lane"),
    }
    amount = offer["offer_price"]
    economics = validate_economics(
        cost_total=cost_total,
        offer_price=amount,
        corridor=corridor,
        policy=policy,
    )
    offer["gross_profit_rub"] = economics["gross_profit_rub"]
    offer["client_price_vat_mode"] = "included" if ru else "zero"
    offer["raw_supplier_quote"] = best.get("raw_supplier_quote")
    offer["supplier_vat_mode"] = best.get("supplier_vat_mode")
    offer["effective_supplier_cost"] = best.get("effective_supplier_cost")
    offer["calculation_assumptions"] = ready.get("calculation_assumptions") or []

    if want_customs and duties.get("missing_invoice") and amount >= 150_000:
        esc = create_escalation(
            deal_id,
            reason="missing_invoice_for_vat_duty",
            summary="Нет инвойса — пошлина и НДС не посчитаны; КП без налоговых строк",
            numbers={"offer": amount, "duties": duties},
            risks=legal.get("risk_matrix"),
            recommendation="Запросить инвойс у клиента и пересчитать",
            needed_decision="request_invoice_or_approve_partial_kp",
        )
        escalate = not bool(esc.get("duplicate"))
        escalation_payload = escalation_notify_payload(esc)

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
        escalate = not bool(esc.get("duplicate"))
        escalation_payload = escalation_notify_payload(esc)

    if offer["needs_approve"] or economics.get("needs_human"):
        reason = "profit_below_minimum" if "profit_below_minimum" in economics.get("issues", []) else "margin_or_discount_policy"
        if "cashflow_gap" in economics.get("issues", []):
            reason = "cashflow_gap"
        spec = resolve_escalation(reason)
        esc = create_escalation(
            deal_id,
            reason=reason,
            summary=offer.get("reason") or "; ".join(economics.get("issues") or []) or "Policy breach",
            numbers={**offer, "economics": economics},
            recommendation="Сначала сопоставимость → возражение → торг с поставщиком → новый поставщик → новая схема → только потом снижение маржи",
            needed_decision=spec["needed_decision"],
        )
        escalate = not bool(esc.get("duplicate"))
        escalation_payload = escalation_notify_payload(esc)

    includes = ["freight_estimate"]
    excludes: list[str] = []
    academy_card: dict[str, Any] = {}
    try:
        from agents.academy import manager_quote_card, quote_inclusions
        from agents.tz_policy import academy_active

        if academy_active(policy, layer="kp"):
            academy_inc = quote_inclusions(route, cargo, services)
            includes.extend(academy_inc.get("includes") or [])
            excludes.extend(academy_inc.get("excludes") or [])
            academy_card = manager_quote_card(
                route=route,
                cargo=cargo,
                cost={"freight": freight, "total": cost_total},
                offer=offer,
            )
    except Exception:
        academy_inc = {}
    includes = list(dict.fromkeys(includes))
    excludes = list(dict.fromkeys(excludes))
    if ru:
        excludes.extend(["import_duty", "import_vat", "customs_clearance", "china_buyout"])
        includes.append("ru_logistics_only")
    else:
        if want_customs:
            includes.append("broker_estimate")
            excludes.append("final_hs_confirmation")
            if duties.get("missing_invoice"):
                excludes.extend(["import_duty", "import_vat"])
            else:
                includes.extend(["duty_estimate", "vat_estimate"])
        else:
            excludes.extend(["import_duty", "import_vat", "customs_clearance"])
        if want_insurance:
            includes.append("cargo_insurance")
        else:
            excludes.append("cargo_insurance")
        if services.get("buyout"):
            includes.append("buyout_request")
        if services.get("supplier_sourcing"):
            includes.append("supplier_sourcing_request")

    offer_body: dict[str, Any] = {
        "price": offer["offer_price"],
        "currency": "RUB",
        "is_estimate": True,
        "eta_days_min": best.get("eta_days_min"),
        "eta_days_max": best.get("eta_days_max"),
        "valid_until": best.get("valid_until"),
        "includes": includes,
        "excludes": excludes,
        "raw_supplier_quote": offer.get("raw_supplier_quote"),
        "supplier_vat_mode": offer.get("supplier_vat_mode"),
        "effective_supplier_cost": offer.get("effective_supplier_cost"),
        "client_price_vat_mode": offer.get("client_price_vat_mode"),
        "gross_profit_rub": offer.get("gross_profit_rub"),
        "margin_pct": offer.get("margin_pct"),
        "calculation_assumptions": offer.get("calculation_assumptions") or [],
        "free_time_note": (academy_card.get("free_time") if academy_card else None),
        "scheme": (academy_card.get("scheme") if academy_card else None),
    }
    if want_customs:
        offer_body["customs_summary"] = format_customs_for_client(duties)

    deal = update_deal(
        deal_id,
        status="negotiation" if client_asked_discount else "pricing",
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
            "effective_supplier_cost": best.get("effective_supplier_cost"),
            "supplier_vat_mode": best.get("supplier_vat_mode"),
        },
        offer=offer_body,
        margin_pct=offer["margin_pct"],
        amount_rub=amount,
        risks=legal.get("risk_matrix", []) if legal else deal.get("risks") or [],
        metadata={
            **(deal.get("metadata") or {}),
            "cargo_estimate": est,
            "duties_estimate": duties,
            "services": services,
            "top_quotes": ranked[:3],
            "partner_email_jobs": email_jobs,
            "sourcing_email_jobs": sourcing_jobs,
            "rfq_attempted": True,
            "similar_deals": [
                {
                    "id": str(p.get("id")),
                    "amount_rub": p.get("amount_rub"),
                    "margin_pct": p.get("margin_pct"),
                }
                for p in (peers or [])[:3]
            ],
            "academy_quote_card": academy_card or None,
        },
    )

    if client_asked_discount:
        msg = negotiate_client_messages(deal, offer, ranked)
    else:
        msg = factual_quote_messages(deal, offer, ranked)
    msg.extend(format_own_product(route))
    msg.extend(client_readiness_messages(ready))
    try:
        from agents.transport_options import container_loading_messages

        if str(route.get("transport_mode") or "") == "container":
            msg.extend(container_loading_messages())
        from agents.academy import client_academy_messages
        from agents.tz_policy import academy_active

        if academy_active(policy, layer="kp"):
            msg.extend(client_academy_messages(cargo, route))
    except Exception:
        pass
    try:
        for item in followup_schedule(policy=policy):
            due = followup_due_at(item)
            if due:
                create_calendar_event(
                    deal_id,
                    "followup",
                    f"Follow-up КП {item.get('kind')}",
                    due.isoformat(),
                    item,
                )
    except Exception:
        pass
    if est.get("source") == "client":
        msg.append(
            f"Вес/объём от вас: chargeable {est['chargeable_weight_kg']} кг "
            f"(делитель {est.get('volumetric_divisor')})."
        )
    else:
        msg.append(
            f"КП по ставке поставщика, но габариты неполные (источник {est['source']}, "
            f"chargeable ~{est['chargeable_weight_kg']} кг). "
            "Пришлите точный вес и объём — пересчитаю без выдуманных килограммов."
        )
    if want_customs:
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
    else:
        msg.append("Финально после подтверждения веса/объёма и ставки перевозчика.")
    msg.append(
        "Если цена и срок подходят — напишите «согласен»: подготовлю договор, затем оплата и ведение груза до выдачи."
    )

    # Pilot hold: calculate KP but do not send ₽ to client until staff approve
    if _require_human_kp_approve(policy):
        hold_msgs = [
            "Считаю коммерческое предложение по вашим данным и ставкам рынка.",
            "Цифру клиенту покажет менеджер после проверки — обычно быстро. "
            "Если нужно срочно — напишите, передам в приоритет.",
        ]
        esc = create_escalation(
            deal_id,
            reason="human_kp_approve",
            summary=f"КП готово {amount:.0f} ₽ — ждёт утверждения перед клиентом",
            numbers={"offer": amount, "margin_pct": offer.get("margin_pct"), "cost": cost_total},
            recommendation="Утвердить КП в Management Bot / кабинете — клиенту уйдёт цена",
            needed_decision="approve_kp",
        )
        escalate = not bool(esc.get("duplicate"))
        escalation_payload = escalation_notify_payload(esc)
        meta = {**(deal.get("metadata") or {}), "kp_hold": True, "pending_kp_messages": msg}
        deal = update_deal(
            deal_id,
            status="awaiting_manager",
            escalate=True,
            paused=True,
            offer=offer_body,
            amount_rub=amount,
            margin_pct=offer["margin_pct"],
            metadata=meta,
        )
        on_deal_progress(
            deal_id,
            "quote_held_for_approve",
            {"offer": offer, "best": best, "corridor": corridor},
        )
        return {
            "deal": deal,
            "replies": hold_msgs,
            "escalate": escalate,
            "escalation_payload": escalation_payload,
        }

    replies = msg

    on_deal_progress(
        deal_id,
        "quote_generated",
        {"offer": offer, "best": best, "duties": duties, "corridor": corridor},
    )
    return {
        "deal": deal,
        "replies": replies,
        "escalate": escalate,
        "escalation_payload": escalation_payload,
    }


def run_api_quote_fallback(
    deal_id: str,
    *,
    reason: str = "cabinet_no_reply",
) -> dict[str, Any]:
    """Re-fetch partner HTTP/API quotes when cabinet/operator did not return a rate.

    Does not re-blast supplier emails or cabinet login tasks.
    """
    from common.db import get_deal, get_policy

    deal = get_deal(deal_id)
    if not deal:
        return {"ok": False, "error": "deal_not_found"}

    offer = deal.get("offer") if isinstance(deal.get("offer"), dict) else {}
    if offer.get("price") and not offer.get("quotes_pending"):
        return {"ok": True, "skipped": "already_priced", "price": offer.get("price")}

    existing = []
    try:
        existing = list(list_deal_quotes(deal_id) or [])
    except Exception:
        existing = []
    live_api = [
        q
        for q in existing
        if str(q.get("source") or "").startswith("api:")
        and not q.get("error")
        and float(q.get("price") or 0) < 999999999
        and is_real_quote(q)
    ]
    if live_api:
        return {
            "ok": True,
            "skipped": "has_api_quotes",
            "count": len(live_api),
            "price": live_api[0].get("price"),
        }

    meta = dict(deal.get("metadata") or {})
    last = meta.get("api_quote_fallback_at")
    if last:
        try:
            prev = datetime.fromisoformat(str(last).replace("Z", "+00:00"))
            if datetime.now(timezone.utc) - prev < timedelta(seconds=45):
                return {"ok": True, "skipped": "debounce", "reason": reason}
        except Exception:
            pass

    cargo = dict(deal.get("cargo") or {})
    route = dict(deal.get("route") or {})
    services = dict(meta.get("services") or {"logistics": True})
    policy = get_policy() or {}

    log_info(
        "api_quote_fallback_start",
        deal_id=deal_id,
        reason=reason,
        route=f"{route.get('origin_city')}→{route.get('destination_city')}",
    )
    out = run_freight_quote(
        deal=deal,
        deal_id=deal_id,
        cargo=cargo,
        route=route,
        services=services,
        policy=policy,
        playbook={"id": "api_quote_fallback", "reason": reason},
        analog=None,
        replies=[],
        escalate=False,
        escalation_payload=None,
        send_rfq=False,
    )
    deal2 = out.get("deal") or deal
    offer2 = deal2.get("offer") if isinstance(deal2.get("offer"), dict) else {}
    try:
        from common.db import update_deal as _upd

        _upd(
            deal_id,
            metadata={
                **(deal2.get("metadata") or {}),
                "api_quote_fallback_at": datetime.now(timezone.utc).isoformat(),
                "api_quote_fallback_reason": reason,
            },
        )
    except Exception:
        pass

    priced = bool(offer2.get("price")) and not offer2.get("quotes_pending")
    log_info(
        "api_quote_fallback_done",
        deal_id=deal_id,
        reason=reason,
        priced=priced,
        price=offer2.get("price"),
        status=(deal2 or {}).get("status"),
    )
    return {
        "ok": True,
        "deal_id": deal_id,
        "reason": reason,
        "priced": priced,
        "price": offer2.get("price"),
        "status": (deal2 or {}).get("status"),
        "replies": out.get("replies") or [],
    }
