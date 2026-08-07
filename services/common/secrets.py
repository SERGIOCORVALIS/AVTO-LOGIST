"""
Load secrets from Doppler / .env.vault / dotenv.

Priority:
  1) Already-set process env
  2) Doppler CLI (`doppler secrets download --no-file --format env`) if DOPPLER_TOKEN or doppler.yaml
  3) .env file via python-dotenv / dotenv in Node

Usage (Node): node -r ./scripts/load-secrets.cjs ...
Usage (Python): from common.secrets import load_secrets; load_secrets()
Usage (shell):  scripts/load-secrets.ps1
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def load_secrets(dotenv_path: str | None = None) -> dict[str, str]:
    loaded: dict[str, str] = {}
    root = _repo_root()

    # Doppler
    if os.getenv("DOPPLER_TOKEN") or (root / "doppler.yaml").exists():
        try:
            out = subprocess.check_output(
                ["doppler", "secrets", "download", "--no-file", "--format", "env"],
                cwd=str(root),
                stderr=subprocess.DEVNULL,
                text=True,
                timeout=20,
            )
            for line in out.splitlines():
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                v = v.strip().strip('"').strip("'")
                if k and k not in os.environ:
                    os.environ[k] = v
                    loaded[k] = "***"
        except Exception:
            pass

    # dotenv
    try:
        from dotenv import load_dotenv

        path = Path(dotenv_path) if dotenv_path else root / ".env"
        if path.exists():
            load_dotenv(path, override=False)
            loaded["__dotenv__"] = str(path)
    except Exception:
        pass

    return loaded
