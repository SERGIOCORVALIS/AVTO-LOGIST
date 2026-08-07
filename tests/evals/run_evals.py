"""Simple eval runner against live orchestrator (optional)."""
from __future__ import annotations

import json
import sys
import uuid
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
EVALS = ROOT / "evals"


def run_case(base: str, case: dict) -> tuple[bool, str]:
    payload = {
        "chat_id": case["input"]["chat_id"],
        "text": case["input"]["text"],
        "idempotency_key": f"eval:{case['name']}:{uuid.uuid4()}",
    }
    r = httpx.post(f"{base}/process", json=payload, timeout=60)
    data = r.json()
    exp = case["expect"]
    if exp.get("has_replies") and not data.get("replies"):
        return False, "no replies"
    if "escalate" in exp and bool(data.get("escalate")) != bool(exp["escalate"]):
        return False, f"escalate want {exp['escalate']} got {data.get('escalate')}"
    if exp.get("hard_block") and not data.get("escalate"):
        return False, "expected hard block escalation"
    if exp.get("status_in") and data.get("status") not in exp["status_in"]:
        return False, f"status {data.get('status')} not in {exp['status_in']}"
    return True, "ok"


def main():
    base = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8000"
    failed = 0
    for path in sorted(EVALS.glob("gold_*.json")):
        case = json.loads(path.read_text(encoding="utf-8"))
        ok, msg = run_case(base, case)
        print(f"{'PASS' if ok else 'FAIL'} {case['name']}: {msg}")
        if not ok:
            failed += 1
    sys.exit(failed)


if __name__ == "__main__":
    main()
