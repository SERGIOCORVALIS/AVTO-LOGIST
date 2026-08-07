from __future__ import annotations

import json
import random
from typing import Any

from common.db import db, log_learning


def select_playbook(policy: dict[str, Any]) -> dict[str, Any]:
    """Active playbook with optional canary traffic; includes body for pricing merge."""
    canary_pct = int(policy.get("canary_pct", 10))
    default_body = {
        "tone": "commercial",
        "discount_steps": [0, 3, 5],
        "ask_max_questions": 3,
    }
    try:
        with db() as conn:
            active = conn.execute(
                "SELECT * FROM playbook_versions WHERE status = 'active' ORDER BY created_at DESC LIMIT 1"
            ).fetchone()
            canary = conn.execute(
                "SELECT * FROM playbook_versions WHERE status = 'canary' ORDER BY created_at DESC LIMIT 1"
            ).fetchone()
    except Exception:
        return {
            "name": "default",
            "version": "v1",
            "lane": "builtin",
            "body": default_body,
        }

    def _pack(row: dict[str, Any], lane: str) -> dict[str, Any]:
        body = row.get("body") or default_body
        if isinstance(body, str):
            try:
                body = json.loads(body)
            except Exception:
                body = default_body
        return {
            "name": row["name"],
            "version": row["version"],
            "lane": lane,
            "body": body,
        }

    if canary and random.randint(1, 100) <= canary_pct:
        return _pack(canary, "canary")
    if active:
        return _pack(active, "active")
    return {
        "name": "default",
        "version": "v1",
        "lane": "builtin",
        "body": default_body,
    }


def merge_playbook_into_policy(
    policy: dict[str, Any], playbook: dict[str, Any]
) -> dict[str, Any]:
    """Apply playbook body knobs onto pricing policy."""
    out = dict(policy or {})
    body = playbook.get("body") or {}
    if not isinstance(body, dict):
        return out
    for key in (
        "target_margin_pct",
        "floor_margin_pct",
        "max_discount_pct",
        "local_delivery_rub",
        "ops_fee_rub",
        "insurance_pct",
        "ask_max_questions",
    ):
        if key in body and body[key] is not None:
            out[key] = body[key]
    # canary margin boost proposals use relative pp
    if body.get("target_margin_delta_pp") is not None:
        out["target_margin_pct"] = float(out.get("target_margin_pct", 18)) + float(
            body["target_margin_delta_pp"]
        )
    if body.get("discount_steps"):
        out["discount_steps"] = body["discount_steps"]
    out["playbook_lane"] = playbook.get("lane")
    out["playbook_version"] = playbook.get("version")
    return out


def on_deal_progress(deal_id: str, event_type: str, payload: dict[str, Any]) -> None:
    log_learning(deal_id, event_type, payload)
    if event_type in ("quote_generated", "closed_won", "closed_lost", "outcome"):
        try:
            from learning.embeddings import index_deal_embedding

            index_deal_embedding(deal_id)
        except Exception:
            pass


def record_outcome(deal_id: str, body: dict[str, Any]) -> None:
    with db() as conn:
        deal = conn.execute("SELECT * FROM deals WHERE id = %s", (deal_id,)).fetchone()
        if not deal:
            return
        est = conn.execute(
            "SELECT * FROM cargo_estimates WHERE deal_id = %s ORDER BY created_at DESC LIMIT 1",
            (deal_id,),
        ).fetchone()

        actual_weight = body.get("actual_weight_kg")
        actual_volume = body.get("actual_volume_m3")
        category = (deal.get("cargo") or {}).get("category") or "general"
        if isinstance(category, dict):
            category = "general"

        payload = {
            "status": body.get("status") or deal.get("status"),
            "margin_pct": float(deal.get("margin_pct") or 0),
            "amount_rub": float(deal.get("amount_rub") or 0),
            "playbook_version": deal.get("playbook_version"),
            "estimate": dict(est) if est else None,
            "actual_weight_kg": actual_weight,
            "actual_volume_m3": actual_volume,
        }
        conn.execute(
            "INSERT INTO learning_events (deal_id, event_type, payload) VALUES (%s,%s,%s::jsonb)",
            (deal_id, "outcome", json.dumps(payload, default=str)),
        )

        # calibration update
        if est and actual_weight and float(est.get("weight_kg") or 0) > 0:
            ratio = float(actual_weight) / float(est["weight_kg"])
            _upsert_calibration(conn, str(category), weight_ratio=ratio)

        # partner score bump on won
        if (body.get("status") or deal.get("status")) == "closed_won":
            best = conn.execute(
                "SELECT * FROM quotes WHERE deal_id = %s ORDER BY price ASC LIMIT 1",
                (deal_id,),
            ).fetchone()
            if best and best.get("raw"):
                partner = (best.get("raw") or {}).get("partner")
                if partner:
                    conn.execute(
                        "UPDATE partners SET score = LEAST(1.0, score + 0.02) WHERE code = %s",
                        (partner,),
                    )

        # propose playbook tweak if margin systematically high/low
        _maybe_propose_playbook(conn, deal)

    # vector index for RAG (best-effort; outside txn connection)
    try:
        from learning.embeddings import index_deal_embedding

        index_deal_embedding(deal_id)
    except Exception:
        pass


def _upsert_calibration(conn, category: str, weight_ratio: float, volume_ratio: float | None = None) -> None:
    row = conn.execute(
        "SELECT * FROM calibration_coeffs WHERE category = %s", (category,)
    ).fetchone()
    if not row:
        conn.execute(
            """
            INSERT INTO calibration_coeffs (category, volume_factor, weight_factor, sample_count)
            VALUES (%s, %s, %s, 1)
            """,
            (category, volume_ratio or 1.0, weight_ratio),
        )
        return
    n = int(row["sample_count"] or 0)
    new_w = (float(row["weight_factor"]) * n + weight_ratio) / (n + 1)
    new_v = float(row["volume_factor"])
    if volume_ratio:
        new_v = (new_v * n + volume_ratio) / (n + 1)
    conn.execute(
        """
        UPDATE calibration_coeffs
        SET weight_factor = %s, volume_factor = %s, sample_count = %s, updated_at = NOW()
        WHERE category = %s
        """,
        (new_w, new_v, n + 1, category),
    )


def _maybe_propose_playbook(conn, deal: dict[str, Any]) -> None:
    margin = float(deal.get("margin_pct") or 0)
    if margin <= 0:
        return
    # if wins with high margin on electronics — propose +2% target for category
    cargo = deal.get("cargo") or {}
    cat = cargo.get("category") or "general"
    if margin >= 22:
        name = f"margin_boost_{cat}"
        version = f"auto-{deal['id']}"[:24]
        body = {
            "proposal": f"Raise target margin +2pp for category {cat}",
            "based_on_deal": str(deal["id"]),
            "observed_margin": margin,
        }
        conn.execute(
            """
            INSERT INTO playbook_versions (name, version, body, status, canary_pct)
            VALUES (%s,%s,%s::jsonb,'pending_approve',10)
            ON CONFLICT (name, version) DO NOTHING
            """,
            (name, version, json.dumps(body)),
        )


def similar_deals(query_text: str, limit: int = 5) -> list[dict[str, Any]]:
    """Vector RAG when embeddings exist; keyword fallback otherwise."""
    try:
        from learning.embeddings import vector_similar_deals

        hits = vector_similar_deals(query_text, limit=limit)
        if hits:
            return hits
    except Exception:
        pass
    with db() as conn:
        rows = conn.execute(
            """
            SELECT id, cargo, route, margin_pct, amount_rub, status
            FROM deals
            WHERE status IN ('closed_won','closed_lost')
              AND (cargo::text ILIKE %s OR route::text ILIKE %s)
            ORDER BY updated_at DESC LIMIT %s
            """,
            (f"%{query_text[:80]}%", f"%{query_text[:80]}%", limit),
        ).fetchall()
    return rows
