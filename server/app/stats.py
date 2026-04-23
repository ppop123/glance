"""Per-provider call stats — latency, success rate, token usage — aggregated
by (provider, model, day). Accessed from translator._call_upstream to record
each LLM call, and from the /providers/stats endpoint for UI display.

Intentionally tiny: a single SQLite table with an upsert counter. No retention
policy (30 days is small enough to keep forever for a personal tool)."""
from __future__ import annotations

import sqlite3
import threading
import time
from pathlib import Path


# Rough public list prices per 1M tokens (USD), input / output. Meant for
# back-of-envelope "how much did I spend this month" — NOT a billing ledger.
# Values are picked to reflect early-2026 public pricing; users who care about
# accuracy should override these in their own config (future hook — for now
# the extension just shows the estimate alongside the token counts).
#
# Matching is substring-based (lower-cased) so "claude-haiku-4-5-20251001"
# still hits the "claude-haiku" row.
DEFAULT_PRICING_USD_PER_1M: list[tuple[str, float, float]] = [
    # (model substring, input $/1M, output $/1M)
    ("claude-haiku",        1.00,   5.00),
    ("claude-sonnet",       3.00,  15.00),
    ("claude-opus",        15.00,  75.00),
    ("gpt-5.4",             5.00,  20.00),
    ("gpt-5",               5.00,  20.00),
    ("gpt-4.1",             2.50,  10.00),
    ("gpt-4o",              2.50,  10.00),
    ("gpt-4",              10.00,  30.00),
    ("deepseek-chat",       0.14,   0.28),
    ("deepseek-reasoner",   0.55,   2.19),
    ("kimi",                0.60,   2.40),
    ("qwen",                0.50,   2.00),
    ("glm",                 0.50,   1.50),
]


def estimate_cost_usd(model: str, tokens_in: int, tokens_out: int) -> float:
    """Return a rough USD estimate for the given call. Unknown model → 0."""
    m = (model or "").lower()
    for sub, pin, pout in DEFAULT_PRICING_USD_PER_1M:
        if sub in m:
            return (tokens_in * pin + tokens_out * pout) / 1_000_000.0
    return 0.0


class StatsStore:
    def __init__(self, db_path: Path):
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(db_path), check_same_thread=False, isolation_level=None)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS provider_stats (
                provider TEXT NOT NULL,
                model    TEXT NOT NULL,
                day      TEXT NOT NULL,   -- YYYY-MM-DD UTC
                calls        INTEGER NOT NULL DEFAULT 0,
                errors       INTEGER NOT NULL DEFAULT 0,
                latency_ms   REAL    NOT NULL DEFAULT 0,  -- sum; divide by calls for avg
                tokens_in    INTEGER NOT NULL DEFAULT 0,
                tokens_out   INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (provider, model, day)
            );
            CREATE INDEX IF NOT EXISTS idx_stats_day ON provider_stats(day);
            """
        )
        self._lock = threading.Lock()

    def record(
        self,
        *,
        provider: str,
        model: str,
        latency_ms: float,
        error: bool,
        tokens_in: int = 0,
        tokens_out: int = 0,
    ) -> None:
        day = time.strftime("%Y-%m-%d", time.gmtime())
        with self._lock:
            self._conn.execute(
                "INSERT INTO provider_stats(provider, model, day, calls, errors, latency_ms, tokens_in, tokens_out) "
                "VALUES(?,?,?,1,?,?,?,?) "
                "ON CONFLICT(provider, model, day) DO UPDATE SET "
                "  calls=calls+1, errors=errors+excluded.errors, "
                "  latency_ms=latency_ms+excluded.latency_ms, "
                "  tokens_in=tokens_in+excluded.tokens_in, "
                "  tokens_out=tokens_out+excluded.tokens_out",
                (provider, model, day, 1 if error else 0, latency_ms, tokens_in, tokens_out),
            )

    def aggregate(self, *, days: int = 30) -> list[dict]:
        """Aggregate across the last `days` days per (provider, model)."""
        cutoff = time.strftime("%Y-%m-%d", time.gmtime(time.time() - days * 86400))
        with self._lock:
            rows = self._conn.execute(
                "SELECT provider, model, "
                "  SUM(calls) AS calls, SUM(errors) AS errors, "
                "  SUM(latency_ms) AS lat_sum, "
                "  SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out "
                "FROM provider_stats "
                "WHERE day >= ? "
                "GROUP BY provider, model "
                "ORDER BY calls DESC",
                (cutoff,),
            ).fetchall()
        out: list[dict] = []
        for provider, model, calls, errors, lat_sum, tokens_in, tokens_out in rows:
            calls = calls or 0
            tin = tokens_in or 0
            tout = tokens_out or 0
            out.append({
                "provider": provider,
                "model": model,
                "calls": calls,
                "errors": errors or 0,
                "success_rate": (1 - (errors or 0) / calls) if calls else 0.0,
                "avg_latency_ms": (lat_sum / calls) if calls else 0.0,
                "tokens_in": tin,
                "tokens_out": tout,
                "cost_usd": round(estimate_cost_usd(model, tin, tout), 4),
            })
        return out
