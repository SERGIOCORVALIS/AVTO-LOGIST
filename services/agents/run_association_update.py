"""Full KazATO/BAMAP update: parse → JSON → seed CRM, with run logging.

Usage:
  python -m agents.run_association_update --triggered-by bat
  python -m agents.run_association_update --run-id <uuid> --triggered-by manual
"""

from __future__ import annotations

import argparse
import json
import sys
import traceback
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SERVICES_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = Path(__file__).resolve().parents[2]
if str(SERVICES_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICES_ROOT))

PARSER_ID = "associations_cis"
CATALOG_PATH = REPO_ROOT / "data" / "suppliers_associations_cis.json"
LOG_DIR = REPO_ROOT / "logs" / "parser"


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _load_settings(conn) -> dict[str, Any]:
    row = conn.execute(
        "SELECT enabled, cron, enrich_emails, auto_seed FROM parser_settings WHERE id = %s",
        (PARSER_ID,),
    ).fetchone()
    if not row:
        return {"enabled": True, "cron": "0 6 * * 1", "enrich_emails": True, "auto_seed": True}
    return dict(row)


def _create_run(conn, *, triggered_by: str, staff_id: str | None = None) -> str:
    run_id = str(uuid.uuid4())
    conn.execute(
        """
        INSERT INTO parser_runs (id, parser_id, status, triggered_by, triggered_by_staff_id)
        VALUES (%s, %s, 'running', %s, %s)
        """,
        (run_id, PARSER_ID, triggered_by, staff_id),
    )
    conn.commit()
    return run_id


def _finish_run(
    conn,
    run_id: str,
    *,
    status: str,
    stats: dict[str, Any],
    error: str | None = None,
    log_path: str | None = None,
) -> None:
    conn.execute(
        """
        UPDATE parser_runs
        SET status = %s,
            finished_at = NOW(),
            stats = %s::jsonb,
            error = %s,
            log_path = %s
        WHERE id = %s
        """,
        (status, json.dumps(stats, ensure_ascii=False), error, log_path, run_id),
    )
    conn.commit()


def _mark_running(conn, run_id: str) -> None:
    conn.execute(
        "UPDATE parser_runs SET status = 'running', started_at = NOW() WHERE id = %s",
        (run_id,),
    )
    conn.commit()


def run_association_update(
    *,
    triggered_by: str = "manual",
    run_id: str | None = None,
    staff_id: str | None = None,
    enrich_emails: bool | None = None,
    auto_seed: bool | None = None,
    dry_run: bool = False,
) -> dict[str, Any]:
    from agents.parse_association_carriers import build_catalog
    from agents.seed_suppliers import seed_suppliers
    from common.db import db

    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_path = LOG_DIR / f"run_{_utc_now().strftime('%Y%m%d_%H%M%S')}.log"
    log_lines: list[str] = []

    def log(msg: str) -> None:
        line = f"[{_utc_now().isoformat()}] {msg}"
        log_lines.append(line)
        print(line)

    stats: dict[str, Any] = {"triggered_by": triggered_by, "dry_run": dry_run}
    do_enrich = enrich_emails if enrich_emails is not None else True
    do_seed = auto_seed if auto_seed is not None else True

    try:
        with db() as conn:
            settings = _load_settings(conn)
            do_enrich = settings["enrich_emails"] if enrich_emails is None else enrich_emails
            do_seed = settings["auto_seed"] if auto_seed is None else auto_seed

            if run_id:
                _mark_running(conn, run_id)
            elif not dry_run:
                run_id = _create_run(conn, triggered_by=triggered_by, staff_id=staff_id)

            stats["run_id"] = run_id
            stats["settings"] = {"enrich_emails": do_enrich, "auto_seed": do_seed}

            try:
                log("parse: start")
                catalog, enrich_report = build_catalog(
                    kazato=True,
                    bamap=True,
                    enrich_emails=do_enrich and not dry_run,
                    cache_xlsx=not dry_run,
                )
                stats["parse"] = catalog.get("counts") or {}
                log(
                    f"parse: done total={stats['parse'].get('total')} "
                    f"email={stats['parse'].get('with_email')}"
                )

                if not dry_run:
                    CATALOG_PATH.parent.mkdir(parents=True, exist_ok=True)
                    CATALOG_PATH.write_text(
                        json.dumps(catalog, ensure_ascii=False, indent=2),
                        encoding="utf-8",
                    )
                    stats["catalog_path"] = str(CATALOG_PATH)

                if do_seed and not dry_run:
                    log("seed: start")
                    seed_stats = seed_suppliers(
                        path=CATALOG_PATH,
                        dry_run=False,
                        approve_contacts=False,
                    )
                    stats["seed"] = seed_stats
                    log(
                        f"seed: partners={seed_stats.get('partners')} "
                        f"contacts={seed_stats.get('contacts')}"
                    )
                elif dry_run:
                    stats["seed"] = {
                        "would_seed": len(catalog.get("suppliers") or []),
                        "with_email": sum(
                            1 for s in (catalog.get("suppliers") or []) if s.get("emails")
                        ),
                    }

                if enrich_report is not None:
                    stats["enrich"] = {
                        "found": len(enrich_report.get("found") or []),
                        "not_found": len(enrich_report.get("not_found") or []),
                        "errors": len(enrich_report.get("errors") or []),
                    }

                log_path.write_text("\n".join(log_lines) + "\n", encoding="utf-8")
                stats["log_path"] = str(log_path)

                if run_id and not dry_run:
                    _finish_run(
                        conn,
                        run_id,
                        status="success",
                        stats=stats,
                        log_path=str(log_path),
                    )

                return stats

            except Exception as exc:  # noqa: BLE001
                err = str(exc)
                log(f"error: {err}")
                log(traceback.format_exc())
                try:
                    log_path.write_text("\n".join(log_lines) + "\n", encoding="utf-8")
                except OSError:
                    pass
                stats["error"] = err
                if run_id and not dry_run:
                    _finish_run(
                        conn,
                        run_id,
                        status="failed",
                        stats=stats,
                        error=err,
                        log_path=str(log_path) if log_path.exists() else None,
                    )
                raise

    except Exception as outer:  # noqa: BLE001
        if stats.get("error") or stats.get("parse"):
            raise
        log(f"db unavailable: {outer}")
        stats["db_warning"] = str(outer)
        catalog, enrich_report = build_catalog(
            kazato=True,
            bamap=True,
            enrich_emails=do_enrich and not dry_run,
            cache_xlsx=not dry_run,
        )
        stats["parse"] = catalog.get("counts") or {}
        if not dry_run:
            CATALOG_PATH.write_text(
                json.dumps(catalog, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        if enrich_report is not None:
            stats["enrich"] = {
                "found": len(enrich_report.get("found") or []),
                "not_found": len(enrich_report.get("not_found") or []),
                "errors": len(enrich_report.get("errors") or []),
            }
        log_path.write_text("\n".join(log_lines) + "\n", encoding="utf-8")
        stats["log_path"] = str(log_path)
        return stats


def main() -> None:
    parser = argparse.ArgumentParser(description="Run KazATO/BAMAP association update")
    parser.add_argument("--triggered-by", default="manual")
    parser.add_argument("--run-id", default="")
    parser.add_argument("--staff-id", default="")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--no-enrich", action="store_true")
    parser.add_argument("--no-seed", action="store_true")
    args = parser.parse_args()

    stats = run_association_update(
        triggered_by=args.triggered_by,
        run_id=args.run_id or None,
        staff_id=args.staff_id or None,
        enrich_emails=False if args.no_enrich else None,
        auto_seed=False if args.no_seed else None,
        dry_run=args.dry_run,
    )
    print(json.dumps(stats, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
