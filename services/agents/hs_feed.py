"""Import / refresh HS duty rates into Postgres from local dumps or HS_FEED_URL."""

from __future__ import annotations

import csv
import json
import os
from datetime import date
from pathlib import Path
from typing import Any

import httpx

from common.db import db


def rates_dir() -> Path:
    return Path(__file__).resolve().parent / "legal_corpus" / "hs_rates"


def upsert_rate(row: dict[str, Any]) -> None:
    hs = str(row["hs_code"]).strip()
    duty = float(row["duty_pct"])
    vat = float(row.get("vat_pct") or 20)
    source = str(row.get("source") or "seed")
    note = row.get("excise_note")
    effective = row.get("effective_from") or date.today().isoformat()
    raw = row.get("raw") or row
    with db() as conn:
        conn.execute(
            """
            INSERT INTO hs_duty_rates
              (hs_code, duty_pct, vat_pct, excise_note, source, effective_from, raw, updated_at)
            VALUES (%s,%s,%s,%s,%s,%s,%s::jsonb, NOW())
            ON CONFLICT (hs_code) DO UPDATE SET
              duty_pct = EXCLUDED.duty_pct,
              vat_pct = EXCLUDED.vat_pct,
              excise_note = EXCLUDED.excise_note,
              source = EXCLUDED.source,
              effective_from = EXCLUDED.effective_from,
              raw = EXCLUDED.raw,
              updated_at = NOW()
            """,
            (hs, duty, vat, note, source, effective, json.dumps(raw, ensure_ascii=False)),
        )


def load_json_file(path: Path) -> int:
    data = json.loads(path.read_text(encoding="utf-8"))
    items = data if isinstance(data, list) else data.get("rates") or data.get("items") or []
    n = 0
    for item in items:
        if not item.get("hs_code"):
            continue
        upsert_rate({**item, "source": item.get("source") or f"file:{path.name}"})
        n += 1
    return n


def load_csv_file(path: Path) -> int:
    n = 0
    with path.open(encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            if not row.get("hs_code"):
                continue
            upsert_rate(
                {
                    "hs_code": row["hs_code"],
                    "duty_pct": row.get("duty_pct") or row.get("duty") or 5,
                    "vat_pct": row.get("vat_pct") or 20,
                    "excise_note": row.get("excise_note"),
                    "source": row.get("source") or f"file:{path.name}",
                    "effective_from": row.get("effective_from"),
                    "raw": row,
                }
            )
            n += 1
    return n


def load_local_dumps() -> int:
    root = rates_dir()
    if not root.exists():
        return 0
    total = 0
    for path in sorted(root.glob("**/*")):
        if path.suffix.lower() == ".json":
            total += load_json_file(path)
        elif path.suffix.lower() == ".csv":
            total += load_csv_file(path)
    return total


def pull_remote_feed() -> int:
    url = os.getenv("HS_FEED_URL") or ""
    if not url.startswith("http"):
        return 0
    r = httpx.get(url, timeout=30.0)
    r.raise_for_status()
    ct = r.headers.get("content-type", "")
    if "csv" in ct or url.endswith(".csv"):
        tmp = rates_dir() / "_remote.csv"
        rates_dir().mkdir(parents=True, exist_ok=True)
        tmp.write_text(r.text, encoding="utf-8")
        return load_csv_file(tmp)
    data = r.json()
    items = data if isinstance(data, list) else data.get("rates") or []
    n = 0
    for item in items:
        if item.get("hs_code"):
            upsert_rate({**item, "source": item.get("source") or "hs_feed_url"})
            n += 1
    return n


def refresh() -> dict[str, int]:
    local = load_local_dumps()
    remote = 0
    try:
        remote = pull_remote_feed()
    except Exception:
        remote = 0
    return {"local": local, "remote": remote}


def lookup_duty_for_code(hs_code: str) -> dict[str, Any] | None:
    from common.db import lookup_hs_duty

    return lookup_hs_duty(hs_code)


if __name__ == "__main__":
    print(refresh())
