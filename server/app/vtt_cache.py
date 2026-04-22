"""Per-URL VTT cache. Once a video has been transcribed we keep the cues around
so subsequent requests for the same URL return instantly without another ASR job.

Schema:
    url TEXT PRIMARY KEY      canonical video URL
    cues_json TEXT            JSON list of {start, end, text}
    duration REAL
    language TEXT
    title TEXT
    created_at INTEGER        epoch seconds
"""
from __future__ import annotations

import json
import re
import sqlite3
import threading
import time
from pathlib import Path


# Hosts whose query string is pure tracking/UI noise — path alone is identity.
_DROP_QUERY_HOSTS_RE = re.compile(
    r"^https?://(www\.|m\.)?(x\.com|twitter\.com|youtu\.be|bilibili\.com|vimeo\.com|twitch\.tv|ted\.com|dailymotion\.com)(/|$)",
    re.I,
)
# YouTube needs special handling: `?v=<id>` IS the identity but `t=`, `si=`, etc. are noise.
_YOUTUBE_HOST_RE = re.compile(r"^https?://(www\.|m\.)?youtube\.com(/|$)", re.I)
_YOUTUBE_V_RE = re.compile(r"[?&]v=([A-Za-z0-9_-]+)")


# Normalize URLs so the same logical video hits the same cache entry regardless of
# tracking params / x.com vs twitter.com / trailing slashes / playback timestamps.
def canonical_url(url: str) -> str:
    u = (url or "").strip()
    # unify host: mobile./m.twitter.com → x.com
    u = re.sub(r"^https?://(mobile\.|m\.)?twitter\.com", "https://x.com", u, flags=re.I)

    if _YOUTUBE_HOST_RE.match(u):
        m = _YOUTUBE_V_RE.search(u)
        base = re.sub(r"\?.*$", "", u).rstrip("/")
        return base + (f"?v={m.group(1)}" if m else "")
    if _DROP_QUERY_HOSTS_RE.match(u):
        u = re.sub(r"\?.*$", "", u)
    # Unknown hosts: keep query — it may carry the video id.
    return u.rstrip("/")


class VttCache:
    def __init__(self, db_path: Path, ttl_days: int = 90):
        self.db_path = db_path
        self.ttl_days = ttl_days
        self._conn = sqlite3.connect(str(db_path), check_same_thread=False, isolation_level=None)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS video_transcripts (
                url TEXT PRIMARY KEY,
                cues_json TEXT NOT NULL,
                duration REAL,
                language TEXT,
                title TEXT,
                created_at INTEGER NOT NULL
            );
            """
        )
        self._lock = threading.Lock()

    def get(self, url: str) -> dict | None:
        key = canonical_url(url)
        cutoff = int(time.time()) - self.ttl_days * 86400
        with self._lock:
            row = self._conn.execute(
                "SELECT cues_json, duration, language, title, created_at "
                "FROM video_transcripts WHERE url=? AND created_at>=?",
                (key, cutoff),
            ).fetchone()
        if not row:
            return None
        cues_json, duration, language, title, created_at = row
        try:
            cues = json.loads(cues_json)
        except Exception:
            return None
        return {
            "cues": cues,
            "duration": duration,
            "language": language,
            "title": title,
            "created_at": created_at,
        }

    def put(self, url: str, *, cues: list[dict], duration: float | None, language: str | None, title: str | None) -> None:
        key = canonical_url(url)
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO video_transcripts(url,cues_json,duration,language,title,created_at) "
                "VALUES(?,?,?,?,?,?)",
                (key, json.dumps(cues, ensure_ascii=False), duration, language, title, int(time.time())),
            )

    def stats(self) -> dict:
        with self._lock:
            row = self._conn.execute(
                "SELECT COUNT(*), SUM(LENGTH(cues_json)) FROM video_transcripts"
            ).fetchone()
        n, nbytes = row
        return {"entries": n, "bytes": nbytes, "db_path": str(self.db_path)}

    def invalidate(self, url: str | None = None) -> int:
        with self._lock:
            if url:
                cur = self._conn.execute("DELETE FROM video_transcripts WHERE url=?", (canonical_url(url),))
            else:
                cur = self._conn.execute("DELETE FROM video_transcripts")
            return cur.rowcount
