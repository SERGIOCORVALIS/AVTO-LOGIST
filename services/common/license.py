"""Proprietary license gate: 12-month trial after first install, then LICENSE_KEY."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import math
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

LICENSE_TRIAL_MONTHS = 12
INSTALL_FILE = ".alo_install.json"
LICENSE_FILE = ".alo_license"

ISSUER_SECRET = os.environ.get(
    "ALO_LICENSE_ISSUER_SECRET",
    "alo-psv-2026-proprietary-issuer-v1-7f3c9e2a1b8d4f06",
)


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _b64url_decode(data: str) -> bytes:
    pad = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + pad)


def _find_repo_root() -> Path:
    env_root = os.environ.get("ALO_ROOT") or os.environ.get("LICENSE_DATA_DIR")
    if env_root:
        p = Path(env_root).resolve()
        if p.exists():
            return p

    here = Path.cwd().resolve()
    for candidate in [here, *here.parents]:
        if (candidate / "pnpm-workspace.yaml").exists() or (
            (candidate / "package.json").exists() and (candidate / "apps").exists()
        ):
            return candidate
        if len(candidate.parts) <= 1:
            break
    # services/common -> repo root
    return Path(__file__).resolve().parents[2]


def _data_dir() -> Path:
    d = _find_repo_root() / "data"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _sign_payload(payload_b64: str) -> str:
    dig = hmac.new(
        ISSUER_SECRET.encode("utf-8"),
        payload_b64.encode("utf-8"),
        hashlib.sha256,
    ).digest()
    return _b64url(dig)


def ensure_install_stamp(now: datetime | None = None) -> tuple[str, bool]:
    now = now or datetime.now(timezone.utc)
    file = _data_dir() / INSTALL_FILE
    if file.exists():
        try:
            raw = json.loads(file.read_text(encoding="utf-8"))
            if raw.get("installedAt"):
                return str(raw["installedAt"]), False
        except (json.JSONDecodeError, OSError):
            pass
    installed_at = now.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    file.write_text(
        json.dumps(
            {
                "installedAt": installed_at,
                "product": "AutoLogistics OS",
                "copyright": "Copyright (c) 2026 Pankov Sergey Vladimirovich",
            },
            indent=2,
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )
    return installed_at, True


def _parse_iso(ts: str) -> datetime:
    if ts.endswith("Z"):
        ts = ts[:-1] + "+00:00"
    return datetime.fromisoformat(ts)


def trial_ends_at(installed_at_iso: str) -> datetime:
    d = _parse_iso(installed_at_iso)
    # month arithmetic without dateutil
    month = d.month - 1 + LICENSE_TRIAL_MONTHS
    year = d.year + month // 12
    month = month % 12 + 1
    day = min(d.day, [31, 29 if year % 4 == 0 and (year % 100 != 0 or year % 400 == 0) else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1])
    return d.replace(year=year, month=month, day=day)


def _read_stored_key() -> str:
    env_key = (os.environ.get("LICENSE_KEY") or "").strip()
    if env_key:
        return env_key
    file = _data_dir() / LICENSE_FILE
    if file.exists():
        return file.read_text(encoding="utf-8").strip()
    return ""


def save_license_key(key: str) -> None:
    (_data_dir() / LICENSE_FILE).write_text(key.strip() + "\n", encoding="utf-8")


def verify_license_key(key: str, now: datetime | None = None) -> dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    raw = key.strip()
    if not raw:
        return {"valid": False, "reason": "empty_key"}
    parts = raw.split(".")
    if len(parts) != 3 or parts[0] != "ALO1":
        return {"valid": False, "reason": "invalid_format"}
    payload_b64, sig = parts[1], parts[2]
    expected = _sign_payload(payload_b64)
    if not hmac.compare_digest(sig, expected):
        return {"valid": False, "reason": "bad_signature"}
    try:
        payload = json.loads(_b64url_decode(payload_b64).decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
        return {"valid": False, "reason": "bad_payload"}

    exp = payload.get("exp")
    subject = payload.get("sub")
    if exp is not None and exp > 0:
        exp_dt = datetime.fromtimestamp(exp, tz=timezone.utc)
        if now.astimezone(timezone.utc) > exp_dt:
            return {
                "valid": False,
                "reason": "key_expired",
                "subject": subject,
                "expiresAt": exp_dt.isoformat().replace("+00:00", "Z"),
            }
        return {
            "valid": True,
            "subject": subject,
            "expiresAt": exp_dt.isoformat().replace("+00:00", "Z"),
        }
    return {"valid": True, "subject": subject}


def check_license(now: datetime | None = None) -> dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    installed_at, _ = ensure_install_stamp(now)
    ends = trial_ends_at(installed_at)
    key = _read_stored_key()

    if key:
        v = verify_license_key(key, now)
        if v.get("valid"):
            return {
                "ok": True,
                "mode": "licensed",
                "subject": v.get("subject"),
                "expiresAt": v.get("expiresAt"),
            }

    if now.astimezone(timezone.utc) <= ends.astimezone(timezone.utc):
        seconds_left = (
            ends.astimezone(timezone.utc) - now.astimezone(timezone.utc)
        ).total_seconds()
        days_left = max(0, math.ceil(seconds_left / 86400))
        return {
            "ok": True,
            "mode": "trial",
            "installedAt": installed_at,
            "trialEndsAt": ends.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
            "daysLeft": days_left,
        }

    reason = (
        "Пробный период закончился, а LICENSE_KEY недействителен."
        if key
        else "Пробный период 12 месяцев закончился. Требуется LICENSE_KEY."
    )
    return {
        "ok": False,
        "reason": reason,
        "installedAt": installed_at,
        "trialEndsAt": ends.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
    }


def enforce_license(service: str = "orchestrator", allow_prompt: bool | None = None) -> dict[str, Any]:
    if str(os.environ.get("ALO_LICENSE_ALLOW_PROMPT", "")).strip().lower() in (
        "0",
        "false",
        "no",
    ):
        allow_prompt = False
    elif allow_prompt is None:
        allow_prompt = sys.stdin.isatty()

    status = check_license()
    if status.get("ok"):
        if status.get("mode") == "trial" and int(status.get("daysLeft") or 0) <= 14:
            print(
                f"[license:{service}] Пробный период: осталось ~{status['daysLeft']} дн. "
                f"(до {status.get('trialEndsAt')}). После этого нужен LICENSE_KEY.",
                file=sys.stderr,
            )
        elif status.get("mode") == "licensed":
            extra = ""
            if status.get("subject"):
                extra += f" ({status['subject']})"
            if status.get("expiresAt"):
                extra += f", до {status['expiresAt']}"
            print(f"[license:{service}] Лицензия активна{extra}", file=sys.stderr)
        return status

    print("============================================================", file=sys.stderr)
    print(" AutoLogistics OS — требуется лицензионный ключ", file=sys.stderr)
    print(" Copyright (c) 2026 Pankov Sergey Vladimirovich", file=sys.stderr)
    print("============================================================", file=sys.stderr)
    print(status.get("reason", "license required"), file=sys.stderr)
    if status.get("trialEndsAt"):
        print(f"Пробный период истёк: {status['trialEndsAt']}", file=sys.stderr)
    print("Укажите ключ в .env (LICENSE_KEY=...) или в data/.alo_license", file=sys.stderr)
    print("Ключ выдаёт автор ПО по письменному соглашению.", file=sys.stderr)
    print("============================================================", file=sys.stderr)

    if allow_prompt:
        try:
            entered = input("\nВведите LICENSE_KEY (или оставьте пустым для выхода): ").strip()
        except EOFError:
            entered = ""
        if entered:
            v = verify_license_key(entered)
            if v.get("valid"):
                save_license_key(entered)
                os.environ["LICENSE_KEY"] = entered
                print("[license] Ключ принят и сохранён в data/.alo_license", file=sys.stderr)
                return check_license()
            print(f"[license] Ключ отклонён: {v.get('reason') or 'invalid'}", file=sys.stderr)

    sys.exit(78)
