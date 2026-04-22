"""Translation cache: sliding TTL with hit-count bonus + glossary fingerprint keying."""
from __future__ import annotations

import sqlite3
import tempfile
import time
from pathlib import Path

import pytest

from app.cache import Cache, glossary_fingerprint
from app.config import CacheCfg


def _cfg(tmpdir: Path, *, ttl=7, bonus=3, max_days=180) -> CacheCfg:
    return CacheCfg(
        db_path=tmpdir / "cache.sqlite3",
        ttl_days=ttl,
        max_entries=1000,
        glossary_version=1,
        hit_bonus_days=bonus,
        max_ttl_days=max_days,
    )


@pytest.fixture
def cache(tmp_path):
    return Cache(_cfg(tmp_path))


def test_put_then_get_hits(cache):
    cache.put(text="hello", translation="你好", model="m", target="zh-CN")
    assert cache.get_text("hello", model="m", target="zh-CN") == "你好"


def test_miss_on_unknown_text(cache):
    assert cache.get_text("never cached", model="m", target="zh-CN") is None


def test_hit_count_increments(cache):
    cache.put(text="x", translation="y", model="m", target="zh-CN")
    for _ in range(5):
        cache.get_text("x", model="m", target="zh-CN")
    assert cache.stats()["max_hits"] == 5


def test_sliding_ttl_with_hit_bonus(tmp_path):
    # 5 hits → effective TTL = 7 + 3*5 = 22 days.
    cache = Cache(_cfg(tmp_path, ttl=7, bonus=3))
    cache.put(text="x", translation="y", model="m", target="zh-CN")
    for _ in range(5):
        cache.get_text("x", model="m", target="zh-CN")

    # Move last_hit_at back 8 days: within 22d window → hit.
    with sqlite3.connect(cache.cfg.db_path) as conn:
        conn.execute("UPDATE entries SET last_hit_at=?", (int(time.time()) - 8 * 86400,))
    assert cache.get_text("x", model="m", target="zh-CN") == "y"

    # Now push back 30 days: outside 22d (but hits is now 6 so 7+18=25, still < 30) → miss.
    with sqlite3.connect(cache.cfg.db_path) as conn:
        conn.execute("UPDATE entries SET last_hit_at=?", (int(time.time()) - 30 * 86400,))
    assert cache.get_text("x", model="m", target="zh-CN") is None


def test_max_ttl_days_caps_hot_entries(tmp_path):
    cache = Cache(_cfg(tmp_path, ttl=7, bonus=3, max_days=180))
    cache.put(text="x", translation="y", model="m", target="zh-CN")
    # Force hits way above the cap.
    with sqlite3.connect(cache.cfg.db_path) as conn:
        conn.execute("UPDATE entries SET hits=200")

    # 100 days ago with 200 hits → within 180d cap → hit.
    with sqlite3.connect(cache.cfg.db_path) as conn:
        conn.execute("UPDATE entries SET last_hit_at=?", (int(time.time()) - 100 * 86400,))
    assert cache.get_text("x", model="m", target="zh-CN") == "y"

    # 200 days ago → past 180d cap → miss.
    with sqlite3.connect(cache.cfg.db_path) as conn:
        conn.execute("UPDATE entries SET last_hit_at=?", (int(time.time()) - 200 * 86400,))
    assert cache.get_text("x", model="m", target="zh-CN") is None


def test_tag_lookup_beats_text_lookup(cache):
    # Same text under different tags should have distinct slots.
    cache.put(text="hi", translation="你好", model="m", target="zh-CN", tag="tweet:1")
    cache.put(text="hi", translation="嗨嗨", model="m", target="zh-CN", tag="tweet:2")
    assert cache.get_tag("tweet:1", model="m", target="zh-CN") == "你好"
    assert cache.get_tag("tweet:2", model="m", target="zh-CN") == "嗨嗨"


def test_glossary_fingerprint_stable_and_order_insensitive():
    a = glossary_fingerprint([("Einstein", "爱因斯坦"), ("Tokyo", "东京")])
    b = glossary_fingerprint([("Tokyo", "东京"), ("Einstein", "爱因斯坦")])
    assert a == b
    assert glossary_fingerprint([]) == ""
    assert glossary_fingerprint(None) == ""
    assert glossary_fingerprint([("Einstein", "爱因斯坦")]) != a


def test_glossary_change_invalidates(cache):
    # Put with glossary A
    gfp_a = glossary_fingerprint([("Einstein", "爱测试")])
    cache.put(text="E found it", translation="爱测试发现了它", model="m", target="zh-CN", glossary_fp=gfp_a)

    # Same lookup with glossary A → hit
    assert cache.get_text("E found it", model="m", target="zh-CN", glossary_fp=gfp_a) == "爱测试发现了它"

    # Lookup with glossary B → miss (different cache row)
    gfp_b = glossary_fingerprint([("Einstein", "别的")])
    assert cache.get_text("E found it", model="m", target="zh-CN", glossary_fp=gfp_b) is None

    # Lookup with no glossary → also miss (empty fingerprint is its own row)
    assert cache.get_text("E found it", model="m", target="zh-CN") is None
