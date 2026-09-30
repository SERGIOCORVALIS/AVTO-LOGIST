from __future__ import annotations

import json
import re
from contextlib import contextmanager
from typing import Any, Iterator

import psycopg  
from psycopg.rows import dict_row

from common import prefer_ipv4_loopback, settings


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
    # Fail fast when Postgres is down (default TCP hang can stall agents/tests for minutes).
    conn = psycopg.connect(
        prefer_ipv4_loopback(settings.database_url),
        row_factory=dict_row,
        connect_timeout=5,
    )
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def telegram_message_exists(chat_id: int, tg_message_id: int) -> bool:
    with db() as conn:
        cur = conn.execute(
            """
            SELECT 1
            FROM messages m
            JOIN deals d ON d.id = m.deal_id
            WHERE d.tg_chat_id = %s
              AND m.tg_message_id = %s
              AND m.direction = 'inbound'
            LIMIT 1
            """,
            (chat_id, tg_message_id),
        )
        return cur.fetchone() is not None


def get_or_create_deal(
    chat_id: int,
    user_id: int | None = None,
    client_name: str | None = None,
) -> dict[str, Any]:
    client = resolve_client(tg_chat_id=chat_id)
    client_id = str(client["id"]) if client else None
    with db() as conn:
        # 1) Explicit active deal for this chat (multi-deal safety).
        active = _lookup_active_deal(conn, chat_id=chat_id, client=client)
        if active:
            if client_id and not active.get("client_id"):
                linked = link_deal_client(str(active["id"]), client_id)
                return linked or active
            return active

        # 2) Prefer live (non-paused) open deals, then any open by recent activity.
        cur = conn.execute(
            """
            SELECT d.*
            FROM deals d
            WHERE d.tg_chat_id = %s
              AND d.status NOT IN ('closed_won','closed_lost','cancelled')
            ORDER BY
              CASE WHEN COALESCE(d.paused, FALSE) OR COALESCE(d.takeover, FALSE) THEN 1 ELSE 0 END,
              CASE WHEN COALESCE(d.metadata->>'active_for_chat','') IN ('1','true','yes') THEN 0 ELSE 1 END,
              (
                SELECT MAX(m.created_at) FROM messages m WHERE m.deal_id = d.id
              ) DESC NULLS LAST,
              d.updated_at DESC
            LIMIT 1
            """,
            (chat_id,),
        )
        row = cur.fetchone()
        if row:
            if client_id and not row.get("client_id"):
                linked = link_deal_client(str(row["id"]), client_id)
                deal = linked or row
            else:
                deal = row
            # Soft-bind as active so next messages stick to the same card.
            try:
                set_active_deal(str(deal["id"]), chat_id=chat_id, client_id=client_id)
            except Exception:
                pass
            return deal
        cur = conn.execute(
            """
            INSERT INTO deals (tg_chat_id, tg_user_id, client_name, client_id, status, channel)
            VALUES (%s, %s, %s, %s, 'intake', 'telegram') RETURNING *
            """,
            (chat_id, user_id, client_name or (client or {}).get("name"), client_id),
        )
        deal = cur.fetchone()
    if client_id:
        ensure_client_identity(
            client_id, "tg_chat_id", str(chat_id), source="telegram"
        )
    try:
        set_active_deal(str(deal["id"]), chat_id=chat_id, client_id=client_id)
    except Exception:
        pass
    return deal


def _lookup_active_deal(
    conn: Any,
    *,
    chat_id: int,
    client: dict[str, Any] | None,
) -> dict[str, Any] | None:
    """Resolve pinned active_deal_id for a TG chat / client."""
    candidates: list[str] = []
    if client:
        meta = client.get("metadata") if isinstance(client.get("metadata"), dict) else {}
        aid = meta.get("active_deal_id") if meta else None
        if aid:
            candidates.append(str(aid))
    # Deal flagged active_for_chat
    flagged = conn.execute(
        """
        SELECT id FROM deals
        WHERE tg_chat_id = %s
          AND status NOT IN ('closed_won','closed_lost','cancelled')
          AND COALESCE(metadata->>'active_for_chat','') IN ('1','true','yes')
        ORDER BY updated_at DESC
        LIMIT 1
        """,
        (chat_id,),
    ).fetchone()
    if flagged and flagged.get("id"):
        candidates.insert(0, str(flagged["id"]))

    for deal_id in candidates:
        row = conn.execute(
            """
            SELECT * FROM deals
            WHERE id = %s::uuid
              AND tg_chat_id = %s
              AND status NOT IN ('closed_won','closed_lost','cancelled')
            LIMIT 1
            """,
            (deal_id, chat_id),
        ).fetchone()
        if row:
            # Skip paused/takeover pins — prefer a live card for inbound routing.
            if row.get("paused") or row.get("takeover"):
                continue
            return dict(row) if not isinstance(row, dict) else row
    return None


def set_active_deal(
    deal_id: str,
    *,
    chat_id: int | None = None,
    client_id: str | None = None,
) -> dict[str, Any] | None:
    """Pin which open deal receives inbound messages for a TG chat / client."""
    deal = get_deal(deal_id)
    if not deal:
        return None
    tg = chat_id if chat_id is not None else deal.get("tg_chat_id")
    cid = client_id or deal.get("client_id")
    with db() as conn:
        if tg is not None:
            # Clear flag on sibling open deals in the same chat.
            conn.execute(
                """
                UPDATE deals
                SET metadata = COALESCE(metadata, '{}'::jsonb) - 'active_for_chat',
                    updated_at = NOW()
                WHERE tg_chat_id = %s
                  AND id <> %s::uuid
                  AND status NOT IN ('closed_won','closed_lost','cancelled')
                  AND COALESCE(metadata->>'active_for_chat','') IN ('1','true','yes')
                """,
                (int(tg), deal_id),
            )
        meta = dict(deal.get("metadata") or {})
        meta["active_for_chat"] = True
        from datetime import datetime, timezone

        meta["active_for_chat_at"] = datetime.now(timezone.utc).isoformat()
        cur = conn.execute(
            """
            UPDATE deals
            SET metadata = %s::jsonb, updated_at = NOW()
            WHERE id = %s::uuid
            RETURNING *
            """,
            (json.dumps(meta, default=str), deal_id),
        )
        updated = cur.fetchone()
        if cid:
            conn.execute(
                """
                UPDATE clients
                SET metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_build_object('active_deal_id', %s::text),
                    updated_at = NOW()
                WHERE id = %s::uuid
                """,
                (deal_id, str(cid)),
            )
    return dict(updated) if updated and not isinstance(updated, dict) else updated


def get_or_create_deal_by_phone(
    phone: str,
    client_name: str | None = None,
) -> dict[str, Any]:
    normalized = normalize_phone(phone)
    client = resolve_client(phone=normalized)
    client_id = str(client["id"]) if client else None
    with db() as conn:
        # Prefer open deal already linked to this client (any channel)
        if client_id:
            cur = conn.execute(
                """
                SELECT * FROM deals
                WHERE client_id = %s
                  AND status NOT IN ('closed_won','closed_lost','cancelled')
                ORDER BY updated_at DESC LIMIT 1
                """,
                (client_id,),
            )
            row = cur.fetchone()
            if row:
                return row
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
            if client_id and not row.get("client_id"):
                linked = link_deal_client(str(row["id"]), client_id)
                return linked or row
            return row
        cur = conn.execute(
            """
            INSERT INTO deals (channel, client_phone, client_name, client_id, status)
            VALUES ('voice', %s, %s, %s, 'intake') RETURNING *
            """,
            (normalized, client_name or (client or {}).get("name"), client_id),
        )
        deal = cur.fetchone()
    if client_id:
        ensure_client_identity(client_id, "phone", normalized, source="voice")
    return deal


def create_fresh_deal(
    *,
    channel: str,
    chat_id: int | None = None,
    user_id: int | None = None,
    phone: str | None = None,
    client_name: str | None = None,
    client_id: str | None = None,
    client_email: str | None = None,
) -> dict[str, Any]:
    """Always insert a new deal (second order of the same client)."""
    resolved_id = client_id
    if not resolved_id:
        if channel == "voice" and phone:
            c = resolve_client(phone=phone)
            resolved_id = str(c["id"]) if c else None
        elif channel == "email" and client_email:
            c = resolve_client(email=client_email)
            resolved_id = str(c["id"]) if c else None
        elif chat_id is not None:
            c = resolve_client(tg_chat_id=chat_id)
            resolved_id = str(c["id"]) if c else None
    with db() as conn:
        if channel == "voice":
            normalized = normalize_phone(phone or "")
            cur = conn.execute(
                """
                INSERT INTO deals (channel, client_phone, client_name, client_id, status)
                VALUES ('voice', %s, %s, %s, 'intake') RETURNING *
                """,
                (normalized, client_name, resolved_id),
            )
            return cur.fetchone()
        if channel == "email":
            cur = conn.execute(
                """
                INSERT INTO deals (channel, client_name, client_id, status, metadata)
                VALUES ('email', %s, %s, 'intake', %s::jsonb) RETURNING *
                """,
                (
                    client_name,
                    resolved_id,
                    json.dumps({"client_email": client_email} if client_email else {}),
                ),
            )
            return cur.fetchone()
        cur = conn.execute(
            """
            INSERT INTO deals (tg_chat_id, tg_user_id, client_name, client_id, status, channel)
            VALUES (%s, %s, %s, %s, 'intake', 'telegram') RETURNING *
            """,
            (chat_id, user_id, client_name, resolved_id),
        )
        return cur.fetchone()


def get_deal(deal_id: str) -> dict[str, Any] | None:
    with db() as conn:
        return conn.execute(
            "SELECT * FROM deals WHERE id = %s", (deal_id,)
        ).fetchone()


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
            (deal_id, provider_call_id, normalized, direction, json.dumps(metadata if metadata else {}), ) if metadata else (deal_id, provider_call_id, normalized, direction, '{}',), 
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
        "calculation_assumptions",
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


def list_recent_messages(deal_id: str, limit: int = 16) -> list[dict[str, Any]]:
    with db() as conn:
        rows = conn.execute(
            """
            SELECT direction, sender, text, created_at
            FROM messages
            WHERE deal_id = %s
            ORDER BY created_at DESC
            LIMIT %s
            """,
            (deal_id, limit),
        ).fetchall()
    out = list(reversed(rows or []))
    return [dict(r) if not isinstance(r, dict) else r for r in out]


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
        "require_human_kp_approve": settings.require_human_kp_approve,
        "learning_enabled": settings.learning_enabled,
        "canary_pct": settings.canary_pct,
    }
    try:
        from agents.tz_policy import DEFAULT_TZ_POLICY, policy_from_env

        policy = {**DEFAULT_TZ_POLICY, **policy_from_env(), **policy}
    except Exception:
        pass
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
        existing = conn.execute(
            """
            SELECT * FROM escalations
            WHERE deal_id = %s AND reason = %s
              AND COALESCE(status, 'pending') = 'pending'
            ORDER BY created_at DESC
            LIMIT 1
            """,
            (deal_id, reason),
        ).fetchone()
        if existing:
            return {**existing, "duplicate": True}
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
        row = cur.fetchone()
        return {**row, "duplicate": False}


def escalation_notify_payload(esc: dict[str, Any]) -> dict[str, Any]:
    return {
        "reason": esc.get("reason"),
        "summary": esc.get("summary"),
        "needed_decision": esc.get("needed_decision"),
        "id": str(esc["id"]),
        "duplicate": bool(esc.get("duplicate")),
    }


def list_deal_quotes(deal_id: str, *, limit: int = 12) -> list[dict[str, Any]]:
    """Inbound/saved supplier quotes for a deal (IMAP + HTTP)."""
    with db() as conn:
        rows = conn.execute(
            """
            SELECT source, route_summary, price, currency, eta_days_min, eta_days_max, 
                   hidden_fees, reliability_score, valid_until, raw
            FROM quotes
            WHERE deal_id = %s
            ORDER BY created_at DESC
            LIMIT %s
            """,
            (deal_id, limit),
        ).fetchall()
    out: list[dict[str, Any]] = []
    for row in rows:
        raw = row.get("raw") if isinstance(row.get("raw"), dict) else {}
        q = dict(raw) if raw else {}
        q.setdefault("source", row.get("source"))
        q.setdefault("partner", raw.get("partner") or raw.get("from") or row.get("source"))
        q.setdefault("route_summary", row.get("route_summary"))
        q["price"] = row.get("price") if row.get("price") is not None else q.get("price")
        q.setdefault("currency", row.get("currency") or "RUB")
        q.setdefault("eta_days_min", row.get("eta_days_min"))
        q.setdefault("eta_days_max", row.get("eta_days_max"))
        q.setdefault("hidden_fees", row.get("hidden_fees") or [])
        q.setdefault("reliability_score", row.get("reliability_score"))
        q.setdefault("valid_until", row.get("valid_until"))
        out.append(q)
    return out


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


def get_latest_contract(deal_id: str) -> dict[str, Any] | None:
    with db() as conn:
        return conn.execute(
            """
            SELECT * FROM contracts
            WHERE deal_id = %s
            ORDER BY created_at DESC
            LIMIT 1
            """,
            (deal_id,),
        ).fetchone()


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


def list_supplier_rfq_emails(
    *,
    transport_mode: str | None = None,
    corridor: str | None = None,
    limit: int = 20,
    preferred_codes: list[str] | None = None,
    origin_city: str | None = None,
    destination_city: str | None = None,
    require_mode: bool = False,
) -> list[str]:
    """Emails of active suppliers, optionally filtered by mode/corridor/lane (TZ RFQ).

    preferred_codes: ask these operators first (e.g. FESCO/TrCont for PSZhVS).
    require_mode: if True, suppliers with empty modes are excluded (no accidental
    truckers/SPB generalists on specialized rail+sea lanes).
    """
    from agents.procurement import MODE_FAMILIES, mode_family

    family = mode_family(transport_mode)
    mode_keys: list[str] = []
    if transport_mode:
        mode_keys.append(str(transport_mode).strip())
    if family:
        mode_keys.append(family)
        for mode, fam in MODE_FAMILIES.items():
            if fam == family and mode not in mode_keys:
                mode_keys.append(mode)
    # For container domestic Far-East often need rail+sea together.
    if transport_mode in ("container", "rail", "sea") or family in (
        "container",
        "rail",
        "sea",
    ):
        for extra in ("container", "rail", "sea"):
            if extra not in mode_keys:
                mode_keys.append(extra)

    preferred = [str(c).strip().lower() for c in (preferred_codes or []) if c]
    origin = (origin_city or "").strip().lower()
    dest = (destination_city or "").strip().lower()
    # Specialized domestic container/rail/sea: never treat empty modes/corridors as "match all".
    specialized = require_mode or (
        str(corridor or "") == "ru_domestic"
        and (
            family in ("container", "rail", "sea")
            or str(transport_mode or "") in ("container", "rail", "sea")
        )
    )

    with db() as conn:
        if preferred:
            pref_rows = conn.execute(
                """
                SELECT pc.email, MAX(s.code) AS code
                FROM partner_contacts pc
                JOIN partners p ON p.id = pc.partner_id
                LEFT JOIN suppliers s ON s.partner_id = p.id
                WHERE p.active = TRUE
                  AND COALESCE(s.active, TRUE) = TRUE
                  AND COALESCE(s.left_market, FALSE) = FALSE
                  AND COALESCE(s.silent, FALSE) = FALSE
                  AND (pc.first_email_approved = TRUE OR pc.verified = TRUE)
                  AND (
                    LOWER(COALESCE(s.code, p.code, '')) = ANY(%s::text[])
                    OR LOWER(COALESCE(s.name, p.name, '')) = ANY(%s::text[])
                  )
                GROUP BY pc.email
                ORDER BY pc.email
                """,
                (preferred, preferred),
            ).fetchall()
            pref_emails = [str(r["email"]) for r in pref_rows if r.get("email")]
            # Specialized (PSZhVS etc.): stay on preferred only — no generalist pad.
            # Mixed lanes: fall through and append lane-matched after preferred.
            if pref_emails and specialized:
                return pref_emails[:limit]
        else:
            pref_emails = []

        mode_clause = ""
        params: list[Any] = []
        if mode_keys:
            if specialized:
                mode_clause = "AND (s.modes && %s::text[] OR p.modes && %s::text[])"
                params.extend([mode_keys, mode_keys])
            else:
                mode_clause = """
                  AND (
                    COALESCE(cardinality(s.modes), 0) = 0
                    OR s.modes && %s::text[]
                    OR p.modes && %s::text[]
                  )
                """
                params.extend([mode_keys, mode_keys])
        corridor_clause = ""
        if corridor:
            if specialized:
                # Empty corridors are not a wildcard on PSZhVS / container domestic.
                corridor_clause = """
                  AND %s::text = ANY(COALESCE(s.corridors, ARRAY[]::text[]))
                """
                params.append(corridor)
            else:
                corridor_clause = """
                  AND (
                    COALESCE(cardinality(s.corridors), 0) = 0
                    OR %s::text = ANY(s.corridors)
                  )
                """
                params.append(corridor)

        lane_order = "MAX(s.last_reply_at) DESC NULLS LAST, pc.email"
        if origin or dest:
            # Prefer suppliers whose strong_lanes mention origin/destination.
            lane_order = """
              CASE
                WHEN %s::text <> '' AND LOWER(COALESCE(s.strong_lanes::text,'')) LIKE '%%' || %s::text || '%%' THEN 0
                WHEN %s::text <> '' AND LOWER(COALESCE(s.strong_lanes::text,'')) LIKE '%%' || %s::text || '%%' THEN 1
                WHEN %s::text <> '' AND (
                  LOWER(COALESCE(s.contacts::text,'')) LIKE '%%' || %s::text || '%%'
                  OR LOWER(COALESCE(s.metadata::text,'')) LIKE '%%' || %s::text || '%%'
                ) THEN 2
                ELSE 3
              END,
              MAX(s.last_reply_at) DESC NULLS LAST,
              pc.email
            """
            # placeholders for CASE: dest, dest, origin, origin, dest, dest, dest
            params_lane = [
                dest,
                dest,
                origin,
                origin,
                dest,
                dest,
                dest,
            ]
        else:
            params_lane = []

        sql = f"""
                SELECT pc.email
                FROM partner_contacts pc
                JOIN partners p ON p.id = pc.partner_id
                LEFT JOIN suppliers s ON s.partner_id = p.id
                WHERE p.active = TRUE
                  AND COALESCE(s.active, TRUE) = TRUE
                  AND COALESCE(s.left_market, FALSE) = FALSE
                  AND COALESCE(s.silent, FALSE) = FALSE
                  AND (pc.first_email_approved = TRUE OR pc.verified = TRUE)
                  {mode_clause}
                  {corridor_clause}
                GROUP BY pc.email, s.strong_lanes, s.contacts, s.metadata
                ORDER BY {lane_order}
                LIMIT %s
        """
        rows = conn.execute(sql, (*params, *params_lane, limit)).fetchall()
    emails = [str(r["email"]) for r in rows if r.get("email")]
    # Preferred first, then only lane-matched fill up to limit (item 8).
    out: list[str] = []
    seen: set[str] = set()
    for e in pref_emails + emails:
        el = e.lower()
        if el in seen:
            continue
        seen.add(el)
        out.append(e)
        if len(out) >= limit:
            break
    return out


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


def _identity_norm(kind: str, value: str) -> str:
    v = (value or "").strip()
    if kind == "email":
        return v.lower()
    if kind == "phone":
        return normalize_phone(v)
    if kind == "tg_chat_id":
        return str(int(v))
    if kind == "inn":
        return re.sub(r"\D", "", v)
    return v.lower()


def resolve_client(
    *,
    email: str | None = None,
    phone: str | None = None,
    tg_chat_id: int | None = None,
    inn: str | None = None,
) -> dict[str, Any] | None:
    """Find client by any known identity (email / phone / tg / inn)."""
    keys: list[tuple[str, str]] = []
    if email:
        keys.append(("email", _identity_norm("email", email)))
    if phone:
        try:
            keys.append(("phone", _identity_norm("phone", phone)))
        except ValueError:
            pass
    if tg_chat_id is not None:
        keys.append(("tg_chat_id", str(int(tg_chat_id))))
    if inn:
        keys.append(("inn", _identity_norm("inn", inn)))
    if not keys:
        return None

    with db() as conn:
        for kind, value_norm in keys:
            row = conn.execute(
                """
                SELECT c.*
                FROM client_identities i
                JOIN clients c ON c.id = i.client_id
                WHERE i.kind = %s AND i.value_norm = %s
                LIMIT 1
                """,
                (kind, value_norm),
            ).fetchone()
            if row:
                return dict(row) if not isinstance(row, dict) else row
            if kind == "email":
                row = conn.execute(
                    """
                    SELECT * FROM clients
                    WHERE lower(primary_email) = lower(%s)
                    LIMIT 1
                    """,
                    (value_norm,),
                ).fetchone()
                if row:
                    return dict(row) if not isinstance(row, dict) else row
            if kind == "phone":
                row = conn.execute(
                    """
                    SELECT * FROM clients WHERE phone = %s LIMIT 1
                    """,
                    (value_norm,),
                ).fetchone()
                if row:
                    return dict(row) if not isinstance(row, dict) else row
            if kind == "tg_chat_id":
                row = conn.execute(
                    """
                    SELECT * FROM clients WHERE tg_chat_id = %s LIMIT 1
                    """,
                    (int(value_norm),),
                ).fetchone()
                if row:
                    return dict(row) if not isinstance(row, dict) else row
    return None


def ensure_client_identity(
    client_id: str,
    kind: str,
    value: str,
    *,
    source: str = "runtime",
) -> None:
    value_norm = _identity_norm(kind, value)
    with db() as conn:
        conn.execute(
            """
            INSERT INTO client_identities (client_id, kind, value, value_norm, source)
            VALUES (%s, %s, %s, %s, %s)
            ON CONFLICT (kind, value_norm) DO NOTHING
            """,
            (client_id, kind, value.strip(), value_norm, source),
        )


def link_deal_client(deal_id: str, client_id: str | None) -> dict[str, Any] | None:
    if not client_id:
        return None
    with db() as conn:
        row = conn.execute(
            """
            UPDATE deals SET client_id = %s, updated_at = NOW()
            WHERE id = %s AND (client_id IS NULL OR client_id <> %s)
            RETURNING *
            """,
            (client_id, deal_id, client_id),
        ).fetchone()
        if row:
            return dict(row) if not isinstance(row, dict) else row
        return get_deal(deal_id)


def get_or_create_deal_by_email(
    email: str,
    client_name: str | None = None,
) -> dict[str, Any]:
    email_norm = _identity_norm("email", email)
    client = resolve_client(email=email_norm)
    client_id = str(client["id"]) if client else None
    with db() as conn:
        if client_id:
            cur = conn.execute(
                """
                SELECT * FROM deals
                WHERE client_id = %s
                  AND status NOT IN ('closed_won','closed_lost','cancelled')
                ORDER BY updated_at DESC LIMIT 1
                """,
                (client_id,),
            )
            row = cur.fetchone()
            if row:
                return row
        cur = conn.execute(
            """
            INSERT INTO deals (channel, client_name, client_id, status, metadata)
            VALUES ('email', %s, %s, 'intake', %s::jsonb) RETURNING *
            """,
            (
                client_name or (client or {}).get("name"),
                client_id,
                json.dumps({"client_email": email_norm}),
            ),
        )
        deal = cur.fetchone()
    if client_id:
        ensure_client_identity(client_id, "email", email_norm, source="email_channel")
    return deal


def client_memory_for_prompt(client_id: str | None, *, limit: int = 5) -> dict[str, Any] | None:
    """Compact returning-client context for Concierge."""
    if not client_id:
        return None
    with db() as conn:
        client = conn.execute(
            "SELECT * FROM clients WHERE id = %s", (client_id,)
        ).fetchone()
        if not client:
            return None
        calcs = conn.execute(
            """
            SELECT origin, destination, mode, cargo_desc, requested_at, amount, currency
            FROM client_calc_requests
            WHERE client_id = %s
            ORDER BY requested_at DESC NULLS LAST
            LIMIT %s
            """,
            (client_id, limit),
        ).fetchall()
        facts = conn.execute(
            """
            SELECT fact_type, value
            FROM client_facts
            WHERE client_id = %s
            ORDER BY created_at DESC
            LIMIT %s
            """,
            (client_id, limit),
        ).fetchall()
        identities = conn.execute(
            """
            SELECT kind, value FROM client_identities
            WHERE client_id = %s
            ORDER BY kind
            """,
            (client_id,),
        ).fetchall()
    c = dict(client) if not isinstance(client, dict) else client
    return {
        "id": str(c.get("id")),
        "name": c.get("name") or c.get("legal_name"),
        "legal_name": c.get("legal_name"),
        "vip": bool(c.get("vip")),
        "primary_email": c.get("primary_email"),
        "phone": c.get("phone"),
        "inn": c.get("inn"),
        "abc": c.get("abc") or {},
        "personal_context": c.get("personal_context") or {},
        "identities": [dict(r) if not isinstance(r, dict) else r for r in (identities or [])],
        "recent_calcs": [dict(r) if not isinstance(r, dict) else r for r in (calcs or [])],
        "facts": [dict(r) if not isinstance(r, dict) else r for r in (facts or [])],
    }
