"""FastAPI entrypoint. Run: uv run uvicorn app.main:app --host 127.0.0.1 --port 8787"""
from __future__ import annotations

import json
import logging
from contextlib import asynccontextmanager

import html as _html
import httpx
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, StreamingResponse
from pydantic import BaseModel, Field

from .cache import Cache
from .config import load_config
from .pdf_extract import extract_paragraphs, render_page_pngs, MAX_PAGES_HARD_CAP
from .providers_store import ProvidersStore
from .stats import StatsStore
from .translator import TranslateItem, Translator, UnknownProviderError
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
    # Fail early with a clear message if the client's model string names a
    # provider that isn't configured — avoids a confusing upstream 400.
    try:
        tr.resolve_model(req.model)
    except UnknownProviderError as e:
        raise HTTPException(400, str(e))
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
    try:
        tr.resolve_model(req.model)
    except UnknownProviderError as e:
        raise HTTPException(400, str(e))

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
    # Optional: if set and api_key is empty, fall back to the stored credential
    # for this provider. Lets the inline edit form refresh the model list
    # without making the user paste their key again. Only accepts names that
    # exist in the user store or config; missing → api_key stays empty.
    name: str | None = None


@app.post("/providers/list-models")
async def list_models(req: ListModelsReq):
    """GET {base_url}/models with the user's api_key and return the model ids.
    Used by the options UI's '拉取模型列表' button to auto-populate the models
    field right after the user pastes their key, so they don't have to type
    model IDs by hand."""
    api_key = req.api_key
    if not api_key and req.name:
        # Look up stored credential by provider name. User-store first (what
        # the inline edit typically targets), config.yaml second.
        stored = None
        if app.state.providers_store is not None:
            stored = app.state.providers_store.get(req.name)
        if stored is None:
            stored = cfg.find_provider(req.name)
        if stored is not None:
            api_key = stored.api_key
    headers = {}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
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


def _pdf_head_and_header(src_url: str) -> str:
    """Opening HTML — everything before the first paragraph. Separated from
    the body so the streaming endpoint can emit it immediately, flush, and
    let the browser paint the shell + load MathJax while translation runs."""
    esc = _html.escape
    title = src_url.rsplit("/", 1)[-1] or "PDF"
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>{esc(title)} · 翻译</title>
<script>
  window.MathJax = {{
    loader: {{ load: ['[tex]/textmacros', '[tex]/ams'] }},
    tex: {{
      packages: {{ '[+]': ['textmacros', 'ams'] }},
      inlineMath: [['$', '$'], ['\\\\(', '\\\\)']],
      displayMath: [['$$', '$$'], ['\\\\[', '\\\\]']],
      processEscapes: true,
    }},
    options: {{
      processHtmlClass: 'tr',
      ignoreHtmlClass: 'src',
    }},
  }};
  // Translation-patch helper. Each server-streamed <script>$T(i, 'text')
  // </script> finds the placeholder by id and updates it in-place, then
  // re-typesets math in that node. Swallow MathJax errors so a single bad
  // LaTeX expression doesn't halt the stream.
  window.$T = function(i, tr, failed) {{
    const el = document.getElementById('tr-' + i);
    if (!el) return;
    if (failed) {{
      el.className = 'tr tr-missing';
      el.textContent = '（翻译失败）';
    }} else {{
      el.className = 'tr';
      el.textContent = tr;
      if (window.MathJax && window.MathJax.typesetPromise) {{
        MathJax.typesetPromise([el]).catch(function() {{}});
      }}
    }}
  }};
  window.$S = function(done, total, failed) {{
    const el = document.getElementById('status');
    if (!el) return;
    const parts = ['已完成 ' + done + '/' + total + ' 段'];
    if (failed > 0) parts.push('失败 ' + failed);
    el.textContent = parts.join(' · ');
    if (done >= total) {{
      el.className = failed > 0 ? 'meta status done err' : 'meta status done';
    }}
  }};
  window.$I = function(pageIdx, dataUri) {{
    const f = document.getElementById('fig-' + pageIdx);
    if (!f) return;
    const img = document.createElement('img');
    img.src = dataUri;
    img.alt = '第 ' + pageIdx + ' 页原图';
    f.innerHTML = '';
    f.appendChild(img);
  }};
</script>
<script async src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-chtml.js"></script>
<style>
  :root {{ color-scheme: light dark;
    --bg:#f6f8fa; --card:#fff; --text:#1f2328; --muted:#656d76;
    --border:#d0d7de; --accent:#2d8cf0; --danger:#cf222e; --success:#1a7f37;
  }}
  @media (prefers-color-scheme: dark) {{ :root {{
    --bg:#0d1117; --card:#161b22; --text:#e6edf3; --muted:#8b949e;
    --border:#30363d;
  }} }}
  * {{ box-sizing: border-box }}
  body {{ margin: 0; padding: 24px 20px 60px;
    font: 15px/1.65 -apple-system, "PingFang SC", "Helvetica Neue", sans-serif;
    background: var(--bg); color: var(--text); }}
  .wrap {{ max-width: 820px; margin: 0 auto; }}
  header.top {{ display:flex; align-items:baseline; gap:12px; margin-bottom: 8px; }}
  header.top h1 {{ font-size: 20px; font-weight:700; margin:0; }}
  header.top a {{ font-size: 13px; color: var(--muted); text-decoration: none; }}
  header.top a:hover {{ text-decoration: underline; }}
  .meta {{ color: var(--muted); font-size: 12px; margin: 0 0 18px; }}
  .meta.status {{ position: sticky; top: 6px; background: var(--bg);
    padding: 4px 8px; border-radius: 6px; z-index: 2;
    border: 1px solid var(--border); display: inline-block; }}
  .meta.status.done {{ color: var(--success); border-color: var(--success); }}
  .meta.status.done.err {{ color: var(--danger); border-color: var(--danger); }}
  .err {{ color: var(--danger); background: rgba(207,34,46,.08); padding: 10px 14px; border-radius: 8px; }}
  h2.pg {{ font-size: 12px; font-weight: 600; text-transform: uppercase;
    letter-spacing: .08em; color: var(--muted); margin: 30px 0 8px;
    border-top: 1px solid var(--border); padding-top: 12px; }}
  figure.pdf-page {{ margin: 0 0 14px; border: 1px solid var(--border);
    border-radius: 10px; overflow: hidden; background: #fff;
    box-shadow: 0 1px 3px rgba(0,0,0,.06); }}
  figure.pdf-page img {{ display: block; width: 100%; height: auto; }}
  .para {{ background: var(--card); border: 1px solid var(--border);
    border-radius: 10px; padding: 14px 16px; margin: 0 0 10px; }}
  .src {{ color: var(--muted); font-size: 13.5px; line-height: 1.55; }}
  .tr  {{ margin-top: 6px; font-size: 15.5px; line-height: 1.75;
    font-family: "PingFang SC", "Noto Sans CJK SC", sans-serif; }}
  .tr-missing {{ color: var(--muted); font-style: italic; }}
  .tr-pending {{ color: var(--muted); font-style: italic; opacity: 0.6; }}
  .tr-pending::before {{ content: ''; display: inline-block;
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--accent); margin-right: 6px;
    animation: pulse 1.2s ease-in-out infinite; vertical-align: middle; }}
  @keyframes pulse {{ 0%, 100% {{ opacity: 0.3 }} 50% {{ opacity: 1 }} }}
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <h1>{esc(title)}</h1>
    <a href="{esc(src_url)}" target="_blank" rel="noopener">查看原 PDF ↗</a>
  </header>
"""


def _pdf_footer() -> str:
    return "</div></body></html>"


def _render_pdf_html(
    *, src_url: str, pairs: list[tuple[int, str, str]],
    error: str | None = None, meta: dict | None = None,
    page_images: dict[int, str] | None = None,
) -> str:
    """Whole-page render — used for error responses (no streaming needed)."""
    esc = _html.escape
    body_chunks: list[str] = []
    last_page = -1
    page_images = page_images or {}
    for page, src, tr in pairs:
        if page != last_page:
            body_chunks.append(f'<h2 class="pg">第 {page} 页</h2>')
            img_src = page_images.get(page)
            if img_src:
                body_chunks.append(
                    f'<figure class="pdf-page">'
                    f'<img src="{img_src}" alt="第 {page} 页原图">'
                    f'</figure>'
                )
            last_page = page
        tr_block = (
            f'<div class="tr">{esc(tr)}</div>' if tr else
            '<div class="tr tr-missing">（未翻译）</div>'
        )
        body_chunks.append(
            '<article class="para">'
            f'<div class="src">{esc(src)}</div>{tr_block}'
            '</article>'
        )
    meta = meta or {}
    meta_line = ""
    if meta.get("paragraphs") is not None:
        parts = [f"{meta['paragraphs']} 段"]
        if meta.get("pages_translated") and meta.get("pages_total"):
            parts.append(f"共 {meta['pages_translated']}/{meta['pages_total']} 页")
        if meta.get("elapsed_ms"):
            parts.append(f"耗时 {meta['elapsed_ms']} ms")
        meta_line = f'<p class="meta">{" · ".join(parts)}</p>'
        if meta.get("truncated"):
            from urllib.parse import urlencode
            all_url = "?" + urlencode({"src": meta.get("src_url") or "", "pages": 0})
            meta_line += (
                f'<p class="meta">⚠ 默认只翻译前 10 页控费 · '
                f'<a href="{esc(all_url)}" style="color: var(--accent); text-decoration: none;">'
                f'加载全部 {meta["pages_total"]} 页 ↗</a></p>'
            )
    err_line = f'<p class="err">⚠ {esc(error)}</p>' if error else ""
    return (
        _pdf_head_and_header(src_url)
        + meta_line + err_line
        + "".join(body_chunks)
        + _pdf_footer()
    )


def _js_str(s: str) -> str:
    """JSON-encode a string for safe embedding in a <script> block — also
    escape `</` to `<\\/` to prevent accidental `</script>` injection."""
    return json.dumps(s, ensure_ascii=False).replace("</", "<\\/")


@app.get("/pdf/view", response_class=HTMLResponse)
async def pdf_view(
    src: str,
    target: str | None = None,
    model: str | None = None,
    pages: int | None = None,
):
    """Fetch a PDF by URL, extract paragraphs, translate them, and return
    a self-contained bilingual HTML reader. Intended to be opened in a new
    tab from the extension popup's "翻译 PDF" button.

    Security: only follows `src` URLs that the user's browser could also
    reach (we don't enforce an allowlist — this is a localhost service).
    The worst a malicious `src` can do is waste the user's API quota;
    no credentials are forwarded."""
    import time
    t0 = time.perf_counter()
    if not src or not src.startswith(("http://", "https://")):
        raise HTTPException(400, "src must be an http(s) URL")
    if len(src) > 2000:
        raise HTTPException(400, "src URL too long")

    # Rewrite common blob-viewer URLs to their raw-bytes equivalents. Users
    # often hit these by copying from an address bar:
    #   Hugging Face  /blob/  →  /resolve/   (other path segs unchanged)
    #   GitHub        /blob/  →  /raw/       (user/repo/blob/ref/path → /raw/)
    # If rewritten, we use the new URL for download but keep the original in
    # the viewer header so the "查看原 PDF" link still takes them to the page
    # they expected.
    fetch_src = src
    import re
    if re.match(r"^https?://(?:[\w-]+\.)?huggingface\.co/.+/blob/", src):
        fetch_src = src.replace("/blob/", "/resolve/", 1)
    elif re.match(r"^https?://(?:[\w-]+\.)?github\.com/[^/]+/[^/]+/blob/", src):
        fetch_src = src.replace("/blob/", "/raw/", 1)

    # Everything that could block — PDF download, extraction — happens INSIDE
    # the streaming generator. This means the browser paints the shell + status
    # line within ~100 ms and sees "下载中..." → "解析中..." → actual
    # translations progressively. Before this restructure, TTFB was 20 s on a
    # 5 MB paper because download + extract blocked the response start.
    import asyncio
    import base64
    import re as _re
    esc = _html.escape

    def _blob_rewrite(url: str) -> str:
        """Hugging Face / GitHub blob-viewer URL → raw-bytes URL."""
        if _re.match(r"^https?://(?:[\w-]+\.)?huggingface\.co/.+/blob/", url):
            return url.replace("/blob/", "/resolve/", 1)
        if _re.match(r"^https?://(?:[\w-]+\.)?github\.com/[^/]+/[^/]+/blob/", url):
            return url.replace("/blob/", "/raw/", 1)
        return url

    fetch_src = _blob_rewrite(src)

    async def gen():
        # 1) Shell + status line — emits within milliseconds so the browser
        # paints immediately.
        yield _pdf_head_and_header(src)
        yield '<p class="meta status" id="status">下载 PDF 中…</p>'

        # 2) Download the PDF inside the generator, under the emitted status.
        try:
            async with httpx.AsyncClient(timeout=60, follow_redirects=True) as c:
                r = await c.get(fetch_src)
                r.raise_for_status()
                pdf_bytes = r.content
        except httpx.HTTPError as e:
            yield (
                f'<p class="err">⚠ 下载 PDF 失败：{esc(str(e))}</p>'
                + _pdf_footer()
            )
            return

        # 3) Validate magic.
        head_bytes = pdf_bytes[:1024]
        if b"%PDF-" not in head_bytes:
            hint = ""
            if head_bytes.lstrip().startswith(b"<"):
                if "huggingface.co" in src:
                    hint = " — Hugging Face 页面上要用 /resolve/main/ 而不是 /blob/main/"
                elif "github.com" in src:
                    hint = " — GitHub 页面上要用 raw.githubusercontent.com 或 /raw/ 路径"
                else:
                    hint = " — 地址返回的是 HTML 页面而不是 PDF 字节，很多站点的 /blob/ 只是预览页"
            yield (
                f'<p class="err">⚠ 下载到的不是 PDF 文件（{len(pdf_bytes):,} 字节）{hint}</p>'
                + _pdf_footer()
            )
            return

        if len(pdf_bytes) > 40 * 1024 * 1024:
            yield (
                '<p class="err">⚠ PDF 超过 40 MB 上限，本阅读器暂不处理</p>'
                + _pdf_footer()
            )
            return

        # 4) Update status + extract paragraphs (CPU-bound, in worker thread).
        yield '<script>var s=document.getElementById("status");if(s)s.textContent="解析 PDF 中…";</script>'
        try:
            paras = await asyncio.to_thread(extract_paragraphs, pdf_bytes)
        except Exception as e:
            log.exception("pdf extract failed")
            yield (
                f'<p class="err">⚠ 解析 PDF 失败：{esc(str(e))}</p>'
                + _pdf_footer()
            )
            return

        if not paras:
            yield (
                '<p class="err">⚠ 从该 PDF 中没有抽到可翻译的文本（可能是扫描件 / 纯图片 PDF）。</p>'
                + _pdf_footer()
            )
            return

        # 5) Apply page cap.
        total_pages = max(p.page for p in paras)
        requested = pages if pages is not None else 10
        if requested > 0 and requested < total_pages:
            paras = [p for p in paras if p.page <= requested]
        truncated = requested > 0 and requested < total_pages
        pages_to_render = min(requested, total_pages) if requested > 0 else total_pages

        # 6) Update status with paragraph count.
        status_text = f'准备翻译 {len(paras)} 段（第 1–{pages_to_render}/{total_pages} 页）…'
        yield f'<script>var s=document.getElementById("status");if(s)s.textContent={_js_str(status_text)};</script>'
        if truncated:
            from urllib.parse import urlencode
            all_url = "?" + urlencode({"src": src, "pages": 0})
            yield (
                f'<p class="meta">⚠ 默认只翻译前 {requested} 页控费 · '
                f'<a href="{esc(all_url)}" style="color:var(--accent);text-decoration:none;">'
                f'加载全部 {total_pages} 页 ↗</a></p>'
            )

        # Skeleton: page image placeholders + source + translation placeholders.
        last_page = -1
        for i, p in enumerate(paras):
            if p.page != last_page:
                yield f'<h2 class="pg">第 {p.page} 页</h2>'
                yield f'<figure class="pdf-page" id="fig-{p.page}"></figure>'
                last_page = p.page
            yield (
                f'<article class="para">'
                f'<div class="src">{esc(p.text)}</div>'
                f'<div class="tr tr-pending" id="tr-{i}">翻译中…</div>'
                f'</article>'
            )

        # Now fan out two background tasks feeding a shared queue — raster
        # (CPU-bound thread) and translation (network I/O). Both emit
        # <script> patches that update the placeholders in place. Neither
        # blocks the other.
        queue: asyncio.Queue = asyncio.Queue()
        SENTINEL = object()
        state = {"done": 0, "failed": 0}

        async def do_raster():
            try:
                pngs = await asyncio.to_thread(render_page_pngs, pdf_bytes, max_pages=pages_to_render)
                for page_idx, png in enumerate(pngs, start=1):
                    dataUri = "data:image/png;base64," + base64.b64encode(png).decode("ascii")
                    await queue.put(f'<script>$I({page_idx},{_js_str(dataUri)})</script>')
            except Exception as e:
                log.warning("pdf raster failed: %s", e)
            finally:
                await queue.put(SENTINEL)

        async def do_translate():
            try:
                async for chunk in app.state.translator.translate_stream(
                    [TranslateItem(text=p.text) for p in paras],
                    target_lang=target or cfg.defaults.target_lang,
                    model=model,
                    topic="academic",
                ):
                    items = chunk.get("items", []) or []
                    if not items:
                        continue
                    pieces = []
                    for it in items:
                        state["done"] += 1
                        idx = it["i"]
                        if it.get("failed"):
                            state["failed"] += 1
                            pieces.append(f'$T({idx},null,true)')
                        else:
                            pieces.append(f'$T({idx},{_js_str(it.get("translation", ""))})')
                    pieces.append(f'$S({state["done"]},{len(paras)},{state["failed"]})')
                    await queue.put('<script>' + ';'.join(pieces) + '</script>')
            except UnknownProviderError as e:
                await queue.put(
                    f'<script>var s=document.getElementById("status");'
                    f'if(s){{s.textContent={_js_str("⚠ " + str(e))};s.className="meta err";}}</script>'
                )
            except Exception as e:
                log.exception("pdf stream translate failed")
                await queue.put(
                    f'<script>var s=document.getElementById("status");'
                    f'if(s){{s.textContent={_js_str("⚠ 翻译失败：" + str(e))};s.className="meta err";}}</script>'
                )
            finally:
                await queue.put(SENTINEL)

        raster_t = asyncio.create_task(do_raster())
        translate_t = asyncio.create_task(do_translate())
        remaining = 2
        while remaining > 0:
            piece = await queue.get()
            if piece is SENTINEL:
                remaining -= 1
            else:
                yield piece
        # Sweep any exceptions from tasks.
        try:
            await asyncio.gather(raster_t, translate_t)
        except Exception:
            log.exception("pdf task gather")

        yield _pdf_footer()

    return StreamingResponse(
        gen(),
        media_type="text/html; charset=utf-8",
        headers={"Cache-Control": "no-store"},
    )


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
