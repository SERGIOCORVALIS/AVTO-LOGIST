from __future__ import annotations

import json
from typing import Any

from common import extract_json, load_prompt, settings
from common.company import company_as_dict, company_requisites_md, load_company
from common.llm import chat_json, deepseek_client
from agents.legal_corpus import load_legal_context
from agents.customs import compute_customs_clearance


RESTRICTED_KEYWORDS = [
    "оружие",
    "weapon",
    "наркот",
    "drone military",
    "военн",
]

SANCTIONS_KEYWORDS = [
    "military",
    "двойного назначения",
    "шифрован",
    "radiation",
]


def run_legal_research(deal: dict[str, Any], cargo_est: dict[str, Any] | None = None) -> dict[str, Any]:
    cargo = deal.get("cargo") or {}
    name = (cargo.get("name") or "").lower()

    for kw in RESTRICTED_KEYWORDS:
        if kw in name:
            return {
                "hs_candidates": [],
                "duties_estimate": compute_customs_clearance(deal, {}),
                "compliance_flags": ["restricted_goods"],
                "law_changes_relevant": [],
                "contract_draft_md": "",
                "client_risk_summary": "Товар может относиться к ограниченным категориям — требуется проверка менеджером.",
                "must_approve": True,
                "confidence": 0.9,
                "sources": ["internal_restricted_list"],
                "risk_matrix": [
                    {
                        "code": "restricted",
                        "severity": "critical",
                        "description": "Restricted goods keyword match",
                    }
                ],
            }

    if settings.deepseek_api_key:
        try:
            system = load_prompt("deepseek", "legal.md")
            company = load_company()
            corpus = load_legal_context(
                str(cargo.get("name") or cargo.get("category") or "ндс пошлина")
            )
            user = json.dumps(
                {
                    "company": company_as_dict(company),
                    "company_requisites_md": company_requisites_md(company),
                    "cargo": cargo,
                    "route": deal.get("route"),
                    "cargo_estimate": cargo_est,
                    "amount_rub": deal.get("amount_rub"),
                    "legal_corpus_excerpt": corpus,
                },
                ensure_ascii=False,
            )
            raw = chat_json(
                deepseek_client(),
                settings.deepseek_model,
                system,
                user,
                temperature=0.2,
            )
            data = extract_json(raw)
            data.setdefault("risk_matrix", [])
            # Normalize / fill numeric customs+VAT
            data["duties_estimate"] = compute_customs_clearance(
                deal, data, freight_rub=0.0
            )
            return data
        except Exception:
            pass

    return _heuristic_legal(deal)


def _heuristic_legal(deal: dict[str, Any]) -> dict[str, Any]:
    cargo = deal.get("cargo") or {}
    name = cargo.get("name") or "товар"
    low = name.lower()
    battery = bool(cargo.get("battery")) or any(
        x in low for x in ("powerbank", "пауэр", "аккумул", "li-ion", "литий")
    )
    sanctions_hit = any(k in low for k in SANCTIONS_KEYWORDS)

    # Prefer feed-backed HS codes by category
    if battery:
        code = "8507.60"
        desc = "Li-ion accumulators"
        unc = 0.45
    else:
        cat = (cargo.get("category") or "").lower()
        name_l = low
        if cat == "textile" or any(x in name_l for x in ("ткан", "одежд", "футболк")):
            code, desc, unc = "6109.10", "T-shirts / textile", 0.55
        elif any(x in name_l for x in ("phone", "телефон", "smartphone")):
            code, desc, unc = "8517.13", "Smartphones", 0.5
        elif any(x in name_l for x in ("laptop", "notebook", "ноут")):
            code, desc, unc = "8471.30", "Portable computers", 0.5
        else:
            code, desc, unc = "8518.30", "Headphones / electronics n.e.s.", 0.6
    try:
        from common.db import lookup_hs_duty

        db_row = lookup_hs_duty(code)
    except Exception:
        db_row = None
    duty = float(db_row["duty_pct"]) if db_row else 5.0
    hs = [
        {
            "code": code,
            "description": desc + (" (db feed)" if db_row else " (confirm with broker)"),
            "duty_rate": duty,
            "uncertainty": 0.35 if db_row else unc,
            "duty_source": f"db:{db_row['source']}" if db_row else "heuristic",
        }
    ]
    if not battery and not db_row:
        hs.append(
            {
                "code": "9403.60",
                "description": "Alternative HS — confirm with broker",
                "duty_rate": 10.0,
                "uncertainty": 0.8,
            }
        )

    flags: list[str] = []
    if battery:
        flags.extend(["battery_transport_rules", "possible_certification", "marking_check"])
    if sanctions_hit:
        flags.append("sanctions_review")

    duties = compute_customs_clearance(
        deal,
        {"hs_candidates": hs, "duties_estimate": {}},
        freight_rub=0.0,
    )

    must = (
        battery
        or sanctions_hit
        or duties.get("missing_invoice")
        or (hs[0].get("uncertainty", 1) or 1) >= 0.7
        or (deal.get("amount_rub") or 0) > 300_000
    )

    company = load_company()
    requisites = company_requisites_md(company)
    draft = f"""# Договор транспортно-экспедиторских услуг (черновик)

## Стороны
**Экспедитор:**
{requisites}

**Клиент:** реквизиты указываются в заявке / приложении.

## 1. Предмет
Экспедитор ({company.legal_name}) организует перевозку груза «{name}» по маршруту, указанному в заявке.

## 2. Цена и оплата
Стоимость услуг определяется коммерческим предложением. Ориентировочные ставки действуют до истечения TTL.
Окончательная стоимость фиксируется после подтверждённых ставок перевозчика и таможенной оценки (пошлина + НДС).

## 3. Таможенное оформление
Клиент предоставляет корректные инвойсы и спецификации. Стороны не используют схемы занижения стоимости.
Предварительная оценка: пошлина + НДС 20% (если нет льготы) + брокер. Риски классификации ТН ВЭД — по согласованным условиям.

## 4. Сроки
Сроки доставки ориентировочные и зависят от таможни, досмотров и форс-мажора.

## 5. Ответственность и страхование
Ответственность ограничена условиями договора и страховки. Франшиза — по полису.

## 6. Претензии
Претензионный порядок обязателен до суда.
"""
    summary_parts = []
    if duties.get("missing_invoice"):
        summary_parts.append("Для расчёта пошлины и НДС нужна сумма инвойса.")
    else:
        summary_parts.append(
            f"Оценка таможни: пошлина ≈{duties.get('duty_rub', 0):.0f} ₽, "
            f"НДС {duties.get('vat_pct')}% ≈{duties.get('vat_rub', 0):.0f} ₽, "
            f"итого очистка ≈{duties.get('clearance_total_rub', 0):.0f} ₽."
        )
    if battery:
        summary_parts.append("Батареи: возможны доп. требования по перевозке/сертификации.")

    return {
        "hs_candidates": hs,
        "duties_estimate": duties,
        "compliance_flags": flags,
        "law_changes_relevant": [
            "Учитывать актуальные решения ЕЭК/ФТС по ТН ВЭД и ставкам НДС при ввозе.",
        ],
        "contract_draft_md": draft,
        "client_risk_summary": " ".join(summary_parts),
        "must_approve": must,
        "confidence": 0.45 if duties.get("missing_invoice") else 0.55,
        "sources": ["heuristic_internal", "VAT_DUTY_NOTES", "requires_broker_confirmation"],
        "risk_matrix": [
            {
                "code": "hs_uncertainty",
                "severity": "high" if (hs[0].get("uncertainty") or 0) >= 0.7 else "medium",
                "description": "HS code not broker-confirmed",
                "mitigation": "broker confirmation before contract final",
            },
            {
                "code": "vat_duty_estimate",
                "severity": "medium" if not duties.get("missing_invoice") else "high",
                "description": "Duty+VAT preliminary until invoice/HS confirmed",
                "mitigation": "collect invoice; confirm HS; recalculate",
            },
        ],
    }
