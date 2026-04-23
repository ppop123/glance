"""User-added LLM providers, persisted to a JSON file outside of config.yaml.

API keys belong to individual users and must never end up in git or in the
shared config. This store writes to `~/.fanyi-ext/user_providers.json` by
default and is merged with config.yaml's static providers at runtime.
"""
from __future__ import annotations

import json
import threading
from pathlib import Path

from .config import ProviderCfg


class ProvidersStore:
    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()
        self._data: dict[str, dict] = {}
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                self._data = json.load(f) or {}
        except Exception:
            # Corrupt file — start empty. Don't crash the server over bad JSON.
            self._data = {}

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self._data, f, indent=2, ensure_ascii=False)
        tmp.replace(self.path)

    def list(self) -> list[ProviderCfg]:
        with self._lock:
            return [
                ProviderCfg(
                    name=name,
                    label=p.get("label") or name,
                    base_url=p["base_url"].rstrip("/"),
                    api_key=p.get("api_key", ""),
                    protocol=p.get("protocol", "openai"),
                    models=list(p.get("models", [])),
                    enabled=bool(p.get("enabled", True)),
                    timeout_s=int(p.get("timeout_s", 60)),
                )
                for name, p in self._data.items()
            ]

    def get(self, name: str) -> ProviderCfg | None:
        for p in self.list():
            if p.name == name:
                return p
        return None

    def upsert(self, *, name: str, base_url: str, api_key: str = "",
               protocol: str = "openai", models: list[str] | None = None,
               enabled: bool = True, timeout_s: int = 60, label: str = "") -> None:
        name = name.strip()
        if not name or ":" in name:
            raise ValueError("provider name must be non-empty and must not contain ':'")
        with self._lock:
            self._data[name] = {
                "label": label.strip() or name,
                "base_url": base_url.rstrip("/"),
                "api_key": api_key,
                "protocol": protocol or "openai",
                "models": [m.strip() for m in (models or []) if m.strip()],
                "enabled": bool(enabled),
                "timeout_s": int(timeout_s or 60),
            }
            self._save()

    def delete(self, name: str) -> bool:
        with self._lock:
            if name in self._data:
                del self._data[name]
                self._save()
                return True
            return False
