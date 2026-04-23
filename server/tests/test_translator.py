"""Translator model resolution edge cases — especially the `provider:model`
routing. Previous bug: unknown provider prefix silently fell back to the
default provider while keeping the bogus string, letting garbage reach
the upstream which returned a confusing 400."""
from __future__ import annotations

from pathlib import Path

import pytest

from app.cache import Cache
from app.config import (
    AsrCfg, CacheCfg, Config, DefaultsCfg, ProviderCfg, UpstreamCfg,
)
from app.translator import Translator, UnknownProviderError


def _make_translator(tmp_path: Path, providers: list[ProviderCfg]) -> Translator:
    cache_cfg = CacheCfg(
        db_path=tmp_path / "cache.sqlite3",
        ttl_days=7, max_entries=100, glossary_version=1,
    )
    cfg = Config(
        host="127.0.0.1", port=8787, log_level="info",
        upstream=UpstreamCfg(base_url="http://x", api_key="k", timeout_s=10),
        providers=providers,
        defaults=DefaultsCfg(
            model=f"{providers[0].name}:default-model",
            target_lang="zh-CN", temperature=0, max_output_tokens=2048,
            batch_size=30, concurrency=4,
        ),
        cache=cache_cfg,
        asr=AsrCfg(base_url="http://asr", timeout_s=10, enabled=False),
    )
    return Translator(cfg, Cache(cache_cfg))


def _provider(name: str, enabled: bool = True) -> ProviderCfg:
    return ProviderCfg(
        name=name, label=name, base_url="http://localhost/",
        api_key="k", protocol="openai", models=["default-model"],
        enabled=enabled, timeout_s=10,
    )


def test_resolve_model_matches_known_prefix(tmp_path):
    tr = _make_translator(tmp_path, [_provider("ccpa"), _provider("deepseek")])
    provider, model = tr.resolve_model("deepseek:deepseek-chat")
    assert provider.name == "deepseek"
    assert model == "deepseek-chat"


def test_resolve_model_falls_back_to_default_when_no_prefix(tmp_path):
    tr = _make_translator(tmp_path, [_provider("ccpa"), _provider("deepseek")])
    provider, model = tr.resolve_model("some-plain-name")
    assert provider.name == "ccpa"  # first provider wins
    assert model == "some-plain-name"


def test_resolve_model_raises_on_unknown_prefix(tmp_path):
    tr = _make_translator(tmp_path, [_provider("ccpa"), _provider("deepseek")])
    with pytest.raises(UnknownProviderError) as excinfo:
        tr.resolve_model("bogus-provider:some-model")
    msg = str(excinfo.value)
    assert "bogus-provider" in msg
    assert "ccpa" in msg and "deepseek" in msg  # should list known providers


def test_resolve_model_treats_disabled_provider_as_unknown(tmp_path):
    tr = _make_translator(tmp_path, [_provider("ccpa"), _provider("deepseek", enabled=False)])
    with pytest.raises(UnknownProviderError):
        tr.resolve_model("deepseek:deepseek-chat")


def test_resolve_model_handles_null(tmp_path):
    tr = _make_translator(tmp_path, [_provider("ccpa")])
    provider, model = tr.resolve_model(None)
    assert provider.name == "ccpa"
    # defaults.model was "ccpa:default-model" — strip prefix.
    assert model == "default-model"


# ── Provider failover ──────────────────────────────────────────────────
# If the primary provider errors out on 5xx / network, we retry with
# every OTHER enabled provider (in config order) using their first listed
# model. 4xx is NOT retried — the request itself is malformed.

import httpx


@pytest.mark.asyncio
async def test_failover_tries_next_provider_on_5xx(tmp_path, monkeypatch):
    tr = _make_translator(tmp_path, [_provider("ccpa"), _provider("deepseek")])
    calls = []

    async def fake_dispatch(*, provider, mdl_name, texts, msgs):
        calls.append(provider.name)
        if provider.name == "ccpa":
            # Simulate a 500 from primary.
            raise httpx.HTTPStatusError(
                "500 Internal Server Error",
                request=httpx.Request("POST", "http://x"),
                response=httpx.Response(500, request=httpx.Request("POST", "http://x")),
            )
        return ["你好"]  # deepseek succeeds

    monkeypatch.setattr(tr, "_dispatch_one", fake_dispatch)
    parsed, topic, reason = await tr._call_upstream(
        ["hello"], target="zh-CN", model="ccpa:default-model", site=None,
    )
    assert parsed == ["你好"]
    assert calls == ["ccpa", "deepseek"]  # primary first, then fallback


@pytest.mark.asyncio
async def test_failover_does_not_retry_on_4xx(tmp_path, monkeypatch):
    tr = _make_translator(tmp_path, [_provider("ccpa"), _provider("deepseek")])
    calls = []

    async def fake_dispatch(*, provider, mdl_name, texts, msgs):
        calls.append(provider.name)
        raise httpx.HTTPStatusError(
            "400 Bad Request",
            request=httpx.Request("POST", "http://x"),
            response=httpx.Response(400, request=httpx.Request("POST", "http://x")),
        )

    monkeypatch.setattr(tr, "_dispatch_one", fake_dispatch)
    with pytest.raises(httpx.HTTPStatusError):
        await tr._call_upstream(
            ["hello"], target="zh-CN", model="ccpa:default-model", site=None,
        )
    # Should have hit ONLY the primary — 4xx means request is bad, not provider.
    assert calls == ["ccpa"]


@pytest.mark.asyncio
async def test_failover_on_network_error(tmp_path, monkeypatch):
    tr = _make_translator(tmp_path, [_provider("ccpa"), _provider("deepseek")])
    calls = []

    async def fake_dispatch(*, provider, mdl_name, texts, msgs):
        calls.append(provider.name)
        if provider.name == "ccpa":
            raise httpx.ConnectError("connection refused", request=httpx.Request("POST", "http://x"))
        return ["你好"]

    monkeypatch.setattr(tr, "_dispatch_one", fake_dispatch)
    parsed, _, _ = await tr._call_upstream(
        ["hello"], target="zh-CN", model="ccpa:default-model", site=None,
    )
    assert parsed == ["你好"]
    assert calls == ["ccpa", "deepseek"]
