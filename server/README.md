# fanyi-server

Local translation gateway. Extension → this server → auth2api (ccpa).

## Run

```bash
cd /Users/wy/fanyi-ext/server
cp config.example.yaml config.yaml      # first time only
uv sync
uv run uvicorn app.main:app --host 127.0.0.1 --port 8787
```

## API

- `POST /translate` — batch translate `{items:[{text, tag?}], target_lang?, model?, site?}`
- `GET /cache/stats`
- `POST /cache/invalidate`
- `GET /health`, `GET /config`
