"""ASR worker. Accepts an audio file, returns WebVTT cues + plaintext.

Endpoint:
    POST /transcribe  multipart/form-data
        file: audio file (any format ffmpeg can read)
        language: optional BCP-47 hint (e.g., "en", "zh")
        task: "transcribe" (default) | "translate"  (translate -> to English)
    returns: { vtt: "...", cues: [{start, end, text}, ...], language: "en", duration: 12.3 }

Design:
- Single model loaded lazily on first call.
- Process on a thread pool (1 worker) to serialize; large-v3-turbo uses ~2 GB, 8 GB RAM can't run concurrent decodes comfortably.
- Ffmpeg is used only to probe; mlx-whisper itself calls ffmpeg internally to decode to 16k mono f32.
"""
from __future__ import annotations

import asyncio
import logging
import os
import shutil
import subprocess
import tempfile
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

logging.basicConfig(level=os.getenv("LOG", "INFO"))
log = logging.getLogger("asr-worker")

MODEL_PATH = os.getenv("WHISPER_MODEL", "mlx-community/whisper-large-v3-turbo")

# Lazy-loaded; mlx_whisper uses a process-level cache keyed by path_or_hf_repo.
_loaded = False
_load_lock = asyncio.Lock()
_worker_sem = asyncio.Semaphore(1)


async def ensure_model() -> None:
    global _loaded
    if _loaded:
        return
    async with _load_lock:
        if _loaded:
            return
        import mlx_whisper  # noqa: F401  (import warms up; actual load happens on first transcribe)
        _loaded = True
        log.info("mlx_whisper import warm; model=%s (load on first transcribe)", MODEL_PATH)


def _fmt_ts(sec: float) -> str:
    sec = max(0.0, sec)
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = sec - h * 3600 - m * 60
    return f"{h:02d}:{m:02d}:{s:06.3f}".replace(".", ".")


def _segments_to_vtt(segments: list[dict]) -> str:
    lines = ["WEBVTT", ""]
    for i, seg in enumerate(segments, 1):
        lines.append(str(i))
        lines.append(f"{_fmt_ts(seg['start'])} --> {_fmt_ts(seg['end'])}")
        lines.append((seg.get("text") or "").strip())
        lines.append("")
    return "\n".join(lines)


def _run_mlx(path: str, language: str | None, task: str) -> dict:
    """Blocking; run in threadpool."""
    from mlx_whisper import transcribe
    opts = {
        "path_or_hf_repo": MODEL_PATH,
        "word_timestamps": False,
        "task": task,
    }
    if language:
        opts["language"] = language
    t0 = time.perf_counter()
    result = transcribe(path, **opts)
    elapsed = time.perf_counter() - t0
    segments = [
        {"start": float(s["start"]), "end": float(s["end"]), "text": s["text"]}
        for s in result.get("segments", [])
    ]
    return {
        "text": result.get("text", "").strip(),
        "language": result.get("language"),
        "duration": result.get("duration"),
        "segments": segments,
        "elapsed_s": elapsed,
    }


app = FastAPI(title="fanyi-asr-worker", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r".*",   # trusted LAN only; bind to 0.0.0.0 deliberately
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    await ensure_model()
    return {"ok": True, "model": MODEL_PATH}


def _yt_dlp_audio(url: str, out_path: str) -> dict:
    """Download best audio-only track. Returns {path, title, duration}."""
    bin_ = shutil.which("yt-dlp") or "/opt/homebrew/bin/yt-dlp"
    cmd = [
        bin_, "-f", "bestaudio",
        "--extract-audio", "--audio-format", "m4a",
        "--no-playlist", "--no-warnings",
        "--print", "after_move:%(title)s|%(duration)s",
        "-o", out_path,
        url,
    ]
    t0 = time.perf_counter()
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    if r.returncode != 0:
        raise HTTPException(502, f"yt-dlp failed: {r.stderr[-400:] or r.stdout[-400:]}")
    meta = r.stdout.strip().splitlines()[-1] if r.stdout.strip() else "|"
    title, _, dur = meta.partition("|")
    return {
        "path": out_path,
        "title": title.strip() or None,
        "duration": float(dur) if dur.strip().replace(".", "").isdigit() else None,
        "download_s": time.perf_counter() - t0,
    }


# ─── Segmented streaming jobs ────────────────────────────────────────────
# In-memory job registry. Client starts a job, then polls for incremental cues.
# Each job:
#   id, created_at, phase, duration, total_chunks, completed_chunks, cues[], done, error
# Phases: queued → downloading → chunking → transcribing → done | error
# Cues list grows monotonically; client polls with `since` index to fetch tail.

JOBS: dict[str, dict] = {}
JOB_TTL_S = 3600


def _gc_jobs() -> None:
    now = time.time()
    stale = [k for k, v in JOBS.items() if (now - v.get("created_at", now)) > JOB_TTL_S]
    for k in stale:
        JOBS.pop(k, None)


def _plan_segments(duration: float, initial_short: int = 10, short_count: int = 6, long_seg: int = 60) -> list[float]:
    """Generate a list of segment START times (offsets in seconds).
    First `short_count * initial_short` seconds are split into `initial_short`-second pieces
    so the very first caption arrives ~1 short-segment into the job. Everything after uses `long_seg`.
    Always starts at 0. Duration rounded up so the last piece isn't lost.
    """
    if duration <= 0:
        return [0.0]
    starts = [0.0]
    offset = 0.0
    for _ in range(short_count):
        offset += initial_short
        if offset >= duration: break
        starts.append(float(offset))
    while offset < duration:
        offset += long_seg
        if offset >= duration: break
        starts.append(float(offset))
    return starts


def _split_audio(src: str, out_dir: str, starts: list[float]) -> list[tuple[str, float]]:
    """Split `src` into pieces whose start-offsets match `starts`.
    Returns list of (path, offset_seconds) sorted by offset."""
    os.makedirs(out_dir, exist_ok=True)
    pattern = os.path.join(out_dir, "seg_%04d.m4a")
    cmd = [
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
        "-i", src,
        "-f", "segment",
        "-c", "copy",
        "-reset_timestamps", "1",
    ]
    # ffmpeg's -segment_times cuts at the given absolute times (excludes 0).
    if len(starts) > 1:
        cuts = ",".join(f"{s:.3f}" for s in starts[1:])
        cmd += ["-segment_times", cuts]
    else:
        # single segment = whole file; use a huge -segment_time
        cmd += ["-segment_time", "86400"]
    cmd += [pattern]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    if r.returncode != 0:
        raise RuntimeError(f"ffmpeg split failed: {r.stderr[-400:]}")
    files = sorted(f for f in os.listdir(out_dir) if f.startswith("seg_"))
    if len(files) != len(starts):
        # Fall back: pad or truncate — we trust ffmpeg's output count.
        log.warning("segment count mismatch: planned=%d produced=%d", len(starts), len(files))
    out: list[tuple[str, float]] = []
    for i, fname in enumerate(files):
        offset = starts[i] if i < len(starts) else starts[-1] + (i - len(starts) + 1) * 60
        out.append((os.path.join(out_dir, fname), offset))
    return out


def _probe_duration(path: str) -> float | None:
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
            capture_output=True, text=True, timeout=15,
        )
        return float(r.stdout.strip()) if r.stdout.strip() else None
    except Exception:
        return None


class StartJobReq(BaseModel):
    url: str
    language: str | None = None
    task: str = "transcribe"
    chunk_seconds: int = 60          # back-compat; used as the "long_seg" in adaptive plan
    initial_chunk_seconds: int = 10  # smaller chunks at the start for fast first-cue
    initial_chunk_count: int = 6     # number of small chunks before switching to chunk_seconds


async def _run_job(job_id: str, req: StartJobReq) -> None:
    state = JOBS[job_id]
    try:
        await ensure_model()
        with tempfile.TemporaryDirectory() as td:
            tmpl = os.path.join(td, "audio.%(ext)s")
            state["phase"] = "downloading"
            meta = await asyncio.to_thread(_yt_dlp_audio, req.url, tmpl)
            state["title"] = meta["title"]
            files = [f for f in os.listdir(td) if f.startswith("audio.")]
            if not files:
                raise RuntimeError("yt-dlp produced no output file")
            audio_path = os.path.join(td, files[0])
            duration = meta.get("duration") or _probe_duration(audio_path)
            state["duration"] = duration

            state["phase"] = "chunking"
            chunks_dir = os.path.join(td, "chunks")
            if not duration or duration <= 0:
                duration = 86400  # unknown duration; will still produce correct chunks
            starts = _plan_segments(
                duration,
                initial_short=req.initial_chunk_seconds,
                short_count=req.initial_chunk_count,
                long_seg=req.chunk_seconds,
            )
            chunks = await asyncio.to_thread(_split_audio, audio_path, chunks_dir, starts)
            state["total_chunks"] = len(chunks)

            state["phase"] = "transcribing"
            for i, (chunk_path, offset) in enumerate(chunks):
                if state.get("cancelled"):
                    break
                async with _worker_sem:
                    result = await asyncio.to_thread(_run_mlx, chunk_path, req.language, req.task)
                segs = result.get("segments") or []
                shifted = [
                    {"start": float(s["start"]) + offset,
                     "end": float(s["end"]) + offset,
                     "text": (s.get("text") or "").strip()}
                    for s in segs
                ]
                state["cues"].extend(shifted)
                state["completed_chunks"] = i + 1
                if i == 0:
                    state["language"] = result.get("language")
            state["phase"] = "done"
            state["done"] = True
    except Exception as e:
        log.exception("job %s failed", job_id)
        state["error"] = str(e)
        state["phase"] = "error"
        state["done"] = True


@app.post("/transcribe-url/start")
async def transcribe_url_start(req: StartJobReq):
    _gc_jobs()
    job_id = uuid.uuid4().hex
    JOBS[job_id] = {
        "id": job_id,
        "created_at": time.time(),
        "phase": "queued",
        "duration": None,
        "title": None,
        "language": None,
        "total_chunks": 0,
        "completed_chunks": 0,
        "cues": [],
        "done": False,
        "error": None,
        "cancelled": False,
    }
    asyncio.create_task(_run_job(job_id, req))
    return {"job_id": job_id}


@app.get("/transcribe-url/cues")
async def transcribe_url_cues(job_id: str, since: int = 0):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "unknown job")
    tail = job["cues"][since:]
    return {
        "job_id": job_id,
        "phase": job["phase"],
        "done": job["done"],
        "error": job["error"],
        "duration": job["duration"],
        "title": job["title"],
        "language": job["language"],
        "total_chunks": job["total_chunks"],
        "completed_chunks": job["completed_chunks"],
        "next_since": since + len(tail),
        "cues": tail,
    }


@app.post("/transcribe-url/cancel")
async def transcribe_url_cancel(payload: dict):
    job = JOBS.get(payload.get("job_id", ""))
    if job:
        job["cancelled"] = True
    return {"ok": True}


@app.post("/transcribe-url")
async def transcribe_url_endpoint(
    url: str = Form(...),
    language: str | None = Form(None),
    task: str = Form("transcribe"),
):
    """Download audio with yt-dlp, then transcribe. Much faster than live capture."""
    if task not in ("transcribe", "translate"):
        raise HTTPException(400, "task must be 'transcribe' or 'translate'")
    await ensure_model()

    with tempfile.TemporaryDirectory() as td:
        tmpl = os.path.join(td, "audio.%(ext)s")
        meta = await asyncio.to_thread(_yt_dlp_audio, url, tmpl)
        # yt-dlp prints template, then produces the actual file with its extension
        files = [f for f in os.listdir(td) if f.startswith("audio.")]
        if not files:
            raise HTTPException(502, "yt-dlp produced no output file")
        audio_path = os.path.join(td, files[0])

        async with _worker_sem:
            result = await asyncio.to_thread(_run_mlx, audio_path, language, task)

    vtt = _segments_to_vtt(result["segments"])
    cues = [
        {"start": s["start"], "end": s["end"], "text": s["text"].strip()}
        for s in result["segments"]
    ]
    return {
        "vtt": vtt,
        "cues": cues,
        "language": result["language"],
        "duration": result["duration"] or meta["duration"],
        "elapsed_s": result["elapsed_s"],
        "download_s": meta["download_s"],
        "text": result["text"],
        "title": meta["title"],
        "source_url": url,
    }


@app.post("/transcribe")
async def transcribe_endpoint(
    file: UploadFile = File(...),
    language: str | None = Form(None),
    task: str = Form("transcribe"),
):
    if task not in ("transcribe", "translate"):
        raise HTTPException(400, "task must be 'transcribe' or 'translate'")
    await ensure_model()

    suffix = Path(file.filename or "audio").suffix or ".bin"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        while chunk := await file.read(1 << 20):
            tmp.write(chunk)
        tmp_path = tmp.name

    try:
        async with _worker_sem:
            result = await asyncio.to_thread(_run_mlx, tmp_path, language, task)
    finally:
        try: os.unlink(tmp_path)
        except OSError: pass

    vtt = _segments_to_vtt(result["segments"])
    cues = [
        {"start": s["start"], "end": s["end"], "text": s["text"].strip()}
        for s in result["segments"]
    ]
    return {
        "vtt": vtt,
        "cues": cues,
        "language": result["language"],
        "duration": result["duration"],
        "elapsed_s": result["elapsed_s"],
        "text": result["text"],
    }
