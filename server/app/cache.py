"""SQLite-backed translation cache.

Schema is tiny and intentionally dumb:
  key TEXT PRIMARY KEY   = sha256(model|target|glossary_ver|text) OR sha256(model|target|glossary_ver|'tweet:'|tweetId)
  value TEXT             = translated text
  model TEXT
  target TEXT
  created_at INTEGER     = epoch seconds
  last_hit_at INTEGER

Eviction: size-based LRU (`last_hit_at`) triggered every N puts.
TTL is lazy: on read, skip rows older than ttl_days.
"""
from __future__ import annotations

import hashlib
import sqlite3
import threading
import time
from pathlib import Path
from typing import Iterable

from .config import CacheCfg


def _key(model: str, target: str, glossary_version: int, text_or_id: str) -> str:
    h = hashlib.sha256()
    h.update(model.encode())
    h.update(b"|")
    h.update(target.encode())
    h.update(b"|")
    h.update(str(glossary_version).encode())
    h.update(b"|")
    h.update(text_or_id.encode())
    return h.hexdigest()


class Cache:
    def __init__(self, cfg: CacheCfg):
        self.cfg = cfg
        self.cfg.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(cfg.db_path), check_same_thread=False, isolation_level=None)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS entries (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                model TEXT NOT NULL,
                target TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                last_hit_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_last_hit ON entries(last_hit_at);
            CREATE INDEX IF NOT EXISTS idx_created  ON entries(created_at);
            """
        )
        self._lock = threading.Lock()
        self._puts_since_evict = 0

    def _ttl_cutoff(self) -> int:
        return int(time.time()) - self.cfg.ttl_days * 86400

    def get_text(self, text: str, *, model: str, target: str) -> str | None:
        return self._get(_key(model, target, self.cfg.glossary_version, text))

    def get_tag(self, tag: str, *, model: str, target: str) -> str | None:
        """Secondary lookup by a stable site-provided id (e.g., 'tweet:12345')."""
        return self._get(_key(model, target, self.cfg.glossary_version, "\x00tag\x00" + tag))

    def _get(self, key: str) -> str | None:
        cutoff = self._ttl_cutoff()
        with self._lock:
            row = self._conn.execute(
                "SELECT value FROM entries WHERE key=? AND created_at>=?",
                (key, cutoff),
            ).fetchone()
            if row is None:
                return None
            self._conn.execute(
                "UPDATE entries SET last_hit_at=? WHERE key=?",
                (int(time.time()), key),
            )
            return row[0]

    def put(self, *, text: str, translation: str, model: str, target: str, tag: str | None = None) -> None:
        now = int(time.time())
        keys = [_key(model, target, self.cfg.glossary_version, text)]
        if tag:
            keys.append(_key(model, target, self.cfg.glossary_version, "\x00tag\x00" + tag))
        with self._lock:
            for k in keys:
                self._conn.execute(
                    "INSERT OR REPLACE INTO entries(key,value,model,target,created_at,last_hit_at) "
                    "VALUES(?,?,?,?,?,?)",
                    (k, translation, model, target, now, now),
                )
            self._puts_since_evict += len(keys)
            if self._puts_since_evict >= 200:
                self._puts_since_evict = 0
                self._evict_locked()

    def _evict_locked(self) -> None:
        row = self._conn.execute("SELECT COUNT(*) FROM entries").fetchone()
        n = row[0] if row else 0
        if n <= self.cfg.max_entries:
            return
        excess = n - self.cfg.max_entries
        self._conn.execute(
            "DELETE FROM entries WHERE key IN ("
            "  SELECT key FROM entries ORDER BY last_hit_at ASC LIMIT ?"
            ")",
            (excess,),
        )

    def stats(self) -> dict:
        with self._lock:
            row = self._conn.execute(
                "SELECT COUNT(*), MIN(created_at), MAX(last_hit_at) FROM entries"
            ).fetchone()
        n, min_created, max_hit = row
        return {
            "entries": n,
            "oldest_created_at": min_created,
            "latest_hit_at": max_hit,
            "db_path": str(self.cfg.db_path),
            "glossary_version": self.cfg.glossary_version,
        }

    def invalidate_all(self) -> int:
        with self._lock:
            cur = self._conn.execute("DELETE FROM entries")
            return cur.rowcount
