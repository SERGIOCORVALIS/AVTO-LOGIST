"""Compatibility wrapper — PSZhVS seed lives in agents.seed_pszhvs."""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services"))

for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
    if "=" in line and not line.strip().startswith("#"):
        k, v = line.split("=", 1)
        if k.replace("_", "").isalnum():
            os.environ[k] = v

from agents.seed_pszhvs import seed_pszhvs_operators

if __name__ == "__main__":
    stats = seed_pszhvs_operators()
    print("done", stats)
