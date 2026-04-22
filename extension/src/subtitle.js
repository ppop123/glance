// Video subtitle overlay: capture audio from <video>, send to /transcribe, attach VTT as a <track>.
//
// Two modes:
//   - "full": record the entire video's audio from element.captureStream() for up to N minutes,
//             then upload once → get VTT → overlay as a TextTrack.
//   - "live": record in 15s chunks with 2s overlap; upload each chunk; append cues to a TextTrack as they arrive.
//             Latency ~ chunk_seconds + whisper_inference_time.
//
// Current implementation: "full" mode only (simpler, robust). Live mode is a natural next iteration.
//
// Limitations:
//   - `video.captureStream()` fails on DRM-protected media (Netflix, Apple TV+). YouTube is fine.
//   - Browser must have captured the full playback range; a just-loaded video only has "buffered" data.
//     For a one-shot transcription we advise the user to let the video play once, or we advance its
//     currentTime programmatically (potentially detectable by site as "user skipped").

const HELP_TEXT = "请确保视频已播放过一次以便音频缓冲完毕。";

/* ──────── Toast overlay (anchored to the video element) ────────
 * Shows recording progress bar, phase label, and a close button. */
function mountToast(video) {
  // Ensure a positioning container. Many video elements are already abs/fixed positioned,
  // so we attach the toast to document.body and align it to the video rect on each frame.
  let host = document.querySelector("#fanyi-sub-toast");
  if (!host) {
    host = document.createElement("div");
    host.id = "fanyi-sub-toast";
    host.setAttribute("data-fanyi-skip", "1");
    host.innerHTML = `
      <div class="box">
        <div class="row1">
          <span class="label">翻译 · 准备中</span>
          <span class="close" title="关闭">×</span>
        </div>
        <div class="bar"><div class="fill"></div></div>
        <div class="hint"></div>
      </div>
    `;
    Object.assign(host.style, {
      position: "fixed", zIndex: "2147483646",
      pointerEvents: "none",
      font: "12px/1.4 -apple-system, system-ui, sans-serif",
    });
    host.querySelector(".box").style.cssText = `
      pointer-events: auto;
      background: rgba(17, 24, 39, .94); color: #fff;
      padding: 10px 12px; border-radius: 10px; min-width: 240px;
      box-shadow: 0 4px 16px rgba(0,0,0,.3), 0 0 0 1px rgba(255,255,255,.06);
      backdrop-filter: blur(6px);
    `;
    host.querySelector(".row1").style.cssText = "display:flex;justify-content:space-between;align-items:center;gap:8px;";
    host.querySelector(".label").style.cssText = "font-weight:600;letter-spacing:.2px;";
    host.querySelector(".close").style.cssText = "cursor:pointer;opacity:.6;user-select:none;font-size:14px;line-height:1;";
    host.querySelector(".bar").style.cssText = "margin-top:8px;height:4px;background:rgba(255,255,255,.15);border-radius:2px;overflow:hidden;";
    host.querySelector(".fill").style.cssText = "height:100%;width:0;background:linear-gradient(90deg,#3b82f6,#8b5cf6);transition:width .2s;";
    host.querySelector(".hint").style.cssText = "margin-top:6px;opacity:.7;font-size:11px;max-width:280px;";
    document.body.appendChild(host);
    host.querySelector(".close").addEventListener("click", () => host.remove());
  }
  // Position it at the video's top-right, falling back to screen top-right
  const align = () => {
    if (!host.isConnected) return;
    const r = video?.getBoundingClientRect?.();
    if (r && r.width > 10 && r.height > 10) {
      host.style.top = Math.max(8, r.top + 8) + "px";
      host.style.left = Math.max(8, r.right - 260) + "px";
    } else {
      host.style.top = "16px";
      host.style.right = "16px";
      host.style.left = "";
    }
  };
  align();
  const onResize = () => align();
  window.addEventListener("resize", onResize);
  window.addEventListener("scroll", onResize, true);
  return {
    set(phase, pct, hint) {
      if (!host.isConnected) return;
      host.querySelector(".label").textContent = "翻译 · " + phase;
      if (typeof pct === "number") host.querySelector(".fill").style.width = Math.max(0, Math.min(100, pct)) + "%";
      if (hint != null) host.querySelector(".hint").textContent = hint;
      align();
    },
    done(summary) {
      host.querySelector(".label").textContent = "翻译 · 完成";
      host.querySelector(".fill").style.width = "100%";
      host.querySelector(".fill").style.background = "#10b981";
      host.querySelector(".hint").textContent = summary || "";
      setTimeout(() => host.remove(), 3500);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
    },
    fail(err) {
      host.querySelector(".label").textContent = "翻译 · 失败";
      host.querySelector(".fill").style.background = "#ef4444";
      host.querySelector(".hint").textContent = String(err).slice(0, 120);
      setTimeout(() => host.remove(), 6000);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
    },
  };
}

function serverBase() {
  // Read from storage, fallback default
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.get({ serverUrl: "http://127.0.0.1:8787" }, (v) => resolve(v.serverUrl || "http://127.0.0.1:8787"));
    } catch { resolve("http://127.0.0.1:8787"); }
  });
}

/** Pick the "primary" <video> on the page — largest visible one that has actual src. */
export function pickPrimaryVideo() {
  const all = Array.from(document.querySelectorAll("video"));
  const candidates = all
    .map((v) => {
      const r = v.getBoundingClientRect();
      return { v, area: Math.max(0, r.width) * Math.max(0, r.height), r };
    })
    .filter(({ v, area }) => area > 200 && (v.currentSrc || v.src));
  candidates.sort((a, b) => b.area - a.area);
  return candidates[0]?.v || null;
}

/** Record the video's current audio via captureStream for up to maxMs. Resolves with a Blob. */
async function recordAudio(video, maxMs, onProgress = () => {}) {
  if (typeof video.captureStream !== "function") {
    throw new Error("video.captureStream() not available — likely DRM-protected media");
  }
  const stream = video.captureStream();
  const audioTracks = stream.getAudioTracks();
  if (!audioTracks.length) throw new Error("video has no audio track (or browser blocked capture)");
  const audioStream = new MediaStream(audioTracks);

  // Opus in webm is universally supported by MediaRecorder and ffmpeg-readable by the worker.
  const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : "audio/webm";
  const rec = new MediaRecorder(audioStream, { mimeType: mime, audioBitsPerSecond: 96_000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const done = new Promise((resolve) => { rec.onstop = () => resolve(); });

  rec.start(1000);
  const started = Date.now();
  const heartbeat = setInterval(() => {
    const s = (Date.now() - started) / 1000;
    onProgress({ seconds: s });
    if (s * 1000 >= maxMs) { try { rec.stop(); } catch {} }
  }, 500);
  await done;
  clearInterval(heartbeat);
  audioStream.getTracks().forEach((t) => t.stop());
  return new Blob(chunks, { type: mime });
}

async function uploadForTranscription(blob, { language = null } = {}) {
  // For binary uploads we CAN'T trivially relay through sendMessage (message size limits on some Chrome versions).
  // But from an http target, the content script CAN fetch if the page is HTTP too, or via a blob:
  // Strategy: send the ArrayBuffer via sendMessage to background; background does the multipart upload.
  const buf = await blob.arrayBuffer();
  const base = await serverBase();
  const resp = await chrome.runtime.sendMessage({
    type: "fanyi:upload-audio",
    url: `${base}/transcribe`,
    language, mime: blob.type || "audio/webm", size: buf.byteLength,
    data: Array.from(new Uint8Array(buf)), // JSON-safe; ok for <10 MB clips
  });
  if (!resp?.ok) throw new Error(resp?.error || "upload failed");
  return resp.data; // { vtt, cues, language, duration, elapsed_s }
}

/** Attach cues to the video via a programmatic TextTrack; returns the track. */
export function attachCues(video, cues, { label = "fanyi" } = {}) {
  // Remove any prior fanyi tracks first
  for (let i = video.textTracks.length - 1; i >= 0; i--) {
    const t = video.textTracks[i];
    if (t.label === label) {
      t.mode = "disabled";
    }
  }
  const track = video.addTextTrack("subtitles", label, "zh");
  track.mode = "showing";
  for (const c of cues) {
    try {
      const cue = new VTTCue(c.start, c.end, c.text);
      cue.snapToLines = false;
      cue.line = 80;
      cue.lineAlign = "center";
      cue.align = "center";
      track.addCue(cue);
    } catch (e) { /* malformed cue — skip */ }
  }
  return track;
}

/** Download-based flow: ask server to pull audio with yt-dlp and transcribe it.
 * Works whenever yt-dlp knows the URL (YouTube, bilibili, vimeo, etc.).
 * Much faster than live recording (no wall-clock wait). */
async function transcribeViaUrl(url, { language = null } = {}) {
  const base = await serverBase();
  const resp = await chrome.runtime.sendMessage({
    type: "fanyi:fetch",
    url: `${base}/transcribe-url`,
    method: "POST",
    body: { url, language, task: "transcribe" },
  });
  if (!resp?.ok) throw new Error(resp?.error || "transcribe-url failed");
  return resp.data;
}

/** Streaming flow: server splits audio into chunks and we poll for incremental cues.
 * Attaches cues to the provided video's TextTrack as soon as each chunk finishes.
 * Returns a controller with { cancel(), promise }. */
async function transcribeViaUrlStreaming(video, url, { language = null, onProgress = null, translate = false, targetLang = null } = {}) {
  const base = await serverBase();

  // Start job
  const start = await chrome.runtime.sendMessage({
    type: "fanyi:fetch",
    url: `${base}/transcribe-url/start`,
    method: "POST",
    body: { url, language, task: "transcribe" },
  });
  if (!start?.ok) throw new Error(start?.error || "start failed");
  const jobId = start.data.job_id;

  // Prepare a live TextTrack immediately so cues show up as they arrive.
  // Reuse an existing fanyi track if present (keeps re-runs idempotent).
  let track = Array.from(video.textTracks).find(t => t.label === "fanyi");
  if (!track) track = video.addTextTrack("subtitles", "fanyi", "zh");
  track.mode = "showing";
  // Periodically re-assert mode — some players flip it to disabled.
  const modeGuard = setInterval(() => { if (track.mode !== "showing") track.mode = "showing"; }, 1500);

  let since = 0;
  let cancelled = false;
  const poll = async () => {
    while (!cancelled) {
      const r = await chrome.runtime.sendMessage({
        type: "fanyi:fetch",
        url: `${base}/transcribe-url/cues?job_id=${jobId}&since=${since}`,
        method: "GET",
      });
      if (!r?.ok) throw new Error(r?.error || "poll failed");
      const d = r.data;

      // Process any new cues
      let newCues = d.cues || [];
      if (translate && targetLang && newCues.length) {
        // Run through /translate to produce bilingual text
        const tr = await chrome.runtime.sendMessage({
          type: "fanyi:fetch",
          url: `${base}/translate`,
          method: "POST",
          body: { items: newCues.map(c => ({ text: c.text })), target_lang: targetLang, site: location.hostname },
        });
        if (tr?.ok) {
          // For video captions: replace the source with the translation.
          // (The user can already hear the original; mixing both in one cue is noisy
          // because many players flatten \n to a space.)
          newCues = newCues.map((c, i) => {
            const t = tr.data.translations[i];
            if (!t || t.trim() === c.text.trim()) return c;   // same-language → keep as is
            return { ...c, text: t };
          });
        }
      }
      // Keep track active — some players disable newly-added tracks by default.
      if (track.mode !== "showing") track.mode = "showing";
      for (const c of newCues) {
        try {
          const cue = new VTTCue(c.start, c.end, c.text);
          // Move caption higher than the default bottom line — less likely to overlap
          // native player controls and video watermarks.
          cue.snapToLines = false;
          cue.line = 80;        // 80% from top
          cue.lineAlign = "center";
          cue.align = "center";
          track.addCue(cue);
        } catch (e) { console.warn("[fanyi sub] addCue failed:", e); }
      }
      // Re-assert after adds in case the player toggled it off again.
      if (track.mode !== "showing") track.mode = "showing";
      since = d.next_since;
      onProgress?.({
        phase: d.phase,
        completed: d.completed_chunks,
        total: d.total_chunks,
        duration: d.duration,
        cuesSoFar: since,
        title: d.title,
      });
      if (d.done) {
        clearInterval(modeGuard);
        if (d.error) throw new Error(d.error);
        return { track, cuesCount: since };
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    clearInterval(modeGuard);
    return { track, cuesCount: since, cancelled: true };
  };

  const promise = poll();
  return {
    promise,
    cancel: async () => {
      cancelled = true;
      try {
        await chrome.runtime.sendMessage({
          type: "fanyi:fetch",
          url: `${base}/transcribe-url/cancel`,
          method: "POST",
          body: { job_id: jobId },
        });
      } catch {}
    },
    jobId,
  };
}

/** Try to use the video's existing native TextTrack (YouTube CC, etc.) instead of ASR.
 * Returns {track, count} or null if no usable track is found.
 *
 * Reason this matters: YouTube / Netflix / Vimeo / Bilibili all ship real captions
 * for most content. Running Whisper over audio we already have perfect captions for
 * is wasted compute AND strictly worse quality.
 *
 * Most players load cue data lazily — setting mode to "hidden" is enough to force
 * it for HLS/DASH-loaded VTT; for YouTube the user must have clicked CC once.
 */
async function tryNativeCaptions(video, { translate, targetLang, status }) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const candidates = () =>
    Array.from(video.textTracks || []).filter(
      (t) =>
        t.label !== "fanyi" &&
        (t.kind === "subtitles" || t.kind === "captions")
    );

  // Nudge all candidate tracks to "hidden" so the player loads cues. Takes effect
  // within a frame or two on most players.
  for (const t of candidates()) {
    if (t.mode === "disabled") t.mode = "hidden";
  }

  let picked = null;
  for (let i = 0; i < 10; i++) {
    picked = candidates().find((t) => t.cues && t.cues.length > 0);
    if (picked) break;
    await sleep(120);
  }
  if (!picked) return null;

  status({ phase: "native-captions", source: picked.language || picked.label });
  const rawCues = Array.from(picked.cues).map((c) => ({
    start: c.startTime,
    end: c.endTime,
    text: c.text || "",
  }));
  if (!rawCues.length) return null;

  let finalCues = rawCues;
  if (translate && targetLang) {
    status({ phase: "translating", total: rawCues.length });
    const base = await serverBase();
    const resp = await chrome.runtime.sendMessage({
      type: "fanyi:fetch",
      url: `${base}/translate`,
      method: "POST",
      body: {
        items: rawCues.map((c) => ({ text: c.text })),
        target_lang: targetLang,
      },
    });
    if (resp?.ok && Array.isArray(resp.data?.translations)) {
      finalCues = rawCues.map((c, i) => ({
        ...c,
        text: resp.data.translations[i] || c.text,
      }));
    }
  }

  // Hide the native track so only our "fanyi" track shows (avoid duplicate captions)
  picked.mode = "disabled";

  status({ phase: "attaching", cues: finalCues.length });
  const track = attachCues(video, finalCues, { label: "fanyi" });
  status({ phase: "done", cues: finalCues.length, source: "native" });
  return { track, count: finalCues.length };
}

function canDownload(url) {
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    return (
      /(^|\.)(youtube\.com|youtu\.be|bilibili\.com|vimeo\.com|twitch\.tv|ted\.com|dailymotion\.com|x\.com|twitter\.com)$/.test(h)
      || u.pathname.endsWith(".mp4") || u.pathname.endsWith(".m4a") || u.pathname.endsWith(".webm")
    );
  } catch { return false; }
}

/**
 * Entry: record → upload → overlay.
 * @param {HTMLVideoElement} video
 * @param {object} opts { maxSeconds, language, translate }
 * @param {(status:object)=>void} onStatus
 */
export async function transcribeVideo(video, opts = {}, onStatusArg = null) {
  const {
    maxSeconds = 120,
    language = null,
    translate = false,
    targetLang = null,
    showToast = true,
    preferDownload = true,
    sourceUrl = null,
    onStatus: onStatusOpt = null,
  } = opts;
  // Accept onStatus either via opts.onStatus (preferred) or as the 3rd positional arg.
  const onStatus = onStatusOpt || onStatusArg || (() => {});

  const toast = showToast ? mountToast(video) : null;
  const status = (obj) => { onStatus(obj); if (toast) applyToast(toast, obj, maxSeconds); };

  try {
    // Fast path: video already has a native caption/subtitle track (YouTube CC,
    // Bilibili CC, Vimeo captions). Use its cues directly — zero Whisper cost,
    // way better accuracy than ASR, and ~instant.
    const native = await tryNativeCaptions(video, { translate, targetLang, status });
    if (native) {
      if (toast) toast.done(`${native.count} 条原生字幕`);
      return { track: native.track, cues: [] };
    }

    const fetchUrl = sourceUrl || location.href;

    // Streaming path: for yt-dlp-supported URLs, attach cues as segments complete.
    if (preferDownload && canDownload(fetchUrl)) {
      status({ phase: "starting" });
      const ctrl = await transcribeViaUrlStreaming(video, fetchUrl, {
        language, translate, targetLang,
        onProgress: (p) => status({ phase: p.phase, completed: p.completed, total: p.total }),
      });
      const result = await ctrl.promise;
      status({ phase: "done", cues: result.cuesCount });
      if (toast) toast.done(`${result.cuesCount} 条字幕已挂载`);
      return { track: result.track, cues: [] };
    }

    // Live-recording fallback (DRM / non-yt-dlp sites)
    status({ phase: "recording", seconds: 0, help: HELP_TEXT });
    const blob = await recordAudio(video, maxSeconds * 1000, (p) => status({ phase: "recording", ...p }));
    status({ phase: "uploading", bytes: blob.size });
    const res = await uploadForTranscription(blob, { language });

    let cues = res.cues;
    if (translate && targetLang) {
      status({ phase: "translating", cues: cues.length });
      const base = await serverBase();
      const resp = await chrome.runtime.sendMessage({
        type: "fanyi:fetch",
        url: `${base}/translate`,
        method: "POST",
        body: { items: cues.map((c) => ({ text: c.text })), target_lang: targetLang },
      });
      if (resp?.ok) {
        cues = cues.map((c, i) => ({
          ...c,
          text: resp.data.translations[i]
            ? `${c.text}\n${resp.data.translations[i]}`   // bilingual: src + translation
            : c.text,
        }));
      }
    }

    status({ phase: "attaching", cues: cues.length });
    const track = attachCues(video, cues, { label: "fanyi" });
    status({ phase: "done", cues: cues.length, language: res.language, elapsed_s: res.elapsed_s });
    if (toast) toast.done(`${cues.length} 条字幕 · ${res.language || "?"} · ASR 耗时 ${(res.elapsed_s || 0).toFixed(1)}s`);
    return { track, cues };
  } catch (e) {
    if (toast) toast.fail(e?.message || e);
    throw e;
  }
}

function applyToast(toast, s, maxSeconds) {
  // Streaming-mode phases — keep UI quiet; don't advertise download steps.
  if (s.phase === "starting" || s.phase === "queued" || s.phase === "downloading" || s.phase === "chunking") {
    toast.set("准备中", null, "服务器正在准备音频…");
  } else if (s.phase === "transcribing") {
    const pct = s.total ? (s.completed || 0) / s.total * 100 : null;
    toast.set("识别中", pct, `${s.completed || 0} / ${s.total || "?"} 段完成`);
  } else if (s.phase === "recording") {
    const pct = maxSeconds ? (s.seconds || 0) / maxSeconds * 100 : null;
    toast.set("录制中", pct, `${(s.seconds || 0).toFixed(1)} / ${maxSeconds} 秒 — 请保持标签页在前台`);
  } else if (s.phase === "uploading") {
    toast.set("上传中", 100, `${Math.round((s.bytes || 0) / 1024)} KB`);
  } else if (s.phase === "translating") {
    toast.set("翻译中", 100, `${s.cues || 0} 条字幕`);
  } else if (s.phase === "attaching") {
    toast.set("附加字幕", 100, `${s.cues || 0} 条`);
  }
}
