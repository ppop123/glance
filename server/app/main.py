"""FastAPI entrypoint. Run: uv run uvicorn app.main:app --host 127.0.0.1 --port 8787"""
from __future__ import annotations

import json
import logging
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .cache import Cache
from .config import load_config
from .providers_store import ProvidersStore
from .stats import StatsStore
from .translator import TranslateItem, Translator
from .vtt_cache import VttCache, canonical_url


class Item(BaseModel):
    text: str
    tag: str | None = None
    context: str | None = None   # short hint for disambiguation — ancestor heading, etc.


class TranslateReq(BaseModel):
    items: list[Item]
    target_lang: str | None = None
    model: str | None = None
    site: str | None = None
    topic: str | None = None   # optional override: "social" | "code" | "academic" | "finance" | "news" | "legal" | "medical" | "game"
    glossary: list[tuple[str, str]] | None = None  # [[src, dst], ...] — force specific term mappings


class TranslateResp(BaseModel):
    translations: list[str]
    cache_hits: list[bool]
    model: str
    target: str
    upstream_calls: int
    latency_ms: int
    inferred_topic: str | None = None
    topic_reason: str = "none"


class InvalidateReq(BaseModel):
    bump_glossary: bool = Field(default=False, description="increment glossary_version in memory (next put() miss)")


class ProviderReq(BaseModel):
    name: str
    label: str | None = None
    base_url: str
    api_key: str = ""
    protocol: str = "openai"
    models: list[str] = []
    enabled: bool = True
    timeout_s: int = 60


cfg = load_config()
logging.basicConfig(
    level=cfg.log_level.upper(),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("fanyi")


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.cache = Cache(cfg.cache)
    app.state.stats = StatsStore(cfg.cache.db_path.parent / "provider_stats.sqlite3")
    # User-added providers live in their own JSON sidecar — keys never touch config.yaml.
    app.state.providers_store = ProvidersStore(cfg.cache.db_path.parent / "user_providers.json")
    app.state.translator = Translator(cfg, app.state.cache, app.state.stats, app.state.providers_store)
    app.state.asr_client = httpx.AsyncClient(base_url=cfg.asr.base_url, timeout=cfg.asr.timeout_s) if cfg.asr.enabled else None
    # VTT transcripts live in a separate DB so purging translation cache doesn't nuke expensive ASR output
    vtt_path = cfg.cache.db_path.parent / "vtt.sqlite3"
    app.state.vtt_cache = VttCache(vtt_path, ttl_days=90)
    # Track which canonical URLs have been cached already from a given job_id so we only write once.
    app.state.vtt_job_urls = {}
    log.info("fanyi-server ready on %s:%s (upstream=%s model=%s)", cfg.host, cfg.port, cfg.upstream.base_url, cfg.defaults.model)
    try:
        yield
    finally:
        await app.state.translator.aclose()
        if app.state.asr_client:
            await app.state.asr_client.aclose()


app = FastAPI(title="fanyi-server", version="0.1.0", lifespan=lifespan)

# Extension origins: chrome-extension://<id>/*
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^(chrome-extension|moz-extension)://.*",
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
    max_age=3600,
)


@app.get("/health")
async def health():
    return {"ok": True, "model": cfg.defaults.model, "target": cfg.defaults.target_lang}


@app.post("/translate", response_model=TranslateResp)
async def translate(req: TranslateReq):
    if not req.items:
        raise HTTPException(400, "items required")
    if len(req.items) > 200:
        raise HTTPException(400, "max 200 items per request")
    tr = app.state.translator
    result = await tr.translate(
        [TranslateItem(text=i.text, tag=i.tag, context=i.context) for i in req.items],
        target_lang=req.target_lang,
        model=req.model,
        site=req.site,
        topic=req.topic,
        glossary=req.glossary,
    )
    return TranslateResp(
        translations=result.translations,
        cache_hits=result.cache_hits,
        model=result.model,
        target=result.target,
        upstream_calls=result.upstream_calls,
        latency_ms=result.latency_ms,
        inferred_topic=result.inferred_topic,
        topic_reason=result.topic_reason,
    )


@app.post("/translate/stream")
async def translate_stream(req: TranslateReq):
    """SSE endpoint: pushes each batch of translations as soon as it lands.

    Event format: `data: {"items": [{"i": int, "translation": str, "cached"?: bool, "failed"?: bool}]}`
    Terminal event: `data: [DONE]`. Errors surface as `data: {"error": "..."}` before [DONE].
    """
    if not req.items:
        raise HTTPException(400, "items required")
    if len(req.items) > 2000:
        raise HTTPException(400, "max 2000 items per request")
    tr = app.state.translator

    async def gen():
        try:
            async for chunk in tr.translate_stream(
                [TranslateItem(text=i.text, tag=i.tag, context=i.context) for i in req.items],
                target_lang=req.target_lang,
                model=req.model,
                site=req.site,
                topic=req.topic,
                glossary=req.glossary,
            ):
                yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"
        except Exception as e:
            log.exception("translate_stream failed")
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/cache/stats")
async def cache_stats():
    return app.state.cache.stats()


@app.get("/providers/stats")
async def providers_stats(days: int = 30):
    """Per-provider call stats — latency, success rate, token usage."""
    rows = app.state.stats.aggregate(days=max(1, min(365, days)))
    return {"days": days, "rows": rows}


def _provider_view(p, source: str) -> dict:
    """JSON shape returned to the extension. api_key is NEVER sent — the UI
    just needs to know the provider exists and which models it supplies."""
    return {
        "name": p.name, "label": p.label or p.name,
        "base_url": p.base_url, "protocol": p.protocol,
        "models": list(p.models), "enabled": p.enabled, "timeout_s": p.timeout_s,
        "source": source,        # "config" = from config.yaml (read-only in UI)
                                 # "user"   = from user_providers.json (editable)
        "has_api_key": bool(p.api_key),
    }


@app.get("/providers")
async def list_providers():
    """All providers — those defined in config.yaml AND those added via UI."""
    from_cfg = {p.name for p in cfg.providers}
    out = [_provider_view(p, "config") for p in cfg.providers]
    for p in app.state.providers_store.list():
        if p.name in from_cfg:
            # config wins; don't shadow with a user entry of the same name.
            continue
        out.append(_provider_view(p, "user"))
    return {"providers": out}


@app.post("/providers")
async def upsert_provider(req: ProviderReq):
    """Add / update a user-defined provider. api_key is stored only here
    (user_providers.json, user-readable); never makes it into config.yaml."""
    if not req.name.strip() or ":" in req.name:
        raise HTTPException(400, "provider name must be non-empty and must not contain ':'")
    if cfg.find_provider(req.name) is not None:
        raise HTTPException(400, f"'{req.name}' is reserved by config.yaml — rename or remove it there first")
    try:
        app.state.providers_store.upsert(
            name=req.name, label=req.label or "", base_url=req.base_url,
            api_key=req.api_key, protocol=req.protocol, models=req.models,
            enabled=req.enabled, timeout_s=req.timeout_s,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    await app.state.translator.reload_providers()
    return {"ok": True}


@app.delete("/providers/{name}")
async def delete_provider(name: str):
    if cfg.find_provider(name) is not None:
        raise HTTPException(400, f"'{name}' is defined in config.yaml, not the user store — edit config.yaml directly")
    if not app.state.providers_store.delete(name):
        raise HTTPException(404, f"no user provider named '{name}'")
    await app.state.translator.reload_providers()
    return {"ok": True}


class ListModelsReq(BaseModel):
    base_url: str
    api_key: str = ""
    timeout_s: int = 15


@app.post("/providers/list-models")
async def list_models(req: ListModelsReq):
    """GET {base_url}/models with the user's api_key and return the model ids.
    Used by the options UI's '拉取模型列表' button to auto-populate the models
    field right after the user pastes their key, so they don't have to type
    model IDs by hand."""
    headers = {}
    if req.api_key:
        headers["Authorization"] = f"Bearer {req.api_key}"
    try:
        async with httpx.AsyncClient(base_url=req.base_url.rstrip("/"), timeout=req.timeout_s, headers=headers) as c:
            r = await c.get("/models")
            if r.status_code >= 400:
                return {"ok": False, "error": f"HTTP {r.status_code}: {r.text[:300]}"}
            data = r.json()
    except Exception as e:
        return {"ok": False, "error": str(e)}
    # OpenAI-standard shape: {"data": [{"id": ...}, ...]}. Some providers wrap it
    # differently, so try a few common shapes before giving up.
    items = data.get("data") if isinstance(data, dict) else None
    if not isinstance(items, list):
        items = data.get("models") if isinstance(data, dict) else data
    if not isinstance(items, list):
        return {"ok": False, "error": "unexpected /models response shape"}
    ids: list[str] = []
    for it in items:
        if isinstance(it, str):
            ids.append(it)
        elif isinstance(it, dict):
            mid = it.get("id") or it.get("name")
            if isinstance(mid, str):
                ids.append(mid)
    # Drop obvious non-chat artifacts users won't translate with.
    drop_substrings = ("embedding", "whisper", "tts", "audio", "dall-e", "moderation", "image", "speech", "vision-preview")
    chat_ids = [i for i in ids if not any(s in i.lower() for s in drop_substrings)]
    return {"ok": True, "models": chat_ids, "total": len(ids), "filtered": len(ids) - len(chat_ids)}


@app.post("/providers/test")
async def test_provider(req: ProviderReq):
    """Try a single tiny translation against the given provider config WITHOUT
    saving. Used by the options UI to verify the key + base_url + model before
    the user commits."""
    if not req.models:
        raise HTTPException(400, "need at least one model to test")
    model = req.models[0]
    test_text = "Hello, world."
    import time
    headers = {}
    if req.api_key:
        headers["Authorization"] = f"Bearer {req.api_key}"
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": "You are a translator. Translate to Chinese. Output only the translation."},
            {"role": "user", "content": test_text},
        ],
        "temperature": 0,
        "max_tokens": 32,
        "stream": False,
    }
    t0 = time.perf_counter()
    try:
        async with httpx.AsyncClient(base_url=req.base_url.rstrip("/"), timeout=req.timeout_s, headers=headers) as c:
            r = await c.post("/chat/completions", json=body)
            latency_ms = int((time.perf_counter() - t0) * 1000)
            if r.status_code >= 400:
                return {"ok": False, "error": f"HTTP {r.status_code}: {r.text[:300]}", "latency_ms": latency_ms}
            data = r.json()
            try:
                content = data["choices"][0]["message"]["content"]
            except (KeyError, IndexError, TypeError):
                content = ""
            return {"ok": True, "latency_ms": latency_ms, "sample": f"{test_text} → {content.strip()[:100]}"}
    except Exception as e:
        return {"ok": False, "error": str(e), "latency_ms": int((time.perf_counter() - t0) * 1000)}


@app.post("/cache/invalidate")
async def cache_invalidate(req: InvalidateReq):
    removed = app.state.cache.invalidate_all()
    return {"removed": removed}


@app.get("/config")
async def public_config():
    """Non-sensitive config echoed to extension popup. Providers include BOTH
    config.yaml entries and user-added ones from the persistent store (the
    latter are what the user pastes via the options page)."""
    providers = app.state.translator.all_providers() if app.state.translator else cfg.providers
    return {
        "default_model": cfg.defaults.model,
        "default_target": cfg.defaults.target_lang,
        "batch_size": cfg.defaults.batch_size,
        "asr_enabled": cfg.asr.enabled,
        "providers": [
            {
                "name": p.name,
                "label": p.label or p.name,
                "protocol": p.protocol,
                "models": list(p.models),
                "enabled": p.enabled,
                # api_key is never leaked; the extension only needs to know
                # which provider:model strings are valid.
            }
            for p in providers
            if p.enabled
        ],
    }


@app.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    language: str | None = Form(None),
    task: str = Form("transcribe"),
):
    """Proxy to ASR worker on mac mini. Streams the file through untouched."""
    if not app.state.asr_client:
        raise HTTPException(503, "ASR disabled in config")

    # Read once so we can forward as a fresh multipart body; files are bounded (<10 MB usually).
    data = await file.read()
    files = {"file": (file.filename or "audio.bin", data, file.content_type or "application/octet-stream")}
    form = {"task": task}
    if language:
        form["language"] = language
    try:
        r = await app.state.asr_client.post("/transcribe", files=files, data=form)
    except httpx.RequestError as e:
        raise HTTPException(502, f"asr worker unreachable: {e}")
    if r.status_code != 200:
        raise HTTPException(r.status_code, r.text)
    return r.json()


@app.post("/transcribe-url")
async def transcribe_url(payload: dict):
    if not app.state.asr_client:
        raise HTTPException(503, "ASR disabled in config")
    url = payload.get("url")
    if not url:
        raise HTTPException(400, "url required")
    form = {"url": url, "task": payload.get("task", "transcribe")}
    if payload.get("language"):
        form["language"] = payload["language"]
    try:
        r = await app.state.asr_client.post("/transcribe-url", data=form)
    except httpx.RequestError as e:
        raise HTTPException(502, f"asr worker unreachable: {e}")
    if r.status_code != 200:
        raise HTTPException(r.status_code, r.text)
    return r.json()


# In-memory registry for "cache-hit" jobs served directly by the main server
# without going to the worker. Key is the synthetic job_id we hand out.
_LOCAL_JOBS: dict[str, dict] = {}


def _make_cache_hit_job(url: str, cached: dict) -> str:
    import secrets
    job_id = "cache-" + secrets.token_hex(12)
    _LOCAL_JOBS[job_id] = {
        "id": job_id,
        "source": "cache",
        "url": canonical_url(url),
        "phase": "done",
        "done": True,
        "error": None,
        "duration": cached.get("duration"),
        "title": cached.get("title"),
        "language": cached.get("language"),
        "total_chunks": 1,
        "completed_chunks": 1,
        "cues": cached["cues"],
    }
    return job_id


@app.post("/transcribe-url/start")
async def transcribe_url_start(payload: dict):
    if not app.state.asr_client:
        raise HTTPException(503, "ASR disabled in config")
    url = payload.get("url")
    if not url:
        raise HTTPException(400, "url required")

    # 1) Check VTT cache
    hit = app.state.vtt_cache.get(url)
    if hit and hit["cues"]:
        job_id = _make_cache_hit_job(url, hit)
        return {"job_id": job_id, "cached": True, "cue_count": len(hit["cues"])}

    # 2) Fall through to worker
    body = {k: v for k, v in payload.items() if k in ("url", "language", "task", "chunk_seconds", "initial_chunk_seconds", "initial_chunk_count")}
    try:
        r = await app.state.asr_client.post("/transcribe-url/start", json=body)
    except httpx.RequestError as e:
        raise HTTPException(502, f"asr worker unreachable: {e}")
    if r.status_code != 200:
        raise HTTPException(r.status_code, r.text)
    data = r.json()
    # Remember URL for this real worker job so we can cache when it completes.
    app.state.vtt_job_urls[data["job_id"]] = canonical_url(url)
    return data


@app.get("/transcribe-url/cues")
async def transcribe_url_cues(job_id: str, since: int = 0, polish: bool = True):
    if not app.state.asr_client:
        raise HTTPException(503, "ASR disabled in config")

    # Cache-hit job: serve from our in-memory registry, no worker call.
    local = _LOCAL_JOBS.get(job_id)
    if local:
        tail = local["cues"][since:]
        return {
            "job_id": job_id,
            "phase": local["phase"],
            "done": local["done"],
            "error": local["error"],
            "duration": local["duration"],
            "title": local["title"],
            "language": local["language"],
            "total_chunks": local["total_chunks"],
            "completed_chunks": local["completed_chunks"],
            "next_since": since + len(tail),
            "cues": tail,
            "from_cache": True,
        }

    # Otherwise proxy to worker
    try:
        r = await app.state.asr_client.get("/transcribe-url/cues", params={"job_id": job_id, "since": since})
    except httpx.RequestError as e:
        raise HTTPException(502, f"asr worker unreachable: {e}")
    if r.status_code != 200:
        raise HTTPException(r.status_code, r.text)
    payload = r.json()
    cues = payload.get("cues") or []
    lang = payload.get("language") or "en"
    if polish and cues:
        texts = [c["text"] for c in cues]
        fixed = await app.state.translator.polish(texts, language=lang)
        for c, t in zip(cues, fixed):
            c["text"] = t
        payload["cues"] = cues
        payload["polished"] = True

    # When the job finishes, persist ALL cues to the VTT cache so next call is instant.
    # We need the full set, so on done re-fetch from since=0 if we only have a tail here.
    if payload.get("done") and not payload.get("error"):
        url = app.state.vtt_job_urls.pop(job_id, None)
        if url:
            full_payload = payload
            if since > 0:
                try:
                    rr = await app.state.asr_client.get("/transcribe-url/cues", params={"job_id": job_id, "since": 0})
                    if rr.status_code == 200:
                        fp = rr.json()
                        # Apply polish to the full set so cache stores corrected text
                        full_cues = fp.get("cues") or []
                        if polish and full_cues:
                            texts = [c["text"] for c in full_cues]
                            fixed = await app.state.translator.polish(texts, language=fp.get("language") or "en")
                            for c, t in zip(full_cues, fixed):
                                c["text"] = t
                            fp["cues"] = full_cues
                        full_payload = fp
                except httpx.RequestError:
                    pass
            app.state.vtt_cache.put(
                url,
                cues=full_payload.get("cues") or [],
                duration=full_payload.get("duration"),
                language=full_payload.get("language"),
                title=full_payload.get("title"),
            )
    return payload


@app.get("/transcribe-url/cache/stats")
async def transcribe_url_cache_stats():
    return app.state.vtt_cache.stats()


@app.post("/transcribe-url/cache/invalidate")
async def transcribe_url_cache_invalidate(payload: dict):
    url = payload.get("url")
    removed = app.state.vtt_cache.invalidate(url)
    return {"removed": removed}


@app.post("/transcribe-url/cancel")
async def transcribe_url_cancel(payload: dict):
    if not app.state.asr_client:
        raise HTTPException(503, "ASR disabled in config")
    try:
        r = await app.state.asr_client.post("/transcribe-url/cancel", json=payload)
    except httpx.RequestError as e:
        raise HTTPException(502, f"asr worker unreachable: {e}")
    return r.json() if r.status_code == 200 else {"ok": False}


@app.get("/asr/health")
async def asr_health():
    if not app.state.asr_client:
        return {"ok": False, "reason": "disabled"}
    try:
        r = await app.state.asr_client.get("/health")
        return {"ok": r.status_code == 200, "upstream": r.json() if r.status_code == 200 else None}
    except Exception as e:
        return {"ok": False, "error": str(e)}
