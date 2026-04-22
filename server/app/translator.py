"""Translation service: cache → batch → auth2api → parse."""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from json import loads as json_loads

import httpx

from .cache import Cache, glossary_fingerprint
from .config import Config
from .prompts import build_messages, format_batch, parse_batch
from .stats import StatsStore

log = logging.getLogger(__name__)


@dataclass
class TranslateItem:
    text: str
    tag: str | None = None           # optional site-stable id (e.g. "tweet:12345")
    context: str | None = None       # optional disambiguation hint for short terms
                                     # ("Government section", "Osaka City infobox")


POLISH_SYSTEM = (
    "You are correcting an automatic-speech-recognition transcript.\n"
    "The user sends multiple short caption lines.\n"
    "Rules:\n"
    " (1) Return the SAME number of lines, in the same order, preserving each marker ⟦N⟧.\n"
    " (2) Fix obvious misheard words, homophones, missing particles, and bad word boundaries.\n"
    " (3) Keep the language of each line unchanged ({language}); do not translate.\n"
    " (4) Do NOT merge or split lines. Do NOT rephrase for style — only correct errors.\n"
    " (5) If a line is already correct, output it unchanged with its marker.\n"
    " (6) Output only the corrected lines, nothing else."
)


@dataclass
class TranslateResult:
    translations: list[str]
    cache_hits: list[bool]
    model: str
    target: str
    upstream_calls: int
    latency_ms: int
    inferred_topic: str | None = None
    topic_reason: str = "none"


class Translator:
    def __init__(self, cfg: Config, cache: Cache, stats: StatsStore | None = None):
        self.cfg = cfg
        self.cache = cache
        self.stats = stats
        # One httpx client per provider — different base_url, different auth,
        # different timeout budget.
        self._clients: dict[str, httpx.AsyncClient] = {}
        for p in cfg.providers:
            headers = {}
            if p.api_key:
                headers["Authorization"] = f"Bearer {p.api_key}"
            self._clients[p.name] = httpx.AsyncClient(
                base_url=p.base_url,
                timeout=p.timeout_s,
                headers=headers,
            )
        self._default_sem = asyncio.Semaphore(cfg.defaults.concurrency)
        # Per-model semaphores so one slow model's queue doesn't starve another.
        self._model_sems: dict[str, asyncio.Semaphore] = {}
        for name, tuning in (cfg.defaults.per_model or {}).items():
            self._model_sems[name] = asyncio.Semaphore(tuning.concurrency)

    def _tuning_for(self, model: str) -> tuple[int, asyncio.Semaphore]:
        """Return (batch_size, semaphore) for the given model (after prefix
        stripping). Matches both raw names ("claude-haiku-4-5") and prefixed
        names ("ccpa:claude-haiku-4-5")."""
        for key in (model, model.split(":")[-1]):
            tuning = (self.cfg.defaults.per_model or {}).get(key)
            if tuning:
                return tuning.batch_size, self._model_sems[key]
        return self.cfg.defaults.batch_size, self._default_sem

    async def aclose(self) -> None:
        for c in self._clients.values():
            await c.aclose()

    async def polish(self, texts: list[str], *, language: str, model: str | None = None) -> list[str]:
        """ASR-correction pass. Fix typos / homophones / missing chars in-place, same line count."""
        if not texts:
            return texts
        mdl_in = model or self.cfg.defaults.model
        provider, mdl = self.cfg.resolve_model(mdl_in)
        sys = POLISH_SYSTEM.format(language=language)
        body = {
            "model": mdl,
            "messages": [
                {"role": "system", "content": sys},
                {"role": "user", "content": format_batch(texts)},
            ],
            "temperature": 0,
            "max_tokens": self.cfg.defaults.max_output_tokens,
            "stream": True,
        }
        parts: list[str] = []
        client = self._clients[provider.name]
        try:
            async with client.stream("POST", "/chat/completions", json=body) as r:
                r.raise_for_status()
                async for line in r.aiter_lines():
                    if not line or not line.startswith("data: "):
                        continue
                    payload = line[6:]
                    if payload == "[DONE]":
                        break
                    try:
                        data = json_loads(payload)
                    except Exception:
                        continue
                    try:
                        delta = data["choices"][0]["delta"].get("content")
                    except (KeyError, IndexError):
                        delta = None
                    if delta:
                        parts.append(delta)
        except Exception as e:
            log.warning("polish failed, returning originals: %s", e)
            return texts
        parsed = parse_batch("".join(parts), len(texts))
        # If some lines fail to parse, fall back to original for those
        return [parsed[i] if parsed[i] is not None else texts[i] for i in range(len(texts))]

    async def translate(
        self,
        items: list[TranslateItem],
        *,
        target_lang: str | None = None,
        model: str | None = None,
        site: str | None = None,
        topic: str | None = None,
        glossary: list[tuple[str, str]] | None = None,
    ) -> TranslateResult:
        t0 = time.perf_counter()
        target = target_lang or self.cfg.defaults.target_lang
        mdl = model or self.cfg.defaults.model
        gfp = glossary_fingerprint(glossary)

        n = len(items)
        out: list[str | None] = [None] * n
        hits: list[bool] = [False] * n

        # 1) cache lookup — prefer tag then text. Lookups run in a thread so the
        # event loop can serve other requests while SQLite is blocking.
        miss_idx: list[int] = []

        def lookup(it):
            if it.tag:
                g = self.cache.get_tag(it.tag, model=mdl, target=target, glossary_fp=gfp)
                if g is not None:
                    return g
            return self.cache.get_text(it.text, model=mdl, target=target, glossary_fp=gfp)

        got_all = await asyncio.to_thread(lambda: [lookup(it) for it in items])
        for i, got in enumerate(got_all):
            if got is not None:
                out[i], hits[i] = got, True
            else:
                miss_idx.append(i)

        upstream_calls = 0
        inferred_topic: str | None = None
        topic_reason: str = "none"
        if miss_idx:
            # 2) batch misses and dispatch
            batches: list[list[int]] = []
            bs, sem = self._tuning_for(mdl)
            for start in range(0, len(miss_idx), bs):
                batches.append(miss_idx[start : start + bs])

            async def run_batch(indices: list[int]) -> None:
                nonlocal upstream_calls, inferred_topic, topic_reason
                texts = [items[i].text for i in indices]
                contexts = [items[i].context for i in indices]
                async with sem:
                    upstream_calls += 1
                    try:
                        translated, batch_topic, batch_reason = await self._call_upstream(texts, target=target, model=mdl, site=site, topic=topic, glossary=glossary, contexts=contexts)
                        if inferred_topic is None:  # first batch's topic wins for reporting
                            inferred_topic, topic_reason = batch_topic, batch_reason
                        # Safety net: if any item targeted zh* came back identical AND the source
                        # contains Japanese kana or Korean hangul, the LLM ignored rule (8).
                        # Retry those items in isolation with a sharpened instruction.
                        if target.lower().startswith("zh"):
                            redo_idx = []
                            import re as _re
                            for j, (src, tr) in enumerate(zip(texts, translated)):
                                if tr is None:
                                    continue
                                if src.strip() != tr.strip():
                                    continue
                                has_kana = bool(_re.search(r"[\u3040-\u309f\u30a0-\u30ff]", src))
                                has_hangul = bool(_re.search(r"[\uac00-\ud7a3]", src))
                                if has_kana or has_hangul:
                                    redo_idx.append(j)
                            if redo_idx:
                                log.info("redoing %d items that slipped past rule (8)", len(redo_idx))
                                redo_texts = [texts[j] for j in redo_idx]
                                upstream_calls += 1
                                redo_translated, _, _ = await self._call_upstream(
                                    redo_texts, target=target, model=mdl, site=site,
                                    topic=topic or "news", glossary=glossary,
                                )
                                for local_j, global_j in enumerate(redo_idx):
                                    if local_j < len(redo_translated) and redo_translated[local_j]:
                                        translated[global_j] = redo_translated[local_j]
                    except Exception as e:
                        log.warning("upstream batch failed: %s (size=%d); falling back to per-item", e, len(texts))
                        # Fallback: 1-at-a-time so a single bad item doesn't kill the batch.
                        translated = []
                        for t in texts:
                            try:
                                one_res, _, _ = await self._call_upstream([t], target=target, model=mdl, site=site, topic=topic, glossary=glossary)
                                translated.append(one_res[0] if one_res else None)
                            except Exception as ee:
                                log.error("single translate failed: %s", ee)
                                translated.append(None)
                to_cache = []
                for local_i, global_i in enumerate(indices):
                    tr = translated[local_i] if local_i < len(translated) else None
                    if tr is None:
                        out[global_i] = items[global_i].text  # graceful fallback = echo original
                    else:
                        out[global_i] = tr
                        to_cache.append((items[global_i].text, tr, items[global_i].tag))
                if to_cache:
                    def _put_all():
                        for t, tr, tag in to_cache:
                            self.cache.put(text=t, translation=tr, model=mdl, target=target, tag=tag, glossary_fp=gfp)
                    await asyncio.to_thread(_put_all)

            await asyncio.gather(*[run_batch(b) for b in batches])

        latency_ms = int((time.perf_counter() - t0) * 1000)
        return TranslateResult(
            translations=[o or "" for o in out],
            cache_hits=hits,
            model=mdl,
            target=target,
            upstream_calls=upstream_calls,
            latency_ms=latency_ms,
            inferred_topic=inferred_topic,
            topic_reason=topic_reason,
        )

    async def translate_stream(
        self,
        items: list[TranslateItem],
        *,
        target_lang: str | None = None,
        model: str | None = None,
        site: str | None = None,
        topic: str | None = None,
        glossary: list[tuple[str, str]] | None = None,
    ):
        """Async generator: yield batches as soon as they complete.

        Each yielded chunk: {"items": [{"i": int, "translation": str, "cached"?: bool, "failed"?: bool}]}.
        Cache hits flushed in one chunk first, then LLM batches via asyncio.as_completed.
        """
        target = target_lang or self.cfg.defaults.target_lang
        mdl = model or self.cfg.defaults.model
        gfp = glossary_fingerprint(glossary)

        def _lookups():
            miss = []
            results: list[dict | None] = [None] * len(items)
            for i, it in enumerate(items):
                g = None
                if it.tag:
                    g = self.cache.get_tag(it.tag, model=mdl, target=target, glossary_fp=gfp)
                if g is None:
                    g = self.cache.get_text(it.text, model=mdl, target=target, glossary_fp=gfp)
                if g is not None:
                    results[i] = {"i": i, "translation": g, "cached": True}
                else:
                    miss.append(i)
            return miss, results

        miss_idx, cached_rows = await asyncio.to_thread(_lookups)
        hits = [r for r in cached_rows if r is not None]

        if hits:
            yield {"items": hits}

        if not miss_idx:
            return

        bs, sem = self._tuning_for(mdl)
        batches = [miss_idx[s : s + bs] for s in range(0, len(miss_idx), bs)]

        async def run_batch(indices: list[int]) -> list[dict]:
            texts = [items[i].text for i in indices]
            contexts = [items[i].context for i in indices]
            async with sem:
                try:
                    translated, _, _ = await self._call_upstream(texts, target=target, model=mdl, site=site, topic=topic, glossary=glossary, contexts=contexts)
                except Exception as e:
                    log.warning("stream batch failed: %s (size=%d)", e, len(texts))
                    translated = [None] * len(texts)
            out: list[dict] = []
            to_cache = []
            for local_i, global_i in enumerate(indices):
                tr = translated[local_i] if local_i < len(translated) else None
                if tr is None:
                    out.append({"i": global_i, "translation": items[global_i].text, "failed": True})
                else:
                    out.append({"i": global_i, "translation": tr})
                    to_cache.append((items[global_i].text, tr, items[global_i].tag))
            if to_cache:
                def _put_all():
                    for t, tr, tag in to_cache:
                        self.cache.put(text=t, translation=tr, model=mdl, target=target, tag=tag, glossary_fp=gfp)
                await asyncio.to_thread(_put_all)
            return out

        tasks = [asyncio.create_task(run_batch(b)) for b in batches]
        try:
            for coro in asyncio.as_completed(tasks):
                batch_result = await coro
                yield {"items": batch_result}
        except asyncio.CancelledError:
            raise
        finally:
            # Runs on normal exit, CancelledError, AND generator close (client
            # disconnect). Each task's _call_upstream uses httpx.stream() which
            # respects task cancellation and closes the underlying TCP stream.
            for t in tasks:
                if not t.done():
                    t.cancel()

    async def _call_upstream(
        self, texts: list[str], *, target: str, model: str, site: str | None, topic: str | None = None,
        glossary: list[tuple[str, str]] | None = None,
        contexts: list[str | None] | None = None,
    ) -> tuple[list[str | None], str | None, str]:
        """Stream from the upstream and concatenate deltas.

        `model` may be a plain name ("claude-haiku-4-5") or prefixed
        ("deepseek:deepseek-chat") — we split and route to the matching provider.
        Streaming works for every OpenAI-compatible gateway we target today;
        it's also REQUIRED for gpt-5.x reasoning models, since ccpa non-stream
        drops visible content while stream exposes it via delta chunks.
        """
        provider, mdl_name = self.cfg.resolve_model(model)
        msgs, resolved_topic, topic_reason = build_messages(
            texts, target_lang=target, site=site, topic=topic, glossary=glossary,
            contexts=contexts,
        )
        body = {
            "model": mdl_name,
            "messages": msgs,
            "temperature": self.cfg.defaults.temperature,
            "max_tokens": self.cfg.defaults.max_output_tokens,
            "stream": True,
        }
        client = self._clients[provider.name]
        content_parts: list[str] = []
        tokens_in = 0
        tokens_out = 0
        t0 = time.perf_counter()
        error = False
        try:
            async with client.stream("POST", "/chat/completions", json=body) as r:
                r.raise_for_status()
                async for line in r.aiter_lines():
                    if not line or not line.startswith("data: "):
                        continue
                    payload = line[6:]
                    if payload == "[DONE]":
                        break
                    try:
                        data = json_loads(payload)
                    except Exception:
                        continue
                    try:
                        delta = data["choices"][0]["delta"].get("content")
                    except (KeyError, IndexError):
                        delta = None
                    if delta:
                        content_parts.append(delta)
                    # Upstream usually attaches usage on the final chunk.
                    usage = data.get("usage") if isinstance(data, dict) else None
                    if usage:
                        tokens_in = int(usage.get("prompt_tokens") or 0) or tokens_in
                        tokens_out = int(usage.get("completion_tokens") or 0) or tokens_out
        except Exception:
            error = True
            raise
        finally:
            if self.stats is not None:
                self.stats.record(
                    provider=provider.name, model=mdl_name,
                    latency_ms=(time.perf_counter() - t0) * 1000.0,
                    error=error, tokens_in=tokens_in, tokens_out=tokens_out,
                )
        content = "".join(content_parts)
        parsed = parse_batch(content, len(texts))
        if len(texts) == 1 and parsed[0] is None and content.strip():
            parsed[0] = content.strip()
        return parsed, resolved_topic, topic_reason
