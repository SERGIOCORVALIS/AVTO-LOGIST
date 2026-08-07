"""Import official legal dumps into legal_corpus/ and refresh HS rates.

Usage:
  python -m agents.legal_corpus.import_dumps --src /path/to/dumps
  python -m agents.legal_corpus.import_dumps --hs-only
"""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path


def corpus_root() -> Path:
    return Path(__file__).resolve().parent


def import_text_dumps(src: Path) -> int:
    dest = corpus_root() / "dumps"
    dest.mkdir(parents=True, exist_ok=True)
    n = 0
    for path in src.rglob("*"):
        if path.suffix.lower() not in {".md", ".txt", ".html"}:
            continue
        target = dest / path.name
        shutil.copy2(path, target)
        n += 1
    return n


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--src", type=str, help="Directory with official dumps")
    parser.add_argument("--hs-only", action="store_true")
    args = parser.parse_args()

    if args.src and not args.hs_only:
        n = import_text_dumps(Path(args.src))
        print(f"imported_dumps={n}")

    from agents.hs_feed import refresh

    print("hs_refresh", refresh())


if __name__ == "__main__":
    main()
