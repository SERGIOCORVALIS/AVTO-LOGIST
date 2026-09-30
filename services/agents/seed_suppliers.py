"""Seed partners/suppliers/contacts from supplier JSON catalogs.

Usage:
  cd services && .venv/Scripts/python -m agents.seed_suppliers
  python -m agents.seed_suppliers --path ../data/suppliers_associations_cis.json --no-approve
  SEED_SUPPLIERS_DRY_RUN=1 python -m agents.seed_suppliers
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

SERVICES_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = Path(__file__).resolve().parents[2]
if str(SERVICES_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICES_ROOT))

DATA_FILE = REPO_ROOT / "data" / "suppliers_trans_russia_2026.json"


def _domain(email: str) -> str | None:
    parts = email.split("@")
    return parts[-1].lower() if len(parts) == 2 else None


def _truthy_env(name: str) -> bool:
    return (os.getenv(name) or "").lower() in ("1", "true", "yes")


def load_catalog(path: Path | None = None) -> dict[str, Any]:
    p = path or DATA_FILE
    if not p.is_file():
        raise FileNotFoundError(f"supplier catalog missing: {p}")
    return json.loads(p.read_text(encoding="utf-8"))


def seed_suppliers(
    *,
    path: Path | None = None,
    dry_run: bool = False,
    approve_contacts: bool = True,
) -> dict[str, int]:
    from common.db import db

    catalog = load_catalog(path)
    suppliers = catalog.get("suppliers") or []
    catalog_source = str(catalog.get("source") or "trans_russia_2026")
    stats = {"partners": 0, "suppliers": 0, "contacts": 0, "skipped": 0}

    if dry_run:
        stats["would_seed"] = len(suppliers)
        stats["with_email"] = sum(1 for s in suppliers if s.get("emails"))
        stats["source"] = catalog_source
        return stats

    with db() as conn:
        for s in suppliers:
            name = str(s.get("name") or "").strip()
            code = str(s.get("code") or "").strip()
            if not name or not code:
                stats["skipped"] += 1
                continue
            modes = list(s.get("modes") or [])
            corridors = list(s.get("corridors") or [])
            emails = [e.strip().lower() for e in (s.get("emails") or []) if e and "@" in e]
            source = str(s.get("source") or catalog_source)
            meta = {
                "source": source,
                "sheets": s.get("sheets") or [],
                "contacts": s.get("contacts") or [],
                "phones": s.get("phones") or [],
                "notes": s.get("notes") or [],
                "imported_at": catalog.get("imported_at"),
            }

            partner_row = conn.execute(
                """
                INSERT INTO partners (name, code, modes, score, active, metadata)
                VALUES (%s, %s, %s, 0.55, TRUE, %s::jsonb)
                ON CONFLICT (code) DO UPDATE SET
                  name = EXCLUDED.name,
                  modes = EXCLUDED.modes,
                  active = TRUE,
                  metadata = partners.metadata || EXCLUDED.metadata,
                  score = partners.score
                RETURNING id
                """,
                (name, code, modes, json.dumps(meta, ensure_ascii=False)),
            ).fetchone()
            partner_id = partner_row["id"]
            stats["partners"] += 1

            conn.execute(
                """
                INSERT INTO suppliers (
                  partner_id, name, code, modes, corridors, contacts,
                  verification, active, metadata
                )
                VALUES (
                  %s, %s, %s, %s, %s, %s::jsonb,
                  %s::jsonb, TRUE, %s::jsonb
                )
                ON CONFLICT (code) DO UPDATE SET
                  partner_id = EXCLUDED.partner_id,
                  name = EXCLUDED.name,
                  modes = EXCLUDED.modes,
                  corridors = EXCLUDED.corridors,
                  contacts = EXCLUDED.contacts,
                  verification = EXCLUDED.verification,
                  active = TRUE,
                  left_market = FALSE,
                  metadata = suppliers.metadata || EXCLUDED.metadata,
                  updated_at = NOW()
                """,
                (
                    partner_id,
                    name,
                    code,
                    modes,
                    corridors,
                    json.dumps(
                        {
                            "people": s.get("contacts") or [],
                            "phones": s.get("phones") or [],
                            "emails": emails,
                        },
                        ensure_ascii=False,
                    ),
                    json.dumps(
                        {
                            "source": source,
                            "verified": approve_contacts,
                        },
                        ensure_ascii=False,
                    ),
                    json.dumps(meta, ensure_ascii=False),
                ),
            )
            stats["suppliers"] += 1

            for email in emails:
                domain = _domain(email)
                conn.execute(
                    """
                    INSERT INTO partner_contacts (
                      partner_id, email, domain, verified, first_email_approved, source_url
                    )
                    VALUES (%s, %s, %s, %s, %s, %s)
                    ON CONFLICT (email) DO UPDATE SET
                      partner_id = EXCLUDED.partner_id,
                      domain = COALESCE(EXCLUDED.domain, partner_contacts.domain),
                      verified = partner_contacts.verified OR EXCLUDED.verified,
                      first_email_approved =
                        partner_contacts.first_email_approved OR EXCLUDED.first_email_approved,
                      source_url = COALESCE(partner_contacts.source_url, EXCLUDED.source_url)
                    """,
                    (
                        partner_id,
                        email,
                        domain,
                        approve_contacts,
                        approve_contacts,
                        source,
                    ),
                )
                stats["contacts"] += 1

    # Always fold PSZhVS / Far-East operators into the same seed pass.
    try:
        from agents.seed_pszhvs import seed_pszhvs_operators

        psz = seed_pszhvs_operators(
            dry_run=False, approve_contacts=approve_contacts
        )
        for k in ("partners", "suppliers", "contacts"):
            stats[k] = int(stats.get(k) or 0) + int(psz.get(k) or 0)
        stats["pszhvs"] = 1
    except Exception:
        stats["pszhvs"] = 0

    return stats


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed suppliers from JSON catalog")
    parser.add_argument(
        "--path",
        type=Path,
        default=None,
        help="Path to supplier JSON (default: data/suppliers_trans_russia_2026.json)",
    )
    parser.add_argument(
        "--no-approve",
        action="store_true",
        help="Do not auto-approve partner contacts for RFQ",
    )
    args = parser.parse_args()

    dry = _truthy_env("SEED_SUPPLIERS_DRY_RUN")
    approve_env = os.getenv("SEED_APPROVE_CONTACTS")
    if approve_env is not None:
        approve_contacts = approve_env.lower() not in ("0", "false", "no")
    else:
        approve_contacts = not args.no_approve

    catalog_path = args.path
    if catalog_path and not catalog_path.is_absolute():
        catalog_path = REPO_ROOT / catalog_path

    stats = seed_suppliers(path=catalog_path, dry_run=dry, approve_contacts=approve_contacts)
    print(json.dumps(stats, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
