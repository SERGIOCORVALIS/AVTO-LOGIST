"""Client-facing deal lifecycle: quote → contract → payment → tracking → close.

Internal escalations may notify managers; the client still gets a calculated
offer and is guided through the deal by the bot.
"""

from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from typing import Any

from common.company import company_requisites_md, load_company
from common.db import get_latest_contract, save_contract, update_deal


CLIENT_INTENTS = (
    "question",
    "recalculate",
    "request_discount",
    "accept_offer",
    "reject_offer",
    "accept_contract",
    "request_contract_change",
    "payment_sent",
    "tracking",
    "claim",
)

_SHIPMENT_STEPS = (
    "booking",
    "pickup",
    "in_transit",
    "customs",
    "last_mile",
    "delivered",
)

_STEP_RU = {
    "booking": "бронируем место у перевозчика",
    "pickup": "забор груза",
    "in_transit": "в пути",
    "customs": "таможня",
    "last_mile": "последняя миля / выдача",
    "delivered": "доставлен",
}


def detect_client_intent(
    text: str,
    deal: dict[str, Any],
    hinted: str | None = None,
) -> str:
    if hinted in CLIENT_INTENTS:
        return hinted
    low = (text or "").lower().strip()
    if re.search(r"где\s+груз|трек|tracking|статус\s+достав|как\s+едет|где\s+сейчас", low):
        return "tracking"
    if re.search(r"оплатил|оплатили|перевел|перевёл|платёжк|платежк|чек\s+об\s+оплат|деньги\s+ушли", low):
        return "payment_sent"
    if re.search(r"претенз|потеря|поврежд|не\s+доехал|жалоб", low):
        return "claim"
    if re.search(r"пересчит|другую\s+цен|другую\s+ставку|пересчитай", low):
        return "recalculate"
    if re.search(r"скидк|дешевле|торг|уступ|снизь\s+цен|сделайте\s+дешев", low):
        return "request_discount"
    if re.search(r"\bдорого\b", low) and not re.search(
        r"дорого\s+ли|недорого|не\s+дорого", low
    ):
        return "request_discount"
    if re.search(r"не\s+подходит|отказ|не\s+бер", low):
        return "reject_offer"
    if re.search(r"правк[аи].*договор|измени.*договор|в\s+договоре", low):
        return "request_contract_change"
    if re.search(r"согласен\s+с\s+договор|договор\s+ок|подписыва|акцепт", low):
        return "accept_contract"
    if re.search(
        r"^(ок|окей|да|хорошо|согласен|берём|берем|подтверждаю|подходит|поехали|берём\b)",
        low,
    ) or re.search(r"бер(ём|ем)\s+по\s+этой|цена\s+ок|срок\s+ок", low):
        status = deal.get("status") or ""
        if status == "contract":
            return "accept_contract"
        if status in ("negotiation", "pricing", "quoting") and (deal.get("offer") or {}).get("price"):
            return "accept_offer"
    return "question"


def _lifecycle(deal: dict[str, Any]) -> dict[str, Any]:
    meta = deal.get("metadata") if isinstance(deal.get("metadata"), dict) else {}
    life = dict(meta.get("lifecycle") or {})
    life.setdefault("payment", {"status": "none"})
    life.setdefault("shipment", {"status": None, "note": ""})
    return life


def _payment_instructions() -> str:
    bank = (os.getenv("COMPANY_BANK_NAME") or "").strip()
    bik = (os.getenv("COMPANY_BANK_BIK") or "").strip()
    rs = (os.getenv("COMPANY_BANK_RS") or "").strip()
    ks = (os.getenv("COMPANY_BANK_KS") or "").strip()
    company = load_company()
    lines = [
        f"Оплата на {company.legal_name}, ИНН {company.inn}, КПП {company.kpp}.",
    ]
    if rs:
        extra = [f"р/с {rs}"]
        if bank:
            extra.append(bank)
        if bik:
            extra.append(f"БИК {bik}")
        if ks:
            extra.append(f"к/с {ks}")
        lines.append(", ".join(extra) + ".")
    else:
        lines.append(
            "Счёт и платёжные реквизиты выставлю на юрлицо из карточки. "
            "Напишите email для счёта или скажите, что оплатите по реквизитам в чат."
        )
        lines.append(company_requisites_md(company))
        lines.append("Стремимся к 100% предоплате. TRANSINVEST перевозку своими деньгами не финансирует.")
    return "\n".join(lines)


def _contract_excerpt(deal: dict[str, Any], cargo: dict[str, Any], route: dict[str, Any]) -> str:
    row = None
    try:
        row = get_latest_contract(str(deal.get("id")))
    except Exception:
        row = None
    draft = ""
    if row:
        draft = str(row.get("draft_md") or "")
        summary = row.get("client_summary") or ""
    else:
        summary = ""
        try:
            from agents.legal import run_legal_research

            legal = run_legal_research({**deal, "cargo": cargo, "route": route})
            save_contract(str(deal["id"]), legal)
            draft = str(legal.get("contract_draft_md") or "")
            summary = legal.get("client_risk_summary") or ""
        except Exception:
            draft = ""
    if draft:
        body = draft.strip()
        if len(body) > 2800:
            body = body[:2800] + "\n…"
        extra = f"\n\n{summary}" if summary else ""
        return (
            "Черновик договора (экспедиция). Проверьте стороны, маршрут и цену. "
            "Если ок — напишите «согласен с договором». Если нужны правки — напишите какие.\n\n"
            + body
            + extra
        )
    return (
        "Готовлю договор экспедиции по реквизитам компании и этой заявке. "
        "Подтвердите юрлицо плательщика (название, ИНН) — внесу в договор и пришлю на согласование."
    )


def _tracking_reply(deal: dict[str, Any]) -> str:
    life = _lifecycle(deal)
    ship = life.get("shipment") or {}
    step = ship.get("status") or "booking"
    note = ship.get("note") or ""
    offer = deal.get("offer") or {}
    eta = ""
    if offer.get("eta_days_min") or offer.get("eta_days_max"):
        eta = f" Ориентир срока КП: {offer.get('eta_days_min') or '?'}–{offer.get('eta_days_max') or '?'} дн."
    label = _STEP_RU.get(step, step)
    pay = (life.get("payment") or {}).get("status")
    if pay != "paid" and step == "booking":
        return (
            "Пока груз не в пути: жду оплату по счёту. "
            "Как деньги придут — бронирую перевозчика и пришлю статус забора."
            + eta
        )
    return f"Сейчас: {label}.{(' ' + note) if note else ''}{eta} Если появится трек-номер перевозчика — сразу пришлю."


def apply_lifecycle(
    *,
    deal: dict[str, Any],
    deal_id: str,
    text: str,
    cargo: dict[str, Any],
    route: dict[str, Any],
    concierge: dict[str, Any],
    replies: list[str],
) -> dict[str, Any]:
    """Advance quote → contract → payment → tracking. Returns updated deal/replies/status."""
    intent = detect_client_intent(text, deal, concierge.get("client_intent"))
    life = _lifecycle(deal)
    offer = deal.get("offer") if isinstance(deal.get("offer"), dict) else {}
    status = deal.get("status") or "intake"
    out_replies = list(replies)

    if intent == "recalculate":
        return {"deal": deal, "replies": out_replies, "recalculate": True, "lifecycle": life}

    if intent == "accept_offer" and offer.get("price"):
        if deal.get("escalate") or deal.get("paused") or (deal.get("metadata") or {}).get("kp_hold"):
            return {
                "deal": deal,
                "replies": [
                    "КП ещё на проверке у менеджера. Как утвердят — пришлю цифру и можно будет подтверждать."
                ],
                "recalculate": False,
                "lifecycle": life,
            }
        life["offer_accepted"] = True
        life["offer_accepted_at"] = datetime.now(timezone.utc).isoformat()
        excerpt = _contract_excerpt(deal, cargo, route)
        deal = update_deal(
            deal_id,
            status="contract",
            cargo=cargo,
            route=route,
            metadata={**(deal.get("metadata") or {}), "lifecycle": life},
        )
        return {
            "deal": deal,
            "replies": [
                f"Фиксирую КП {float(offer.get('price') or 0):.0f} ₽. Готовлю договор и юридические условия.",
                excerpt,
            ],
            "recalculate": False,
            "lifecycle": life,
        }

    if intent == "accept_contract" or (
        intent == "accept_offer" and status == "contract"
    ):
        life["contract_accepted"] = True
        life["contract_accepted_at"] = datetime.now(timezone.utc).isoformat()
        life["payment"] = {"status": "awaiting"}
        deal = update_deal(
            deal_id,
            status="execution",
            cargo=cargo,
            route=route,
            metadata={**(deal.get("metadata") or {}), "lifecycle": life},
        )
        return {
            "deal": deal,
            "replies": [
                "Договор согласован. Следующий шаг — оплата, затем забор и ведение груза до выдачи.",
                _payment_instructions(),
            ],
            "recalculate": False,
            "lifecycle": life,
        }

    if intent == "request_contract_change":
        return {
            "deal": deal,
            "replies": out_replies
            or [
                "Напишите, что поменять в договоре (сторона, срок, ответственность, адрес). Внесу и пришлю новую редакцию."
            ],
            "recalculate": False,
            "lifecycle": life,
        }

    if intent == "payment_sent":
        life["payment"] = {
            "status": "paid",
            "noted_at": datetime.now(timezone.utc).isoformat(),
            "note": text[:240],
        }
        life["shipment"] = {
            "status": "booking",
            "note": "оплата отмечена, бронируем перевозчика",
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        deal = update_deal(
            deal_id,
            status="execution",
            cargo=cargo,
            route=route,
            metadata={**(deal.get("metadata") or {}), "lifecycle": life},
        )
        return {
            "deal": deal,
            "replies": [
                "Оплату зафиксировал. Ставлю перевозку в работу: бронь → забор → путь → выдача.",
                _tracking_reply(deal),
            ],
            "recalculate": False,
            "lifecycle": life,
        }

    if intent == "tracking":
        return {
            "deal": deal,
            "replies": [_tracking_reply(deal)],
            "recalculate": False,
            "lifecycle": life,
        }

    if intent == "request_discount":
        from agents.client_memory import comparability_reply

        extra = comparability_reply()
        if extra not in out_replies:
            out_replies = [extra] + list(out_replies)
        return {
            "deal": deal,
            "replies": out_replies
            or [
                extra,
                "Не снижаю маржу сразу. Сверяю состав услуги, затем торгуюсь с поставщиком или ищу другую схему.",
            ],
            "recalculate": False,
            "lifecycle": life,
        }

    if intent == "claim":
        return {
            "deal": deal,
            "replies": [
                "Принял претензию. Собираю факты (что случилось, фото/акты, даты) и передаю живому логисту. Юридически значимые решения сама не принимаю.",
            ],
            "recalculate": False,
            "lifecycle": life,
        }

    if status in ("negotiation", "pricing") and offer.get("price") and intent == "question":
        reminder = (
            f"КП в работе: {float(offer.get('price') or 0):.0f} ₽. "
            "Если ок — «согласен», дальше договор, оплата и ведение груза."
        )
        if not any("согласен" in (r or "").lower() for r in out_replies):
            out_replies = list(out_replies) + [reminder]
    if status == "contract" and not out_replies:
        out_replies = [
            "Договор ещё на согласовании. Напишите «согласен с договором» или какие правки внести."
        ]
    if status == "execution" and not out_replies:
        out_replies = [_tracking_reply(deal)]

    return {
        "deal": deal,
        "replies": out_replies,
        "recalculate": False,
        "lifecycle": life,
    }
