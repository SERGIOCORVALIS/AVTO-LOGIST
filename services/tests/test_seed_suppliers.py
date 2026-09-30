"""Tests for Trans Russia supplier catalog seed (no DB required for dry-run)."""

from agents.seed_suppliers import DATA_FILE, load_catalog, seed_suppliers


def test_trans_russia_catalog_present():
    assert DATA_FILE.is_file(), DATA_FILE
    cat = load_catalog()
    assert cat["counts"]["total"] >= 100
    assert cat["counts"]["with_email"] >= 100
    assert any(s["code"] == "optimalog" for s in cat["suppliers"])
    assert any("silkroadgroup.ru" in "@".join(s.get("emails") or []) or
               any("silkroad" in e for e in (s.get("emails") or []))
               for s in cat["suppliers"])


def test_seed_dry_run():
    stats = seed_suppliers(dry_run=True)
    assert stats["would_seed"] >= 100
    assert stats["with_email"] >= 100


def test_modes_cover_key_families():
    cat = load_catalog()
    modes = {m for s in cat["suppliers"] for m in s.get("modes") or []}
    for needed in ("rail", "air", "sea", "container", "ftl_truck"):
        assert needed in modes
