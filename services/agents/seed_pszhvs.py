"""PSZhVS / Far-East container operators — part of normal supplier seed."""

from __future__ import annotations

import json
from typing import Any

OPERATORS: list[dict[str, Any]] = [
    {
        "code": "fesco",
        "name": "FESCO",
        "modes": ["container", "rail", "sea"],
        "corridors": ["ru_domestic", "cn_import", "international"],
        "strong_lanes": [
            {"origin": "Новосибирск", "dest": "Корсаков", "scheme": "pszhvs"},
            {"origin": "Новосибирск", "dest": "Владивосток", "scheme": "rail_sea"},
        ],
        "emails": ["okk_nvsb@fesco.com", "yakolupina@fesco.com", "fpkl@fesco.com"],
    },
    {
        "code": "transcontainer",
        "name": "ТрансКонтейнер",
        "modes": ["container", "rail", "sea"],
        "corridors": ["ru_domestic", "cn_import", "international"],
        "strong_lanes": [
            {"origin": "Новосибирск", "dest": "Корсаков", "scheme": "pszhvs"},
            {"origin": "Новосибирск", "dest": "Владивосток", "scheme": "rail"},
        ],
        "emails": [
            "malinkinana@trcont.ru",
            "kondratevaln@trcont.ru",
            "burdakovaov@trcont.ru",
        ],
    },
    {
        "code": "sasco",
        "name": "САСКО Логистик",
        "modes": ["container", "rail", "sea"],
        "corridors": ["ru_domestic"],
        "strong_lanes": [
            {"origin": "Новосибирск", "dest": "Корсаков", "scheme": "pszhvs"},
            {"origin": "Москва", "dest": "Корсаков", "scheme": "pszhvs"},
        ],
        "emails": ["info@sasco-logistics.ru"],
    },
    {
        "code": "kasco",
        "name": "КАСКО (KASCO)",
        "modes": ["container", "rail", "sea"],
        "corridors": ["ru_domestic"],
        "strong_lanes": [
            {"origin": "Новосибирск", "dest": "Корсаков", "scheme": "pszhvs"},
            {"origin": "Новосибирск", "dest": "Камчатка", "scheme": "pszhvs"},
        ],
        "emails": [
            "vnizovskikh@kasco.su",
            "elikhovidov@kasco.su",
            "mkoneva@kasco.su",
            "vl@kasco.su",
        ],
    },
    {
        "code": "dvlk",
        "name": "ДВЛК",
        "modes": ["container", "rail", "sea"],
        "corridors": ["ru_domestic"],
        "strong_lanes": [
            {"origin": "Новосибирск", "dest": "Корсаков", "scheme": "pszhvs"},
            {"origin": "Владивосток", "dest": "Корсаков", "scheme": "sea"},
        ],
        "emails": ["nsk@dvlk.su", "info@dvlk.su", "sales@dvlk.su"],
    },
]


def seed_pszhvs_operators(*, dry_run: bool = False, approve_contacts: bool = True) -> dict[str, int]:
    """Upsert PSZhVS operators into partners/suppliers/contacts."""
    from common.db import db

    stats = {"partners": 0, "suppliers": 0, "contacts": 0}
    if dry_run:
        stats["would_seed"] = len(OPERATORS)
        return stats

    with db() as conn:
        for op in OPERATORS:
            code = op["code"]
            name = op["name"]
            partner = conn.execute(
                """
                INSERT INTO partners (name, code, modes, active, metadata)
                VALUES (%s, %s, %s, TRUE, %s::jsonb)
                ON CONFLICT (code) DO UPDATE SET
                  name = EXCLUDED.name,
                  modes = EXCLUDED.modes,
                  active = TRUE
                RETURNING id
                """,
                (
                    name,
                    code,
                    op["modes"],
                    json.dumps({"source": "pszhvs_seed"}, ensure_ascii=False),
                ),
            ).fetchone()
            pid = partner["id"]
            stats["partners"] += 1
            conn.execute(
                """
                INSERT INTO suppliers (
                  partner_id, name, code, modes, corridors, strong_lanes,
                  contacts, active, left_market, silent, metadata
                )
                VALUES (%s,%s,%s,%s,%s,%s::jsonb,%s::jsonb,TRUE,FALSE,FALSE,%s::jsonb)
                ON CONFLICT (code) DO UPDATE SET
                  partner_id = EXCLUDED.partner_id,
                  name = EXCLUDED.name,
                  modes = EXCLUDED.modes,
                  corridors = EXCLUDED.corridors,
                  strong_lanes = EXCLUDED.strong_lanes,
                  contacts = EXCLUDED.contacts,
                  active = TRUE,
                  left_market = FALSE,
                  silent = FALSE,
                  updated_at = NOW()
                """,
                (
                    pid,
                    name,
                    code,
                    op["modes"],
                    op["corridors"],
                    json.dumps(op["strong_lanes"], ensure_ascii=False),
                    json.dumps({"emails": op["emails"]}, ensure_ascii=False),
                    json.dumps({"source": "pszhvs_seed"}, ensure_ascii=False),
                ),
            )
            stats["suppliers"] += 1
            for email in op["emails"]:
                domain = email.split("@")[-1].lower()
                conn.execute(
                    """
                    INSERT INTO partner_contacts (
                      partner_id, email, domain, verified, first_email_approved, source_url
                    )
                    VALUES (%s,%s,%s,%s,%s,%s)
                    ON CONFLICT (email) DO UPDATE SET
                      partner_id = EXCLUDED.partner_id,
                      verified = partner_contacts.verified OR EXCLUDED.verified,
                      first_email_approved =
                        partner_contacts.first_email_approved OR EXCLUDED.first_email_approved
                    """,
                    (
                        pid,
                        email.lower(),
                        domain,
                        approve_contacts,
                        approve_contacts,
                        "pszhvs_seed",
                    ),
                )
                stats["contacts"] += 1
    return stats
