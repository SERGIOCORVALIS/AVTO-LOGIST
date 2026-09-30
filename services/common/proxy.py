from __future__ import annotations

import os
from typing import Any
from urllib.parse import quote

import httpx


def _trim(name: str) -> str:
    return (os.getenv(name) or "").strip()


def proxy_enabled() -> bool:
    raw = _trim("PROXY_ENABLED").lower()
    if raw in ("0", "false", "no", "off"):
        return False
    if raw in ("1", "true", "yes", "on"):
        return True
    return bool(_trim("PROXY_HOST") or _trim("PX6_HOST"))


def http_proxy_url() -> str | None:
    if not proxy_enabled():
        return None
    host = _trim("PROXY_HOST") or _trim("PX6_HOST")
    port = _trim("PROXY_PORT") or _trim("PX6_PORT")
    if not host or not port:
        return None
    user = _trim("PROXY_USERNAME") or _trim("PROXY_USER") or _trim("PX6_USER")
    password = _trim("PROXY_PASSWORD") or _trim("PROXY_PASS") or _trim("PX6_PASS")
    auth = f"{quote(user, safe='')}:{quote(password, safe='')}@" if user else ""
    return f"http://{auth}{host}:{port}"


def httpx_proxy_kwargs() -> dict[str, Any]:
    url = http_proxy_url()
    if not url:
        return {}
    return {"proxy": url}


def openai_http_client() -> httpx.Client | None:
    url = http_proxy_url()
    if not url:
        return None
    try:
        timeout_sec = float((os.getenv("OPENAI_TIMEOUT_SEC") or "120").strip() or 120)
    except ValueError:
        timeout_sec = 120.0
    if timeout_sec <= 0:
        timeout_sec = 120.0
    return httpx.Client(proxy=url, timeout=httpx.Timeout(timeout_sec))
