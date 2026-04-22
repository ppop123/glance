// Main translation engine. Exported: boot(), toggle(), enable(), disable(), retranslate().
// Loaded via dynamic import from content_guard.js.

import { translateStream } from "./lib/client.js";
import { appendTranslation, markUnit, removeAllTranslations, sameLanguageAs, isStale, clearUnit, MARK_ATTR } from "./lib/walker.js";
import { pickPrimaryVideo, transcribeVideo } from "./subtitle.js";

const DEFAULT_AUTO_SITES = ["x.com", "twitter.com", "github.com"];
const DEFAULT_TARGET = "zh-CN";

let state = {
  enabled: false,
  site: null,
  adapter: null,
  disposeObserver: null,
  inflight: new Map(),   // id -> AbortController
  stylesInjected: false,
  target: DEFAULT_TARGET,
  model: null,           // null → server default
};

// ---- Style injection --------------------------------------------------------

function ensureStyles() {
  if (state.stylesInjected) return;
  state.stylesInjected = true;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = chrome.runtime.getURL("styles/inject.css");
  link.setAttribute("data-fanyi-style", "1");
  document.documentElement.appendChild(link);
}

// ---- Adapter selection ------------------------------------------------------

async function pickAdapter() {
  const url = chrome.runtime.getURL.bind(chrome.runtime);
  const candidates = ["xcom", "github", "generic"];
  for (const name of candidates) {
    const mod = await import(url(`src/site-adapters/${name}.js`));
    if (mod.match && mod.match()) return mod;
  }
  throw new Error("no adapter matched (should never happen; generic matches all)");
}

// ---- Translation pipeline ---------------------------------------------------

const FAIL_ATTR = "data-fanyi-fail";
const MAX_FAILS = 3;

/** Bump per-element fail count; return true iff we should allow another retry. */
function markFailure(el) {
  const n = (parseInt(el.getAttribute(FAIL_ATTR) || "0", 10) || 0) + 1;
  el.setAttribute(FAIL_ATTR, String(n));
  return n < MAX_FAILS;
}

/* ── Global progress pill ─────────────────────────────────────────────────
 * One floating status badge, bottom-right. Replaces the per-unit spinners that
 * turned dense pages (Wikipedia ~600 units) into visual noise. Click to cancel. */
let pillTotal = 0;
let pillDone = 0;
let pillEl = null;
let pillHideTimer = null;

function pillEnsure() {
  if (pillEl) return;
  pillEl = document.createElement("div");
  pillEl.className = "fanyi-progress";
  pillEl.setAttribute("data-fanyi-skip", "1");
  pillEl.setAttribute("data-fanyi-wrapper", "1");
  pillEl.setAttribute("role", "status");
  pillEl.setAttribute("aria-live", "polite");
  pillEl.title = "点击取消翻译";
  pillEl.innerHTML = `<span class="fanyi-progress-spin"></span><span class="fanyi-progress-text">翻译中</span>`;
  pillEl.addEventListener("click", () => disable());
  document.documentElement.appendChild(pillEl);
  if (pillHideTimer) { clearTimeout(pillHideTimer); pillHideTimer = null; }
}

function pillRender() {
  if (!pillEl) return;
  const txt = pillEl.querySelector(".fanyi-progress-text");
  const remaining = pillTotal - pillDone;
  if (pillTotal > 0 && remaining <= 0) {
    pillEl.classList.add("fanyi-progress-done");
    pillEl.title = "翻译完成";
    txt.textContent = `已完成 ${pillTotal}`;
  } else {
    pillEl.classList.remove("fanyi-progress-done");
    pillEl.title = "点击取消翻译";
    txt.textContent = `翻译中 ${pillDone}/${pillTotal}`;
  }
}

function pillAdd(n) {
  if (n <= 0) return;
  pillTotal += n;
  pillEnsure();
  pillRender();
}

function pillAdvance(n) {
  if (n <= 0) return;
  pillDone += n;
  pillRender();
  if (pillDone >= pillTotal) {
    if (pillHideTimer) clearTimeout(pillHideTimer);
    pillHideTimer = setTimeout(pillReset, 1500);
  }
}

function pillReset() {
  pillTotal = 0;
  pillDone = 0;
  if (pillEl) { pillEl.remove(); pillEl = null; }
  if (pillHideTimer) { clearTimeout(pillHideTimer); pillHideTimer = null; }
}

async function translateUnits(units) {
  if (!units.length) return;
  const fresh = [];
  let skippedSame = 0;
  let retranslate = 0;
  for (const u of units) {
    const marked = u.el.hasAttribute(MARK_ATTR);
    const stale = marked && isStale(u.el, u.text);
    if (marked && !stale) continue;
    if (stale) {
      clearUnit(u.el);
      u.el.removeAttribute(FAIL_ATTR);
      retranslate++;
    }
    if (sameLanguageAs(u.text, state.target)) {
      markUnit(u.el, u.text);
      skippedSame++;
      continue;
    }
    markUnit(u.el, u.text);
    fresh.push(u);
  }
  if (!fresh.length) {
    if (skippedSame || retranslate) console.info("[fanyi] skipped %d same-lang, %d re-translated", skippedSame, retranslate);
    return;
  }
  console.info("[fanyi] streaming %d fresh (skipped %d same-lang, %d re-translated)", fresh.length, skippedSame, retranslate);

  const ac = new AbortController();
  const key = Symbol();
  state.inflight.set(key, ac);
  pillAdd(fresh.length);

  let applied = 0;
  try {
    await translateStream(
      fresh.map(u => ({ text: u.text, tag: u.tag || null })),
      {
        site: state.adapter.site || location.hostname,
        topic: state.adapter.topic || null,
        model: state.model,
        target: state.target,
        signal: ac.signal,
        onChunk: (data) => {
          if (!state.enabled || !data?.items) return;
          let n = 0;
          for (const it of data.items) {
            const u = fresh[it.i];
            n++;
            if (!u || !u.el.isConnected) continue;
            if (it.failed) {
              if (markFailure(u.el)) u.el.removeAttribute(MARK_ATTR);
            } else {
              u.el.removeAttribute(FAIL_ATTR);
              appendTranslation(u.el, it.translation);
            }
          }
          applied += n;
          pillAdvance(n);
        },
      }
    );
  } catch (e) {
    console.warn("[fanyi] stream failed:", e);
    // Anything we never got back: requeue for retry.
    for (const u of fresh) {
      if (u.el.isConnected && !u.el.querySelector(":scope > .fanyi-translation")) {
        if (markFailure(u.el)) u.el.removeAttribute(MARK_ATTR);
      }
    }
  } finally {
    state.inflight.delete(key);
    // Drain pill counter for any items the stream skipped (error, disconnect, aborted).
    if (applied < fresh.length) pillAdvance(fresh.length - applied);
  }
}

function throttle(fn, ms) {
  let t = null, lastCall = 0;
  return (...args) => {
    const now = Date.now();
    const remain = ms - (now - lastCall);
    if (remain <= 0) {
      lastCall = now;
      fn(...args);
    } else {
      clearTimeout(t);
      t = setTimeout(() => { lastCall = Date.now(); fn(...args); }, remain);
    }
  };
}

// ---- Public API -------------------------------------------------------------

function runTranscribe(opts, respond) {
  (async () => {
    const v = pickPrimaryVideo();
    if (!v) { respond({ ok: false, err: "no video found on this page" }); return; }
    try {
      const { cues } = await transcribeVideo(v, opts, (s) => console.info("[fanyi sub]", s));
      respond({ ok: true, cues: cues.length });
    } catch (e) {
      console.error("[fanyi sub] failed", e);
      respond({ ok: false, err: String(e?.message || e) });
    }
  })();
}

export async function boot() {
  ensureStyles();
  state.adapter = await pickAdapter();
  state.site = state.adapter.site;

  // Listen for runtime commands (popup + keyboard)
  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg?.type === "fanyi:toggle") { toggle().then(() => sendResponse({ enabled: state.enabled })); return true; }
    if (msg?.type === "fanyi:enable") { enable().then(() => sendResponse({ enabled: true })); return true; }
    if (msg?.type === "fanyi:disable") { disable(); sendResponse({ enabled: false }); return false; }
    if (msg?.type === "fanyi:status") { sendResponse({ enabled: state.enabled, site: state.site }); return false; }
    if (msg?.type === "fanyi:transcribe-video") {
      runTranscribe(msg.opts || {}, sendResponse);
      return true;
    }
  });

  // Bridge: page-world code can dispatch a CustomEvent to trigger subtitle pipeline.
  //   document.dispatchEvent(new CustomEvent('fanyi:transcribe', { detail: { maxSeconds: 30 } }))
  document.addEventListener("fanyi:transcribe", (ev) => {
    runTranscribe(ev.detail || {}, (r) => {
      document.dispatchEvent(new CustomEvent("fanyi:transcribe:result", { detail: r }));
    });
  });

  // Page-world postMessage bridge for toggle/enable/disable — useful from DevTools
  // consoles and for automated browser tests.
  //   window.postMessage({ __fanyi: 'toggle' }, '*')
  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const cmd = ev.data?.__fanyi;
    if (cmd === "toggle") toggle();
    else if (cmd === "enable") enable();
    else if (cmd === "disable") disable();
  });

  // Load user prefs from storage.
  const prefs = await chrome.storage.sync.get(["autoSites", "targetLang", "model"]).catch(() => ({}));
  const autoSites = Array.isArray(prefs.autoSites) && prefs.autoSites.length ? prefs.autoSites : DEFAULT_AUTO_SITES;
  state.target = prefs.targetLang || DEFAULT_TARGET;
  state.model  = prefs.model || null;

  // Re-read on the fly when user changes settings in popup.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    if (changes.targetLang) state.target = changes.targetLang.newValue || DEFAULT_TARGET;
    if (changes.model)      state.model  = changes.model.newValue || null;
  });

  console.info("[fanyi] boot: adapter=%s site=%s target=%s model=%s auto=%o", state.adapter.name, state.site, state.target, state.model || "(default)", autoSites);
  if (state.site && autoSites.includes(state.site)) enable();
}

export async function enable() {
  if (state.enabled) return;
  state.enabled = true;
  document.documentElement.setAttribute("data-fanyi-state", "dual");

  const ad = state.adapter;
  console.info("[fanyi] enable: adapter=%s", ad.name);
  const onNew = throttle((units) => {
    if (!state.enabled) return;
    const sorted = ad.prioritize ? ad.prioritize(units) : units;
    translateUnits(sorted);
  }, 250);

  // Initial scan
  const first = ad.discoverUnits();
  console.info("[fanyi] initial scan found %d units", first.length);
  const sortedFirst = ad.prioritize ? ad.prioritize(first) : first;
  translateUnits(sortedFirst);

  // Ongoing
  state.disposeObserver = ad.observe ? ad.observe(onNew) : null;
}

export function disable() {
  if (!state.enabled) return;
  state.enabled = false;
  document.documentElement.removeAttribute("data-fanyi-state");
  if (state.disposeObserver) { state.disposeObserver(); state.disposeObserver = null; }
  for (const [, ac] of state.inflight) ac.abort();
  state.inflight.clear();
  removeAllTranslations();
  pillReset();
}

export async function toggle() {
  if (state.enabled) disable();
  else await enable();
}
