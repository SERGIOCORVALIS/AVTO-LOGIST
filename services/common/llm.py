from __future__ import annotations

import os
import time
from typing import Any

from openai import OpenAI

from common import settings
from common.gpt_budget import assert_within_budget, record_usage
from common.proxy import http_proxy_url, openai_http_client

_client: OpenAI | None = None
_client_fingerprint: tuple[str, str, str, float] | None = None

ModelKind = str  # main | fast | coding | document


def _env(name: str, fallback: str = "") -> str:
    """Live os.environ first so tests/monkeypatch and .env both win over Settings defaults."""
    raw = os.getenv(name)
    if raw is not None and str(raw).strip() != "":
        return str(raw).strip()
    return (fallback or "").strip()


def openai_timeout_sec() -> float:
    raw = _env("OPENAI_TIMEOUT_SEC", str(settings.openai_timeout_sec or 120))
    try:
        n = float(raw)
    except ValueError:
        return 120.0
    return n if n > 0 else 120.0


def openai_reasoning_effort() -> str:
    return _env("OPENAI_REASONING_EFFORT", settings.openai_reasoning_effort or "high")


def gpt_client() -> OpenAI:
    global _client, _client_fingerprint
    key = _env("OPENAI_API_KEY", settings.openai_api_key)
    if not key:
        raise RuntimeError("OPENAI_API_KEY is missing")
    base = _env("OPENAI_BASE_URL", settings.openai_base_url) or "https://api.openai.com/v1"
    proxy = http_proxy_url() or ""
    timeout = openai_timeout_sec()
    fingerprint = (key, base, proxy, timeout)
    if _client is not None and _client_fingerprint == fingerprint:
        return _client
    kwargs: dict[str, Any] = {
        "api_key": key,
        "base_url": base,
        "timeout": timeout,
    }
    http_client = openai_http_client()
    if http_client is not None:
        kwargs["http_client"] = http_client
    _client = OpenAI(**kwargs)
    _client_fingerprint = fingerprint
    return _client


def model_candidates(explicit: str | None = None) -> list[str]:
    raw = explicit or _env("OPENAI_MODEL", settings.openai_model) or "gpt-5.6-sol"
    parts = [p.strip() for p in str(raw).replace(";", ",").split(",") if p.strip()]
    seen: set[str] = set()
    out: list[str] = []
    for p in parts:
        if p not in seen:
            seen.add(p)
            out.append(p)
    return out or ["gpt-5.6-sol"]


def model_for(kind: ModelKind = "main") -> str:
    """Pick the env model for a task class. Falls back to OPENAI_MODEL."""
    mapping = {
        "main": ("OPENAI_MODEL", settings.openai_model, "gpt-5.6-sol"),
        "fast": ("OPENAI_FAST_MODEL", settings.openai_fast_model, "gpt-5.6-luna"),
        "coding": ("OPENAI_CODING_MODEL", settings.openai_coding_model, "gpt-5.6-sol"),
        "document": ("OPENAI_DOCUMENT_MODEL", settings.openai_document_model, "gpt-5.6-sol"),
    }
    env_name, settings_val, default = mapping.get(kind, mapping["main"])
    raw = _env(env_name, settings_val) or _env("OPENAI_MODEL", settings.openai_model) or default
    return model_candidates(raw)[0]


def transcribe_model() -> str:
    return _env("OPENAI_TRANSCRIBE_MODEL", settings.openai_transcribe_model) or "gpt-transcribe"


def realtime_model() -> str:
    return _env("OPENAI_REALTIME_MODEL", settings.openai_realtime_model) or "gpt-realtime-2.1"


def embedding_model() -> str:
    return _env("OPENAI_EMBEDDING_MODEL", settings.openai_embedding_model) or "text-embedding-3-large"


def is_reasoning_model(model: str) -> bool:
    m = (model or "").lower()
    return m.startswith(("gpt-5", "o1", "o3", "o4"))


def _max_completion_tokens() -> int | None:
    raw = _env(
        "OPENAI_MAX_COMPLETION_TOKENS",
        str(settings.openai_max_completion_tokens or 32768),
    )
    if raw.lower() in ("", "0", "none", "off"):
        return None
    try:
        n = int(raw)
    except ValueError:
        return 32768
    return n if n > 0 else None


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
            input=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            output=output,
            metadata={"latency_ms": latency_ms, **(metadata or {})},
        )
        lf.flush()
    except Exception:
        pass


def _completion_text(resp: Any) -> str:
    """Return assistant text, or raise so the caller can fall back to the next model.

    Reasoning models often yield content=None / '' (length, refusal). Treating that
    as '{}' used to look like a successful empty JSON object and skipped fallbacks.
    """
    choices = getattr(resp, "choices", None) or []
    if not choices:
        raise RuntimeError("empty LLM response (no choices)")
    choice = choices[0]
    msg = getattr(choice, "message", None)
    if msg is None:
        raise RuntimeError("empty LLM response (no message)")
    refusal = getattr(msg, "refusal", None)
    if refusal:
        raise RuntimeError(f"LLM refusal: {refusal}")
    content = getattr(msg, "content", None)
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if isinstance(part, str):
                parts.append(part)
            elif isinstance(part, dict) and part.get("text"):
                parts.append(str(part["text"]))
            else:
                text = getattr(part, "text", None)
                if text:
                    parts.append(str(text))
        content = "".join(parts)
    text = (content or "").strip()
    if not text:
        reason = getattr(choice, "finish_reason", None)
        raise RuntimeError(f"empty LLM content (finish_reason={reason})")
    return text


def _create_completion(
    client: OpenAI,
    model: str,
    messages: list[dict[str, str]],
    *,
    temperature: float,
    response_format: dict[str, Any] | None = None,
) -> Any:
    kwargs: dict[str, Any] = {
        "model": model,
        "messages": messages,
    }
    if response_format:
        kwargs["response_format"] = response_format
    if is_reasoning_model(model):
        effort = openai_reasoning_effort()
        if effort:
            kwargs["reasoning_effort"] = effort
        max_out = _max_completion_tokens()
        if max_out:
            kwargs["max_completion_tokens"] = max_out
    else:
        kwargs["temperature"] = temperature

    attempts = [dict(kwargs)]
    stripped = dict(kwargs)
    stripped.pop("reasoning_effort", None)
    stripped.pop("max_completion_tokens", None)
    stripped.pop("temperature", None)
    if stripped != kwargs:
        attempts.append(stripped)

    last_err: Exception | None = None
    for kw in attempts:
        try:
            return client.chat.completions.create(**kw)
        except TypeError as exc:
            last_err = exc
            continue
        except Exception as exc:
            msg = str(exc).lower()
            if (
                "temperature" in msg
                or "reasoning_effort" in msg
                or "unknown parameter" in msg
                or "max_completion" in msg
            ):
                last_err = exc
                continue
            raise
    assert last_err is not None
    raise last_err


def chat_json(
    client: OpenAI,
    model: str,
    system: str,
    user: str,
    temperature: float = 0.7,
    *,
    trace_name: str = "chat_json",
    metadata: dict[str, Any] | None = None,
) -> str:
    t0 = time.time()
    assert_within_budget()
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]
    last_err: Exception | None = None
    used = model
    content = ""
    resp: Any = None
    for cand in model_candidates(model):
        used = cand
        try:
            resp = _create_completion(
                client,
                cand,
                messages,
                temperature=temperature,
                response_format={"type": "json_object"},
            )
            content = _completion_text(resp)
            last_err = None
            break
        except Exception as e:
            last_err = e
            continue
    if last_err is not None:
        raise last_err
    if resp is not None:
        record_usage(
            resp,
            prompt_chars=len(system) + len(user),
            completion_chars=len(content),
        )
    _langfuse_log(
        name=trace_name,
        model=used,
        system=system[:2000],
        user=user[:4000],
        output=content[:4000],
        latency_ms=(time.time() - t0) * 1000,
        metadata={**(metadata or {}), "model_used": used},
    )
    return content


def chat_parsed(
    client: OpenAI,
    model: str,
    system: str,
    user: str,
    schema: dict[str, Any],
    schema_name: str = "response",
    temperature: float = 0.7,
    *,
    trace_name: str = "chat_parsed",
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Structured Outputs with model fallbacks (gpt-5.6-sol first if listed)."""
    from common import extract_json

    t0 = time.time()
    assert_within_budget()
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]
    last_err: Exception | None = None
    used = model
    content = ""
    structured_fmt: dict[str, Any] = {
        "type": "json_schema",
        "json_schema": {
            "name": schema_name,
            "strict": True,
            "schema": schema,
        },
    }
    for cand in model_candidates(model):
        used = cand
        for fmt in (structured_fmt, {"type": "json_object"}):
            try:
                resp = _create_completion(
                    client,
                    cand,
                    messages,
                    temperature=temperature,
                    response_format=fmt,
                )
                content = _completion_text(resp)
                parsed = extract_json(content)
                if not isinstance(parsed, dict) or parsed == {}:
                    raise RuntimeError("LLM returned empty JSON object")
                record_usage(
                    resp,
                    prompt_chars=len(system) + len(user),
                    completion_chars=len(content),
                )
                _langfuse_log(
                    name=trace_name,
                    model=used,
                    system=system[:2000],
                    user=user[:4000],
                    output=content[:4000],
                    latency_ms=(time.time() - t0) * 1000,
                    metadata={
                        **(metadata or {}),
                        "structured": fmt.get("type") == "json_schema",
                        "model_used": used,
                    },
                )
                return parsed
            except Exception as e:
                last_err = e
                continue
    if last_err is not None:
        raise last_err
    return extract_json(content)
