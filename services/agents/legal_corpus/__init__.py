"""Load official-ish legal snippets for DeepSeek RAG context."""

from __future__ import annotations

from pathlib import Path


def corpus_dir() -> Path:
    return Path(__file__).resolve().parent


def load_legal_context(query: str = "", limit_chars: int = 8000) -> str:
    root = corpus_dir()
    if not root.exists():
        return ""
    q = (query or "").lower().strip()
    scored: list[tuple[int, str]] = []
    for path in sorted(root.rglob("*")):
        if path.suffix.lower() not in {".md", ".txt"}:
            continue
        if "hs_rates" in path.parts and path.suffix.lower() == ".json":
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        low = text.lower()
        score = 0
        if path.name.upper() in {"SOURCES.MD", "OVERVIEW.MD"}:
            score += 1
        if q:
            # content match beats filename-only
            if q in low:
                score += 10 + low.count(q)
            elif any(tok in low for tok in q.split() if len(tok) > 3):
                score += 3
            elif q in path.name.lower():
                score += 2
            elif score == 0:
                continue
        else:
            score = 1
        scored.append((score, f"### {path.relative_to(root)}\n{text.strip()}"))

    scored.sort(key=lambda x: x[0], reverse=True)
    blob = "\n\n".join(chunk for _, chunk in scored)
    return blob[:limit_chars]
