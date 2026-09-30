from __future__ import annotations

import json
from typing import Any

from agents.finance import price_offer as _finance_price_offer
from agents.geography import DOMESTIC, is_international
from agents.client_memory import comparability_reply
from common import extract_json, load_prompt, settings
from common.llm import chat_json, gpt_client, model_for


def price_offer(
    cost_total: float,
    policy: dict[str, Any],
    client_ask_discount_pct: float = 0,
) -> dict[str, Any]:
    return _finance_price_offer(cost_total, policy, client_ask_discount_pct)


def factual_quote_messages(
    deal: dict[str, Any],
    offer: dict[str, Any],
    quotes_top: list[dict[str, Any]],
) -> list[str]:
    """First KP: state the number. Do not haggle unless the client asked."""
    q = quotes_top[0] if quotes_top else {}
    eta = f"{q.get('eta_days_min', '?')}–{q.get('eta_days_max', '?')} дн."
    route = deal.get("route") or {}
    corridor = route.get("corridor")
    incoterms = route.get("incoterms") or ""
    mode = route.get("transport_mode") or ""
    price = offer.get("offer_price") or offer.get("price") or 0
    vat_note = ""
    if corridor == DOMESTIC or not is_international(corridor):
        vat_note = " Цена клиенту с НДС."
        msgs = [
            f"КП по перевозке РФ: {price:.0f} {deal.get('currency', 'RUB')}.{vat_note}",
            f"Режим: {mode or 'сборка'}. Срок ориентир {eta}. Только логистика, без таможни.",
        ]
        msgs.extend(_academy_kp_tail(deal, offer, quotes_top))
        return msgs
    extra = f" Условия {incoterms}." if incoterms else ""
    msgs = [
        f"КП: {price:.0f} {deal.get('currency', 'RUB')}.{extra} Международный фрахт — НДС 0%, цепочку не разрываем.",
        f"Срок ориентир {eta}. Состав — по выбранным услугам.",
    ]
    msgs.extend(_academy_kp_tail(deal, offer, quotes_top))
    return msgs


def negotiate_client_messages(
    deal: dict[str, Any],
    offer: dict[str, Any],
    quotes_top: list[dict[str, Any]],
) -> list[str]:
    if settings.openai_api_key:
        try:
            system = load_prompt("gpt", "negotiator.md")
            raw = chat_json(
                gpt_client(),
                model_for("main"),
                system,
                json.dumps(
                    {
                        "deal_status": deal.get("status"),
                        "route": deal.get("route"),
                        "cargo": deal.get("cargo"),
                        "services": (deal.get("metadata") or {}).get("services"),
                        "offer": offer,
                        "top_quote": quotes_top[:1],
                    },
                    ensure_ascii=False,
                ),
            )
            data = extract_json(raw)
            msgs = data.get("client_messages") or []
            if msgs:
                return msgs
        except Exception:
            pass

    q = quotes_top[0] if quotes_top else {}
    eta = f"{q.get('eta_days_min', '?')}–{q.get('eta_days_max', '?')} дн."
    route = deal.get("route") or {}
    corridor = route.get("corridor")
    incoterms = route.get("incoterms") or ""
    mode = route.get("transport_mode") or ""
    if corridor == DOMESTIC or not is_international(corridor):
        return [
            comparability_reply(),
            f"Текущее КП держим: {offer['offer_price']:.0f} {deal.get('currency', 'RUB')}.",
            f"Режим: {mode or 'сборка'}. Срок ориентир {eta}.",
            "Скидку хитростью не выжимаем. Запросила у поставщика улучшение ставки. Сама цифру не режу — как ответят, пересчитаю.",
        ]
    extra = f" Условия {incoterms}." if incoterms else ""
    return [
        comparability_reply(),
        f"Текущее КП держим: {offer['offer_price']:.0f} {deal.get('currency', 'RUB')}.{extra}",
        f"Срок ориентир {eta}.",
        "Сначала сопоставимость условий, затем торг с поставщиком, новый поставщик или новая схема — и только потом снижение маржи.",
    ]


def _academy_kp_tail(
    deal: dict[str, Any],
    offer: dict[str, Any],
    quotes_top: list[dict[str, Any]],
) -> list[str]:
    """Academy §34: КП is a product — included/excluded, free time, validity, alternative."""
    try:
        from agents.tz_policy import academy_active

        if not academy_active(deal.get("policy") if isinstance(deal.get("policy"), dict) else None, layer="kp"):
            return []
        from agents.academy import manager_quote_card, client_academy_messages
        from agents.transport_options import international_alternatives
    except Exception:
        return []
    route = deal.get("route") or {}
    cargo = deal.get("cargo") or {}
    card = manager_quote_card(
        route=route,
        cargo=cargo,
        cost=deal.get("cost_breakdown") or {},
        offer=offer,
        alternatives=international_alternatives(route),
    )
    msgs: list[str] = []
    if card.get("includes"):
        msgs.append("Включено: " + "; ".join(card["includes"][:6]) + ".")
    if card.get("excludes"):
        msgs.append("Не включено: " + "; ".join(card["excludes"][:4]) + ".")
    valid = offer.get("valid_until") or (quotes_top[0].get("valid_until") if quotes_top else None)
    if valid:
        msgs.append(f"Валидность ставки: {valid}. Просроченную не продаём без переподтверждения.")
    msgs.append("Free time по контейнеру/терминалу/авто назову по котировке — до продажи, не после простоя.")
    msgs.extend(client_academy_messages(cargo, route)[:2])
    return msgs
