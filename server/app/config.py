from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

import yaml


@dataclass
class UpstreamCfg:
    base_url: str
    api_key: str
    timeout_s: int


@dataclass
class ModelTuning:
    batch_size: int
    concurrency: int


@dataclass
class DefaultsCfg:
    model: str
    target_lang: str
    temperature: float
    max_output_tokens: int
    batch_size: int
    concurrency: int
    # Optional per-model override: {"gpt-5.4": ModelTuning(50, 3), ...}. If the
    # model selected at call-time isn't in this map, the generic batch_size /
    # concurrency above apply.
    per_model: dict[str, ModelTuning] = field(default_factory=dict)


@dataclass
class CacheCfg:
    db_path: Path
    ttl_days: int           # base TTL for a cold entry (0 hits), measured from last_hit_at
    max_entries: int
    glossary_version: int
    hit_bonus_days: int = 3  # +days added per cache hit — frequently accessed entries live longer
    max_ttl_days: int = 180  # hard cap regardless of hit count


@dataclass
class AsrCfg:
    base_url: str
    timeout_s: int
    enabled: bool


@dataclass
class Config:
    host: str
    port: int
    upstream: UpstreamCfg
    defaults: DefaultsCfg
    cache: CacheCfg
    asr: AsrCfg
    log_level: str


def _expand(p: str) -> Path:
    return Path(os.path.expanduser(p)).resolve()


def load_config(path: str | Path | None = None) -> Config:
    if path is None:
        # search cwd, then ~/.fanyi-ext/config.yaml, then server/config.yaml next to package
        here = Path(__file__).resolve().parent.parent
        for cand in [Path.cwd() / "config.yaml", Path.home() / ".fanyi-ext/config.yaml", here / "config.yaml"]:
            if cand.exists():
                path = cand
                break
        else:
            raise FileNotFoundError("no config.yaml found; copy config.example.yaml to config.yaml")
    with open(path) as f:
        raw = yaml.safe_load(f)
    defaults_raw = dict(raw["defaults"])
    per_model_raw = defaults_raw.pop("per_model", {}) or {}
    per_model = {
        k: ModelTuning(batch_size=int(v["batch_size"]), concurrency=int(v["concurrency"]))
        for k, v in per_model_raw.items()
    }
    return Config(
        host=raw.get("host", "127.0.0.1"),
        port=int(raw.get("port", 8787)),
        upstream=UpstreamCfg(**raw["upstream"]),
        defaults=DefaultsCfg(**defaults_raw, per_model=per_model),
        cache=CacheCfg(
            db_path=_expand(raw["cache"]["db_path"]),
            ttl_days=int(raw["cache"]["ttl_days"]),
            max_entries=int(raw["cache"]["max_entries"]),
            glossary_version=int(raw["cache"]["glossary_version"]),
            hit_bonus_days=int(raw["cache"].get("hit_bonus_days", 3)),
            max_ttl_days=int(raw["cache"].get("max_ttl_days", 180)),
        ),
        asr=AsrCfg(**raw["asr"]),
        log_level=raw.get("log_level", "info"),
    )
