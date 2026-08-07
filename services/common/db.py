from __future__ import annotations

import json
import re
from contextlib import contextmanager
from typing import Any, Iterator

import psycopg
from psycopg.rows import dict_row

from common import settings


def normalize_phone(phone: str) -> str:
    """Normalize to E.164 (+digits)."""
    raw = (phone or "").strip()
    if raw.startswith("+"):
        digits = re.sub(r"\D", "", raw[1:])
        if not digits:
            raise ValueError("empty phone")
        return f"+{digits}"
    digits = re.sub(r"\D", "", raw)
    if not digits:
        raise ValueError("empty phone")
    if digits.startswith("8") and len(digits) == 11:
        digits = "7" + digits[1:]
    return f"+{digits}"


@contextmanager
def db() -> Iterator[psycopg.Connection]:
    conn = psycopg.connect(settings.database_url, row_factory=dict_row)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def get_or_create_deal(
    chat_id: int,
    user_id: int | None = None,
    client_name: str | None = None,
) -> dict[str, Any]:
    with db() as conn:
        cur = conn.execute(
            """
            SELECT * FROM deals
            WHERE tg_chat_id = %s
              AND status NOT IN ('closed_won','closed_lost','cancelled')
            ORDER BY updated_at DESC LIMIT 1
            """,
            (chat_id,),
        )
        row = cur.fetchone()
        if row:
            return row
        cur = conn.execute(
            """
            INSERT INTO deals (tg_chat_id, tg_user_id, client_name, status, channel)
            VALUES (%s, %s, %s, 'intake', 'telegram') RETURNING *
            """,
            (chat_id, user_id, client_name),
        )
        return cur.fetchone()


def get_or_create_deal_by_phone(
    phone: str,
    client_name: str | None = None,
) -> dict[str, Any]:
    normalized = normalize_phone(phone)
    with db() as conn:
        cur = conn.execute(
            """
            SELECT * FROM deals
            WHERE channel = 'voice' AND client_phone = %s
              AND status NOT IN ('closed_won','closed_lost','cancelled')
            ORDER BY updated_at DESC LIMIT 1
            """,
            (normalized,),
        )
        row = cur.fetchone()
        if row:
            return row
        cur = conn.execute(
            """
            INSERT INTO deals (channel, client_phone, client_name, status)
            VALUES ('voice', %s, %s, 'intake') RETURNING *
            """,
            (normalized, client_name),
        )
        return cur.fetchone()


def get_deal(deal_id: str) -> dict[str, Any] | None:
    with db() as conn:
        return conn.execute("SELECT * FROM deals WHERE id = %s", (deal_id,)).fetchone()


def create_call_session(
    phone: str,
    deal_id: str | None = None,
    provider_call_id: str | None = None,
    direction: str = "inbound",
    metadata: dict | None = None,
) -> dict[str, Any]:
    normalized = normalize_phone(phone)
    with db() as conn:
        cur = conn.execute(
            """
            INSERT INTO call_sessions
              (deal_id, provider_call_id, phone, direction, status, metadata)
            VALUES (%s, %s, %s, %s, 'ringing', %s::jsonb) RETURNING *
            """,
            (deal_id, provider_call_id, normalized, direction, json.dumps(metadata or {})),
        )
        return cur.fetchone()


def update_call_session(session_id: str, **fields: Any) -> dict[str, Any]:
    json_keys = {"transcript", "metadata"}
    sets: list[str] = []
    vals: list[Any] = []
    for k, v in fields.items():
        if k in json_keys:
            sets.append(f"{k} = %s::jsonb")
            vals.append(json.dumps(v, default=str))
        else:
            sets.append(f"{k} = %s")
            vals.append(v)
    vals.append(session_id)
    with db() as conn:
        cur = conn.execute(
            f"UPDATE call_sessions SET {', '.join(sets)} WHERE id = %s RETURNING *",
            vals,
        )
        return cur.fetchone()


def get_call_session(session_id: str) -> dict[str, Any] | None:
    with db() as conn:
        return conn.execute(
            "SELECT * FROM call_sessions WHERE id = %s", (session_id,)
        ).fetchone()


def get_active_call_for_deal(deal_id: str) -> dict[str, Any] | None:
    with db() as conn:
        return conn.execute(
            """
            SELECT * FROM call_sessions
            WHERE deal_id = %s AND status IN ('ringing', 'active')
            ORDER BY started_at DESC LIMIT 1
            """,
            (deal_id,),
        ).fetchone()


def append_call_transcript(session_id: str, entry: dict[str, Any]) -> None:
    with db() as conn:
        conn.execute(
            """
            UPDATE call_sessions
            SET transcript = transcript || %s::jsonb
            WHERE id = %s
            """,
            (json.dumps([entry]), session_id),
        )


def update_deal(deal_id: str, **fields: Any) -> dict[str, Any]:
    json_keys = {
        "cargo",
        "route",
        "hs_codes",
        "cost_breakdown",
        "offer",
        "risks",
        "next_actions",
        "metadata",
    }
    sets: list[str] = []
    vals: list[Any] = []
    for k, v in fields.items():
        if k in json_keys:
            sets.append(f"{k} = %s::jsonb")
            vals.append(json.dumps(v, default=str))
        else:
            sets.append(f"{k} = %s")
            vals.append(v)
    sets.append("updated_at = NOW()")
    vals.append(deal_id)
    with db() as conn:
        cur = conn.execute(
            f"UPDATE deals SET {', '.join(sets)} WHERE id = %s RETURNING *",
            vals,
        )
        return cur.fetchone()


def add_message(
    deal_id: str,
    direction: str,
    sender: str,
    text: str,
    *,
    tg_chat_id: int | None = None,
    channel: str = "telegram",
    tg_message_id: int | None = None,
    call_session_id: str | None = None,
    raw: dict | None = None,
) -> None:
    with db() as conn:
        conn.execute(
            """
            INSERT INTO messages
              (deal_id, channel, tg_chat_id, tg_message_id, call_session_id,
               direction, sender, text, raw)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)
            """,
            (
                deal_id,
                channel,
                tg_chat_id,
                tg_message_id,
                call_session_id,
                direction,
                sender,
                text,
                json.dumps(raw or {}),
            ),
        )


def add_voice_message(
    deal_id: str,
    call_session_id: str,
    direction: str,
    sender: str,
    text: str,
    raw: dict | None = None,
) -> None:
    add_message(
        deal_id,
        direction,
        sender,
        text,
        channel="voice",
        call_session_id=call_session_id,
        raw=raw,
    )


def get_policy() -> dict[str, Any]:
    with db() as conn:
        rows = conn.execute("SELECT key, value FROM policy_config").fetchall()
    policy = {
        "target_margin_pct": settings.target_margin_pct,
        "floor_margin_pct": settings.floor_margin_pct,
        "max_discount_pct": settings.max_discount_pct,
        "escalate_amount_rub": settings.escalate_amount_rub,
        "learning_enabled": settings.learning_enabled,
        "canary_pct": settings.canary_pct,
    }
    for r in rows:
        val = r["value"]
        if isinstance(val, str):
            try:
                val = json.loads(val)
            except Exception:
                pass
        policy[r["key"]] = val
    return policy


def create_escalation(
    deal_id: str,
    reason: str,
    summary: str,
    numbers: dict | None = None,
    risks: list | None = None,
    recommendation: str | None = None,
    needed_decision: str | None = None,
) -> dict[str, Any]:
    with db() as conn:
        conn.execute(
            """
            UPDATE deals SET previous_status = status, status = 'awaiting_manager',
              escalate = TRUE, updated_at = NOW() WHERE id = %s
            """,
            (deal_id,),
        )
        cur = conn.execute(
            """
            INSERT INTO escalations
              (deal_id, reason, summary, numbers, risks, recommendation, needed_decision)
            VALUES (%s,%s,%s,%s::jsonb,%s::jsonb,%s,%s) RETURNING *
            """,
            (
                deal_id,
                reason,
                summary,
                json.dumps(numbers or {}),
                json.dumps(risks or []),
                recommendation,
                needed_decision,
            ),
        )
        return cur.fetchone()


def save_quote(deal_id: str, quote: dict[str, Any]) -> dict[str, Any]:
    with db() as conn:
        cur = conn.execute(
            """
            INSERT INTO quotes
              (deal_id, source, route_summary, price, currency, eta_days_min, eta_days_max,
               hidden_fees, reliability_score, valid_until, raw)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s,%s,%s::jsonb) RETURNING *
            """,
            (
                deal_id,
                quote.get("source", "mock"),
                quote.get("route_summary"),
                quote["price"],
                quote.get("currency", "RUB"),
                quote.get("eta_days_min"),
                quote.get("eta_days_max"),
                json.dumps(quote.get("hidden_fees", [])),
                quote.get("reliability_score"),
                quote.get("valid_until"),
                json.dumps(quote),
            ),
        )
        return cur.fetchone()


def save_cargo_estimate(deal_id: str, est: dict[str, Any]) -> dict[str, Any]:
    with db() as conn:
        cur = conn.execute(
            """
            INSERT INTO cargo_estimates
              (deal_id, length_cm, width_cm, height_cm, weight_kg, volumetric_weight_kg,
               chargeable_weight_kg, source, confidence, error_band_pct, calibration_applied, details)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s::jsonb) RETURNING *
            """,
            (
                deal_id,
                est.get("length_cm"),
                est.get("width_cm"),
                est.get("height_cm"),
                est.get("weight_kg"),
                est.get("volumetric_weight_kg"),
                est.get("chargeable_weight_kg"),
                est.get("source", "estimate"),
                est.get("confidence", 0.5),
                est.get("error_band_pct", 15),
                json.dumps(est.get("calibration_applied", {})),
                json.dumps(est.get("details", {})),
            ),
        )
        return cur.fetchone()


def save_contract(deal_id: str, data: dict[str, Any]) -> dict[str, Any]:
    with db() as conn:
        cur = conn.execute(
            """
            INSERT INTO contracts
              (deal_id, draft_md, client_summary, risk_matrix, legal_json, must_approve)
            VALUES (%s,%s,%s,%s::jsonb,%s::jsonb,%s) RETURNING *
            """,
            (
                deal_id,
                data.get("contract_draft_md", ""),
                data.get("client_risk_summary"),
                json.dumps(data.get("risk_matrix", [])),
                json.dumps(data),
                data.get("must_approve", True),
            ),
        )
        return cur.fetchone()


def log_learning(deal_id: str | None, event_type: str, payload: dict[str, Any]) -> None:
    with db() as conn:
        conn.execute(
            """
            INSERT INTO learning_events (deal_id, event_type, payload)
            VALUES (%s,%s,%s::jsonb)
            """,
            (deal_id, event_type, json.dumps(payload)),
        )


def idempotent_get(key: str) -> Any | None:
    with db() as conn:
        row = conn.execute(
            "SELECT result FROM idempotency_keys WHERE key = %s AND expires_at > NOW()",
            (key,),
        ).fetchone()
        return row["result"] if row else None


def idempotent_set(key: str, scope: str, result: Any, ttl_seconds: int = 3600) -> None:
    with db() as conn:
        conn.execute(
            """
            INSERT INTO idempotency_keys (key, scope, result, expires_at)
            VALUES (%s,%s,%s::jsonb, NOW() + (%s || ' seconds')::interval)
            ON CONFLICT (key) DO NOTHING
            """,
            (key, scope, json.dumps(result), str(ttl_seconds)),
        )


def list_approved_partner_emails(limit: int = 20) -> list[str]:
    with db() as conn:
        rows = conn.execute(
            """
            SELECT email FROM partner_contacts
            WHERE first_email_approved = TRUE OR verified = TRUE
            ORDER BY created_at DESC
            LIMIT %s
            """,
            (limit,),
        ).fetchall()
    return [str(r["email"]) for r in rows if r.get("email")]


def partner_email_for_code(code: str) -> str | None:
    with db() as conn:
        row = conn.execute(
            """
            SELECT pc.email
            FROM partner_contacts pc
            JOIN partners p ON p.id = pc.partner_id
            WHERE p.code = %s
              AND (pc.first_email_approved = TRUE OR pc.verified = TRUE)
            ORDER BY pc.created_at DESC
            LIMIT 1
            """,
            (code,),
        ).fetchone()
    return str(row["email"]) if row and row.get("email") else None


def create_calendar_event(
    deal_id: str | None,
    kind: str,
    title: str,
    due_at: str,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    with db() as conn:
        cur = conn.execute(
            """
            INSERT INTO calendar_events (deal_id, kind, title, due_at, metadata)
            VALUES (%s,%s,%s,%s,%s::jsonb)
            RETURNING *
            """,
            (deal_id, kind, title, due_at, json.dumps(metadata or {})),
        )
        row = cur.fetchone()
    try:
        from common.queues import enqueue_calendar_sync

        enqueue_calendar_sync()
    except Exception:
        pass
    return row


def lookup_hs_duty(hs_code: str | None) -> dict[str, Any] | None:
    if not hs_code:
        return None
    code = str(hs_code).strip()
    # normalize 8507.60 -> try exact then prefix
    variants = [code, code.replace(" ", "")]
    if len(code) >= 4:
        variants.append(code[:7] if "." in code else code[:4])
    with db() as conn:
        for v in variants:
            row = conn.execute(
                """
                SELECT * FROM hs_duty_rates
                WHERE hs_code = %s
                   OR hs_code LIKE %s
                ORDER BY length(hs_code) DESC
                LIMIT 1
                """,
                (v, f"{v}%"),
            ).fetchone()
            if row:
                return row
    return None


def upsert_embedding(
    deal_id: str,
    kind: str,
    content: str,
    embedding: list[float],
    metadata: dict[str, Any] | None = None,
) -> None:
    vec = "[" + ",".join(str(float(x)) for x in embedding) + "]"
    with db() as conn:
        conn.execute(
            """
            DELETE FROM embeddings WHERE deal_id = %s AND kind = %s
            """,
            (deal_id, kind),
        )
        conn.execute(
            """
            INSERT INTO embeddings (deal_id, kind, content, embedding, metadata)
            VALUES (%s,%s,%s,%s::vector,%s::jsonb)
            """,
            (deal_id, kind, content, vec, json.dumps(metadata or {})),
        )
