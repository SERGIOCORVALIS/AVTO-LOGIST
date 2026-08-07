"""OpenAI embeddings for deal RAG (pgvector)."""

from __future__ import annotations

import os
from typing import Any

import httpx

from common.db import db, upsert_embedding


def embed_text(text: str) -> list[float] | None:
    key = os.getenv("OPENAI_API_KEY") or ""
    if not key or not text.strip():
        return None
    model = os.getenv("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small")
    base = (os.getenv("OPENAI_BASE_URL") or "https://api.openai.com/v1").rstrip("/")
    try:
        r = httpx.post(
            f"{base}/embeddings",
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            json={"model": model, "input": text[:8000]},
            timeout=30.0,
        )
        r.raise_for_status()
        return list(r.json()["data"][0]["embedding"])
    except Exception:
        return None


def deal_to_embedding_text(deal: dict[str, Any]) -> str:
    cargo = deal.get("cargo") or {}
    route = deal.get("route") or {}
    return " | ".join(
        filter(
            None,
            [
                str(cargo.get("name") or ""),
                str(cargo.get("category") or ""),
                f"{route.get('origin_city') or ''} -> {route.get('destination_city') or ''}",
                f"amount={deal.get('amount_rub')}",
                f"margin={deal.get('margin_pct')}",
                f"status={deal.get('status')}",
            ],
        )
    )


def index_deal_embedding(deal_id: str, deal: dict[str, Any] | None = None) -> bool:
    if deal is None:
        with db() as conn:
            deal = conn.execute("SELECT * FROM deals WHERE id = %s", (deal_id,)).fetchone()
    if not deal:
        return False
    content = deal_to_embedding_text(deal)
    vec = embed_text(content)
    if not vec:
        return False
    upsert_embedding(
        deal_id,
        "deal_summary",
        content,
        vec,
        {"status": deal.get("status"), "amount_rub": deal.get("amount_rub")},
    )
    return True


def vector_similar_deals(query_text: str, limit: int = 5) -> list[dict[str, Any]] | None:
    vec = embed_text(query_text)
    if not vec:
        return None
    vec_lit = "[" + ",".join(str(float(x)) for x in vec) + "]"
    try:
        with db() as conn:
            rows = conn.execute(
                """
                SELECT d.id, d.cargo, d.route, d.margin_pct, d.amount_rub, d.status,
                       (e.embedding <=> %s::vector) AS distance
                FROM embeddings e
                JOIN deals d ON d.id = e.deal_id
                WHERE e.kind = 'deal_summary'
                  AND d.status IN ('closed_won','closed_lost')
                ORDER BY e.embedding <=> %s::vector
                LIMIT %s
                """,
                (vec_lit, vec_lit, limit),
            ).fetchall()
        return rows
    except Exception:
        return None
