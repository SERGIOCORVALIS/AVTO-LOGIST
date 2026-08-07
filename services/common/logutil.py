"""File logger for Python services → LOG_DIR/orchestrator|audit."""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path


def _root() -> Path:
    if os.getenv("LOG_DIR"):
        return Path(os.getenv("LOG_DIR", ""))
    cwd = Path.cwd()
    for candidate in (cwd / "logs", cwd.parent / "logs", cwd.parent.parent / "logs"):
        parent = candidate.parent
        if (parent / "pnpm-workspace.yaml").exists() or (parent / "package.json").exists():
            return candidate
    return cwd / "logs"


def _ensure(service: str) -> Path:
    d = _root() / service
    d.mkdir(parents=True, exist_ok=True)
    return d


def log(service: str, level: str, msg: str, **meta) -> None:
    d = _ensure(service)
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    line = json.dumps(
        {
            "ts": datetime.now(timezone.utc).isoformat(),
            "service": service,
            "level": level,
            "msg": msg,
            **meta,
        },
        ensure_ascii=False,
        default=str,
    )
    for name in (f"{day}.log", "current.log"):
        with open(d / name, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    print(f"[{service}] {level}: {msg}", meta or "")


def audit(msg: str, **meta) -> None:
    log("audit", "audit", msg, **meta)
    log("orchestrator", "info", msg, audit=True, **meta)


def info(msg: str, **meta) -> None:
    log("orchestrator", "info", msg, **meta)


def warn(msg: str, **meta) -> None:
    log("orchestrator", "warn", msg, **meta)


def error(msg: str, **meta) -> None:
    log("orchestrator", "error", msg, **meta)


def ensure_log_tree() -> None:
    for s in ("api", "gateway", "workers", "orchestrator", "bootstrap", "audit"):
        _ensure(s)
