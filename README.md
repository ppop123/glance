# fanyi-ext

Lean web translation extension + local gateway. Borrows the good ideas from Immersive Translate, cuts the weight.

```
Chrome Extension ─┐
                  ├─→ fanyi-server (127.0.0.1:8787) ──→ auth2api / ccpa (127.0.0.1:8317) → Claude
ASR worker ───────┘           │
(Mac mini 192.168.50.8:8788)  └─ SQLite cache
```

## Phase 1 — Web translation (this commit)

### 1. Run the server

```bash
cd server
cp config.example.yaml config.yaml     # only first time; already done
uv sync
uv run uvicorn app.main:app --host 127.0.0.1 --port 8787
```

Make sure auth2api is running on :8317 first (`cd ~/auth2api && node dist/index.js`).

### 2. Load the extension

Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, select `/Users/wy/fanyi-ext/extension/`.

### 3. Use it

- Open [x.com](https://x.com) or [github.com](https://github.com) — it auto-translates (auto-sites default list).
- Any other site: click the toolbar icon → **Toggle**, or press `⌥A`.
- Popup shows server status, cache size, model in use.

## Design notes

- **One server, one upstream, one cache** — no per-service DNR hacks.
- **Site adapters** pick translation units smartly:
  - `xcom.js` → one unit per `article[data-testid=tweet]`, tag = `tweet:<id>` so the same tweet in different timelines hits cache
  - `github.js` → README / issue / PR / comment bodies; tag = `gh:<comment-id>`
  - `generic.js` → fallback — all block-level text
- **Batching**: client chunks 30 units per HTTP call; server's upstream call also batches 30. Two roundtrips typically translate 100 tweets.
- **Cache**: SQLite at `~/.fanyi-ext/cache.sqlite3`. TTL 7 days, LRU evict at 100k entries. Key = `sha256(model|target|glossary_version|text)`; secondary key by `tag`.
- **Dual display** via `<font class="fanyi-translation">` inserted as last child. Removing `data-fanyi-state` on `<html>` instantly hides all.
- **No WASM**, no PII NER, no OCR, no PDF viewer, no 95 service defaults.

## Phase 2 — Video subtitles (planned)

- MLX Whisper (large-v3-turbo, int8) running on the Mac mini at `192.168.50.8:8788`.
- Extension captures `<video>.captureStream()` audio chunks → main server → ASR worker → returns VTT.
- Extension appends a `<track>` element to the video.

## Layout

```
server/           FastAPI + SQLite cache + auth2api client
  app/
    main.py       routes
    translator.py batch+cache pipeline
    cache.py      SQLite cache
    prompts.py    numbered-batch prompt scheme
    config.py     yaml loader
  config.yaml

extension/
  manifest.json   MV3
  src/
    content_guard.js   tiny gate in every frame
    content_main.js    main engine, dynamic-imported
    background.js      SW: commands + install defaults
    popup.html / popup.js
    lib/
      client.js        fetch wrapper
      walker.js        TreeWalker-based unit discovery
    site-adapters/
      xcom.js github.js generic.js
  styles/inject.css
  assets/icon-*.png

asr-worker/       (Phase 2, empty now)
```
