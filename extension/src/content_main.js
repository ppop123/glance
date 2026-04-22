// Main translation engine. Exported: boot(), toggle(), enable(), disable(), retranslate().
// Loaded via dynamic import from content_guard.js.

import { translateBatch } from "./lib/client.js";
import { appendTranslation, appendLoading, clearLoading, markUnit, removeAllTranslations, sameLanguageAs, isStale, clearUnit, MARK_ATTR, SRC_HASH_ATTR } from "./lib/walker.js";
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

async function translateUnits(units) {
  if (!units.length) return;
  // de-dup + same-language skip, but RE-TRANSLATE when marked element's source text changed (e.g. X "Show more" expansion).
  const fresh = [];
  let skippedSame = 0;
  let retranslate = 0;
  for (const u of units) {
    const marked = u.el.hasAttribute(MARK_ATTR);
    const stale = marked && isStale(u.el, u.text);
    if (marked && !stale) continue;                    // already translated with current text
    if (stale) {
      clearUnit(u.el);                                 // drop the old wrapper
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
  console.info("[fanyi] dispatching %d fresh (skipped %d same-lang, %d re-translated)", fresh.length, skippedSame, retranslate);

  // Split into reasonable chunks; backend batches further internally.
  const CHUNK = 30;
  const tasks = [];
  for (let i = 0; i < fresh.length; i += CHUNK) {
    const group = fresh.slice(i, i + CHUNK);
    tasks.push(dispatch(group));
  }
  await Promise.all(tasks);
}

async function dispatch(group) {
  const ac = new AbortController();
  const key = Symbol();
  state.inflight.set(key, ac);
  for (const u of group) {
    if (u.el.isConnected) appendLoading(u.el);
  }
  try {
    const payload = group.map(u => ({ text: u.text, tag: u.tag || null }));
    console.info("[fanyi] dispatch batch size=%d site=%s model=%s target=%s", payload.length, state.adapter.site, state.model || "(default)", state.target);
    const res = await translateBatch(payload, {
      site: state.adapter.site || location.hostname,
      topic: state.adapter.topic || null,
      model: state.model,
      target: state.target,
      signal: ac.signal,
    });
    console.info("[fanyi] batch ok: hits=%o latency=%dms upstream=%d", res.cache_hits, res.latency_ms, res.upstream_calls);
    for (let i = 0; i < group.length; i++) {
      const tr = res.translations[i];
      if (!group[i].el.isConnected) continue;
      if (!tr) { clearLoading(group[i].el); continue; }
      appendTranslation(group[i].el, tr);  // replaces loading wrapper in place
    }
  } catch (e) {
    if (e.name !== "AbortError") console.warn("[fanyi] batch failed (size=%d):", group.length, e);
    for (const u of group) clearLoading(u.el);
  } finally {
    state.inflight.delete(key);
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
}

export async function toggle() {
  if (state.enabled) disable();
  else await enable();
}
