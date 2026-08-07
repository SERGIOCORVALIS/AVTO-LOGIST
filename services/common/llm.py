from __future__ import annotations

import os
import time
from typing import Any

from openai import OpenAI

from common import settings


def gpt_client() -> OpenAI:
    return OpenAI(
        api_key=settings.openai_api_key or "sk-missing",
        base_url=settings.openai_base_url,
    )


def deepseek_client() -> OpenAI:
    return OpenAI(
        api_key=settings.deepseek_api_key or "sk-missing",
        base_url=settings.deepseek_base_url,
    )


def _langfuse_enabled() -> bool:
    return bool(os.getenv("LANGFUSE_PUBLIC_KEY") and os.getenv("LANGFUSE_SECRET_KEY"))


def _langfuse_log(
    *,
    name: str,
    model: str,
    system: str,
    user: str,
    output: str,
    latency_ms: float,
    metadata: dict[str, Any] | None = None,
) -> None:
    if not _langfuse_enabled():
        return
    try:
        from langfuse import Langfuse

        lf = Langfuse(
            public_key=os.getenv("LANGFUSE_PUBLIC_KEY"),
            secret_key=os.getenv("LANGFUSE_SECRET_KEY"),
            host=os.getenv("LANGFUSE_HOST") or "http://localhost:3001",
        )
        trace = lf.trace(name=name, metadata=metadata or {})
        trace.generation(
            name=name,
            model=model,
            input=[{"role": "system", "content": system}, {"role": "user", "content": user}],
            output=output,
            metadata={"latency_ms": latency_ms, **(metadata or {})},
        )
        lf.flush()
    except Exception:
        pass


def chat_json(
    client: OpenAI,
    model: str,
    system: str,
    user: str,
    temperature: float = 0.3,
    *,
    trace_name: str = "chat_json",
    metadata: dict[str, Any] | None = None,
) -> str:
    t0 = time.time()
    resp = client.chat.completions.create(
        model=model,
        temperature=temperature,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        response_format={"type": "json_object"},
    )
    content = resp.choices[0].message.content or "{}"
    _langfuse_log(
        name=trace_name,
        model=model,
        system=system[:2000],
        user=user[:4000],
        output=content[:4000],
        latency_ms=(time.time() - t0) * 1000,
        metadata=metadata,
    )
    return content
