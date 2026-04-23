// Main translation engine. Exported: boot(), toggle(), enable(), disable(), retranslate().
// Loaded via dynamic import from content_guard.js.

import { translateStream, translateOne } from "./lib/client.js";
import { appendTranslation, markUnit, removeAllTranslations, sameLanguageAs, isStale, clearUnit, dedupStaleWrappers, MARK_ATTR } from "./lib/walker.js";
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
  glossary: null,        // [[src, dst], ...] or null
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

/** Apply the user-chosen translation font — a CSS custom property the
 * injected stylesheet reads via `font-family: var(--fanyi-font, inherit)`.
 * Empty string falls back to the element's inherited font. */
function applyTranslationFont(value) {
  const root = document.documentElement;
  const v = (value || "").trim();
  if (v) root.style.setProperty("--fanyi-font", v);
  else root.style.removeProperty("--fanyi-font");
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

/** Final-failure UI: insert a compact warm-orange chip as the last child of
 * the source block with "⚠ 翻译失败 · 重试". Retry button clears fail state
 * and re-queues the block. The chip is distinct from any translation wrapper
 * so the user doesn't confuse it with actual translated output. */
function renderPermanentFailure(el) {
  if (el.querySelector(":scope > .fanyi-failed-msg")) return;
  const chip = document.createElement("span");
  chip.className = "fanyi-failed-msg";
  chip.setAttribute("data-fanyi-wrapper", "1");
  chip.setAttribute("data-fanyi-skip", "1");
  chip.append(
    document.createTextNode("⚠ 翻译失败"),
    Object.assign(document.createElement("span"), { className: "fanyi-failed-dot" }),
  );
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "fanyi-failed-retry";
  btn.setAttribute("data-fanyi-skip", "1");
  btn.textContent = "重试";
  btn.addEventListener("click", (ev) => {
    ev.preventDefault(); ev.stopPropagation();
    el.removeAttribute(MARK_ATTR);
    el.removeAttribute(FAIL_ATTR);
    el.removeAttribute("data-fanyi-src");
    chip.remove();
    translateUnits([{ el, text: extractPlainText(el) }]);
  });
  chip.appendChild(btn);
  el.appendChild(chip);
}

function extractPlainText(el) {
  return (el.textContent || "").replace(/\s+/g, " ").trim();
}

/** Treat whitespace-equivalent strings as "no translation happened". LLMs often
 * echo source untouched when content is all code, identifiers, or proper nouns.
 * Normalizing collapses spacing and Unicode fullwidth punctuation that's
 * semantically identical but byte-different. */
function isNoOpTranslation(src, tr) {
  if (!tr) return true;
  // Fold fullwidth CJK punctuation to their ASCII equivalents so that
  // "a, b, c" vs "a、b、c" counts as the same — the LLM only localized
  // the separators, no real translation happened.
  const norm = (s) => String(s || "")
    .replace(/[，、]/g, ",")
    .replace(/[。．]/g, ".")
    .replace(/[：]/g, ":")
    .replace(/[；]/g, ";")
    .replace(/[！]/g, "!")
    .replace(/[？]/g, "?")
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .replace(/[【]/g, "[")
    .replace(/[】]/g, "]")
    // Collapse whitespace AND strip spacing around punctuation — English uses
    // "a, b" while Chinese uses "a、b" with no surrounding space.
    .replace(/\s*([,.;:!?()[\]])\s*/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return norm(src) === norm(tr);
}

/* ── Global progress pill ─────────────────────────────────────────────────
 * One floating status badge, bottom-right. Replaces per-unit spinners.
 * Displays LAZILY — only appears if the current translation burst is still
 * pending after PILL_SHOW_DELAY_MS. Fast bursts (incremental scroll translating
 * 2-3 tweets in <600ms) never show the pill at all. Large initial scans that
 * take seconds do show it. Click to cancel. */
const PILL_SHOW_DELAY_MS = 600;
const PILL_DONE_LINGER_MS = 1200;

let pillTotal = 0;
let pillDone = 0;
let pillFailed = 0;   // how many of pillDone were failures (for the render)
let pillEl = null;
let pillShowTimer = null;
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
  // Trigger entrance animation (opacity / translate) on next frame so the
  // initial styles take effect before we add the reveal class.
  requestAnimationFrame(() => pillEl?.classList.add("fanyi-in"));
  if (pillHideTimer) { clearTimeout(pillHideTimer); pillHideTimer = null; }
}

function pillRender() {
  // Direct DOM write — no requestAnimationFrame. RAF gets heavily throttled
  // in background / inactive tabs, and a pill that silently fails to show
  // "翻译失败 N" because the user happened to be on another tab is exactly
  // the bug we're trying not to ship. Text content updates are cheap;
  // browsers coalesce paints themselves.
  if (!pillEl) return;
  const txt = pillEl.querySelector(".fanyi-progress-text");
  if (!txt) return;
  const remaining = pillTotal - pillDone;
  const ok = pillDone - pillFailed;
  const failSuffix = pillFailed > 0 ? ` · 失败 ${pillFailed}` : "";
  pillEl.classList.toggle("fanyi-progress-err", pillFailed > 0);
  if (pillTotal > 0 && remaining <= 0) {
    pillEl.classList.add("fanyi-progress-done");
    if (pillFailed > 0 && ok === 0) {
      pillEl.title = "翻译失败 · 点击关闭 · 检查 API Key / 服务商可用性";
      txt.textContent = `翻译失败 ${pillFailed}`;
    } else if (pillFailed > 0) {
      pillEl.title = "部分失败 · 点击关闭";
      txt.textContent = `已完成 ${ok}${failSuffix}`;
    } else {
      pillEl.title = "翻译完成";
      txt.textContent = `已完成 ${pillTotal}`;
    }
  } else {
    pillEl.classList.remove("fanyi-progress-done");
    pillEl.title = "点击取消翻译";
    txt.textContent = `翻译中 ${pillDone}/${pillTotal}${failSuffix}`;
  }
}

function pillAdd(n) {
  if (n <= 0) return;
  pillTotal += n;
  if (pillEl) { pillRender(); return; }
  // Schedule lazy reveal. If total finishes before the timer fires, it's cancelled
  // in pillAdvance and the pill never appears.
  if (pillShowTimer) return;
  pillShowTimer = setTimeout(() => {
    pillShowTimer = null;
    if (pillDone >= pillTotal) return;  // finished during the grace window
    pillEnsure();
    pillRender();
  }, PILL_SHOW_DELAY_MS);
}

function pillAdvance(n, failed = 0) {
  if (n <= 0) return;
  pillDone += n;
  if (failed > 0) pillFailed += failed;
  // Force the pill to reveal if it was still in the lazy-delay window — a
  // silent "done" with failures is the exact bug we're fixing.
  if (failed > 0 && !pillEl && pillShowTimer) {
    clearTimeout(pillShowTimer);
    pillShowTimer = null;
    pillEnsure();
  }
  if (pillEl) pillRender();
  if (pillDone >= pillTotal) {
    if (pillShowTimer) { clearTimeout(pillShowTimer); pillShowTimer = null; }
    if (pillEl) {
      if (pillHideTimer) clearTimeout(pillHideTimer);
      // Keep failure state on screen longer so the user actually notices.
      const linger = pillFailed > 0 ? PILL_DONE_LINGER_MS * 4 : PILL_DONE_LINGER_MS;
      pillHideTimer = setTimeout(pillReset, linger);
    } else {
      // Quietly reset counters — nothing was ever shown.
      pillTotal = 0;
      pillDone = 0;
      pillFailed = 0;
    }
  }
}

function pillReset() {
  pillTotal = 0;
  pillDone = 0;
  pillFailed = 0;
  if (pillEl) { pillEl.remove(); pillEl = null; }
  if (pillShowTimer) { clearTimeout(pillShowTimer); pillShowTimer = null; }
  if (pillHideTimer) { clearTimeout(pillHideTimer); pillHideTimer = null; }
}

async function translateUnits(units) {
  if (!units.length) return;
  // Self-heal pass: if any unit's element ended up with 2+ wrapper siblings
  // (possible if a prior version of the code raced, or if the user loaded
  // older code earlier in this tab), collapse them. Cheap — a single
  // querySelectorAll per element. Logs when it actually finds any so we can
  // tell from the console whether this codepath is doing real work.
  let collapsed = 0;
  for (const u of units) {
    const wrappers = u.el.querySelectorAll(`:scope > .fanyi-translation`);
    if (wrappers.length > 1) {
      for (let i = 0; i < wrappers.length - 1; i++) wrappers[i].remove();
      collapsed++;
    }
  }
  if (collapsed) console.warn("[fanyi] self-heal: collapsed duplicate wrappers on %d element(s)", collapsed);
  const fresh = [];
  let skippedSame = 0;
  let retranslate = 0;
  let deferred = 0;
  // Anything further than this many viewports away is deferred — the scroll
  // observer will pick it up when the user approaches it. On Wikipedia pages
  // with 1500+ blocks this avoids translating hundreds of never-visible
  // collapsed / below-fold sections.
  const vh = window.innerHeight || 800;
  const FORWARD = vh * 3;
  const BACKWARD = vh * 1;
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
    // Viewport-lazy gate: leave far-offscreen units unmarked so a later scroll
    // triggers re-discovery and pulls them in at their turn.
    const rect = u.el.getBoundingClientRect();
    if (rect.top > FORWARD || rect.bottom < -BACKWARD) {
      deferred++;
      continue;
    }
    markUnit(u.el, u.text);
    fresh.push(u);
  }
  if (!fresh.length) {
    if (skippedSame || retranslate || deferred) console.debug("[fanyi] skipped %d same-lang, %d re-translated, %d deferred", skippedSame, retranslate, deferred);
    return;
  }
  // Client-side dedup: many pages repeat the same text (retweets, nav items
  // like "Edit" / "Notes" reused on every article). Send each unique string
  // once; fan out the response to every element that shared it.
  const byText = new Map();  // text → { rep: u, els: [u...] }
  for (const u of fresh) {
    const g = byText.get(u.text);
    if (g) g.els.push(u);
    else byText.set(u.text, { rep: u, els: [u] });
  }
  const unique = Array.from(byText.values()).map((g) => g.rep);
  const fanout = new Map(unique.map((u, i) => [i, byText.get(u.text).els]));
  const dedupSkipped = fresh.length - unique.length;

  console.debug(
    "[fanyi] streaming %d unique (dedup -%d, same-lang -%d, re-translated +%d, deferred %d)",
    unique.length, dedupSkipped, skippedSame, retranslate, deferred
  );

  const ac = new AbortController();
  const key = Symbol();
  state.inflight.set(key, ac);
  pillAdd(fresh.length);

  let applied = 0;
  try {
    await translateStream(
      unique.map(u => ({ text: u.text, tag: u.tag || null, context: u.context || null })),
      {
        site: state.adapter.site || location.hostname,
        topic: state.adapter.topic || null,
        model: state.model,
        target: state.target,
        glossary: state.glossary,
        signal: ac.signal,
        onChunk: (data) => {
          if (!state.enabled || !data?.items) return;
          let n = 0;
          let nFailed = 0;
          for (const it of data.items) {
            const els = fanout.get(it.i) || [];
            for (const u of els) {
              n++;
              if (it.failed) nFailed++;
              if (!u.el.isConnected) continue;
              if (it.failed) {
                if (markFailure(u.el)) u.el.removeAttribute(MARK_ATTR);
                else renderPermanentFailure(u.el);
              } else {
                u.el.removeAttribute(FAIL_ATTR);
                // No-op translation: the LLM returned the source unchanged (code
                // lists, proper nouns, pure numbers, etc.). Don't duplicate the
                // line — the user's unit is already visible as-is.
                if (!isNoOpTranslation(u.text, it.translation)) {
                  appendTranslation(u.el, it.translation);
                }
              }
            }
          }
          applied += n;
          pillAdvance(n, nFailed);
        },
      }
    );
  } catch (e) {
    console.warn("[fanyi] stream failed:", e);
    for (const u of fresh) {
      if (u.el.isConnected && !u.el.querySelector(":scope > .fanyi-translation")) {
        if (markFailure(u.el)) u.el.removeAttribute(MARK_ATTR);
        else renderPermanentFailure(u.el);
      }
    }
  } finally {
    state.inflight.delete(key);
    if (applied < fresh.length) {
      // Everything that didn't surface in onChunk was a stream-level failure
      // (network cut, provider 500 with no per-item rows, etc.). Count them
      // as failures in the pill so the user doesn't see a silent "done".
      const missing = fresh.length - applied;
      pillAdvance(missing, missing);
    }
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

/* ── Selection translation ───────────────────────────────────────────────
 * Classic "highlight → tiny button → popover with translation" flow. Works
 * independent of page-translate state so it's useful even when auto-translate
 * is off on this site. */
const MIN_SEL_LEN = 2;
const MAX_SEL_LEN = 2000;
let selBtnEl = null;
let selPopEl = null;
let selCurrentText = "";
let selChangeTimer = null;

function selEnsureBtn() {
  if (selBtnEl) return;
  selBtnEl = document.createElement("div");
  selBtnEl.className = "fanyi-sel-btn";
  selBtnEl.setAttribute("data-fanyi-skip", "1");
  selBtnEl.setAttribute("data-fanyi-wrapper", "1");
  selBtnEl.setAttribute("role", "button");
  selBtnEl.setAttribute("aria-label", "翻译选中");
  selBtnEl.title = "翻译选中";
  selBtnEl.textContent = "译";
  // don't let mousedown collapse the selection
  selBtnEl.addEventListener("mousedown", (e) => e.preventDefault());
  selBtnEl.addEventListener("click", selOnClick);
  document.documentElement.appendChild(selBtnEl);
}

function selHideBtn() {
  if (!selBtnEl) return;
  selBtnEl.classList.remove("fanyi-in");
  selBtnEl.style.display = "none";
}

function selShowBtnAt(rect) {
  selEnsureBtn();
  selBtnEl.style.display = "flex";
  selBtnEl.style.top = `${window.scrollY + rect.bottom + 6}px`;
  selBtnEl.style.left = `${window.scrollX + Math.max(rect.right - 22, rect.left)}px`;
  requestAnimationFrame(() => selBtnEl?.classList.add("fanyi-in"));
}

function selOnChange() {
  if (selChangeTimer) clearTimeout(selChangeTimer);
  selChangeTimer = setTimeout(() => {
    selChangeTimer = null;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) { selHideBtn(); return; }
    const text = (sel.toString() || "").trim();
    if (text.length < MIN_SEL_LEN || text.length > MAX_SEL_LEN) { selHideBtn(); return; }
    const anchor = sel.anchorNode?.nodeType === Node.ELEMENT_NODE ? sel.anchorNode : sel.anchorNode?.parentElement;
    if (anchor?.closest?.("[data-fanyi-skip], [data-fanyi-wrapper]")) { selHideBtn(); return; }
    let range;
    try { range = sel.getRangeAt(0); } catch { selHideBtn(); return; }
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) { selHideBtn(); return; }
    selCurrentText = text;
    selShowBtnAt(rect);
  }, 120);
}

async function selOnClick(ev) {
  ev.preventDefault(); ev.stopPropagation();
  const text = selCurrentText;
  if (!text) return;
  const btnRect = selBtnEl.getBoundingClientRect();
  selHideBtn();
  selShowPop(btnRect.left, btnRect.top, "翻译中…", true);
  try {
    const tr = await translateOne(text, {
      site: location.hostname,
      model: state.model,
      target: state.target,
      glossary: state.glossary,
    });
    selShowPop(btnRect.left, btnRect.top, tr || "(无结果)", false);
  } catch (e) {
    selShowPop(btnRect.left, btnRect.top, `翻译失败：${e?.message || e}`, false);
  }
}

function selShowPop(x, y, text, loading) {
  if (!selPopEl) {
    selPopEl = document.createElement("div");
    selPopEl.className = "fanyi-sel-pop";
    selPopEl.setAttribute("data-fanyi-skip", "1");
    selPopEl.setAttribute("data-fanyi-wrapper", "1");
    selPopEl.setAttribute("role", "dialog");
    document.documentElement.appendChild(selPopEl);
  }
  const html = loading
    ? `<span class="fanyi-sel-pop-spin"></span><span class="fanyi-sel-pop-text">${selEscape(text)}</span>`
    : `<div class="fanyi-sel-pop-text">${selEscape(text)}</div>`;
  selPopEl.innerHTML = html;
  selPopEl.style.display = "block";
  // Measure before applying final position + fade-in.
  selPopEl.classList.remove("fanyi-in");
  selPopEl.style.visibility = "hidden";
  selPopEl.style.top = "0";
  selPopEl.style.left = "0";
  const w = selPopEl.offsetWidth || 200;
  const h = selPopEl.offsetHeight || 40;
  let top = y + 24;
  let left = x - w / 2;
  if (left < 8) left = 8;
  if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
  if (top + h > window.innerHeight - 8) top = Math.max(8, y - h - 8);
  selPopEl.style.top = `${window.scrollY + top}px`;
  selPopEl.style.left = `${window.scrollX + left}px`;
  selPopEl.style.visibility = "";
  requestAnimationFrame(() => selPopEl?.classList.add("fanyi-in"));
}

function selHidePop() {
  if (!selPopEl) return;
  selPopEl.classList.remove("fanyi-in");
  selPopEl.style.display = "none";
}

function selEscape(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function selInstall() {
  document.addEventListener("selectionchange", selOnChange);
  document.addEventListener("mousedown", (ev) => {
    const t = ev.target;
    if (t && t.closest?.(".fanyi-sel-btn, .fanyi-sel-pop")) return;
    selHidePop();
  }, true);
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") { selHidePop(); selHideBtn(); }
  });
}

/* ── Floating Action Button ──────────────────────────────────────────────
 * Always-on corner entry point to toggle translation on the current page. */
let fabEl = null;
let fabMenuEl = null;

function fabEnsure() {
  if (fabEl) return;
  fabEl = document.createElement("div");
  fabEl.className = "fanyi-fab";
  fabEl.setAttribute("data-fanyi-skip", "1");
  fabEl.setAttribute("data-fanyi-wrapper", "1");
  fabEl.setAttribute("role", "button");
  fabEl.setAttribute("aria-label", "翻译此页");
  fabEl.innerHTML = `<span class="fanyi-fab-label">译</span>`;
  fabEl.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); toggle(); fabCloseMenu(); fabRender(); });
  fabEl.addEventListener("contextmenu", (ev) => { ev.preventDefault(); fabToggleMenu(); });
  document.documentElement.appendChild(fabEl);
  fabRender();
}

function fabRender() {
  if (!fabEl) return;
  if (state.enabled) {
    fabEl.classList.add("fanyi-fab-on");
    fabEl.title = "关闭翻译（右键 = 更多）";
  } else {
    fabEl.classList.remove("fanyi-fab-on");
    fabEl.title = "翻译此页（右键 = 更多）";
  }
}

function fabToggleMenu() {
  if (fabMenuEl?.classList.contains("fanyi-open")) { fabCloseMenu(); return; }
  if (!fabMenuEl) {
    fabMenuEl = document.createElement("div");
    fabMenuEl.className = "fanyi-fab-menu";
    fabMenuEl.setAttribute("data-fanyi-skip", "1");
    fabMenuEl.setAttribute("data-fanyi-wrapper", "1");
    document.documentElement.appendChild(fabMenuEl);
    fabMenuEl.addEventListener("click", fabOnMenuClick);
  }
  const host = location.hostname.toLowerCase();
  const isAuto = (state._autoSites || []).includes(host);
  // Video subtitle entry — only shown when the current page actually has a
  // primary <video>, so YouTube / Bilibili / embedded players get it but a
  // plain article doesn't clutter the menu with a useless button.
  const hasVideo = !!pickPrimaryVideo();
  const subtitleRow = hasVideo
    ? `<button data-act="subtitle">生成字幕</button>`
    : "";
  fabMenuEl.innerHTML = `
    <button data-act="toggle">${state.enabled ? "关闭翻译" : "翻译此页"}</button>
    <button data-act="auto">${isAuto ? "不再自动翻译本站" : "始终自动翻译本站"}</button>
    ${subtitleRow}
    <button data-act="options">设置…</button>
    <button data-act="hide">隐藏悬浮球</button>
  `;
  // Reveal via class so the design's CSS transition (opacity + translateX) plays.
  requestAnimationFrame(() => fabMenuEl?.classList.add("fanyi-open"));
}

function fabCloseMenu() { if (fabMenuEl) fabMenuEl.classList.remove("fanyi-open"); }

async function fabOnMenuClick(ev) {
  const b = ev.target.closest("button[data-act]");
  if (!b) return;
  const act = b.dataset.act;
  fabCloseMenu();
  if (act === "toggle") { await toggle(); fabRender(); return; }
  if (act === "auto") {
    const host = location.hostname.toLowerCase();
    const current = Array.isArray(state._autoSites) ? state._autoSites : [];
    const next = current.includes(host) ? current.filter((h) => h !== host) : [...current, host];
    state._autoSites = next;
    await chrome.storage.sync.set({ autoSites: next });
    if (next.includes(host) && !state.enabled) { await enable(); fabRender(); }
  }
  if (act === "options") { chrome.runtime.sendMessage({ type: "fanyi:open-options" }).catch(() => chrome.runtime.openOptionsPage?.()); }
  if (act === "subtitle") {
    // Pull the user's subtitle defaults (set in options page) so behavior
    // matches their preferences. Fallback to baked-in defaults.
    const prefs = await chrome.storage.sync.get({
      subDefaultSeconds: 60,
      subBilingual: true,
      subPreferDownload: true,
      targetLang: DEFAULT_TARGET,
    }).catch(() => ({}));
    runTranscribe({
      maxSeconds: Math.max(5, parseInt(prefs.subDefaultSeconds || 60, 10)),
      translate: !!prefs.subBilingual,
      targetLang: prefs.targetLang || DEFAULT_TARGET,
      preferDownload: prefs.subPreferDownload !== false,
      sourceUrl: location.href,
      showToast: true,
    }, () => { /* no-op; subtitle.js shows its own toast */ });
  }
  if (act === "hide") {
    await chrome.storage.sync.set({ showFab: false });
    fabRemove();
  }
}

function fabRemove() {
  if (fabEl) { fabEl.remove(); fabEl = null; }
  if (fabMenuEl) { fabMenuEl.remove(); fabMenuEl = null; }
}

function fabInstall() {
  if (window.top !== window) return;            // only top frame
  if (!/^https?:/.test(location.href)) return;  // not on chrome:// etc.
  if (state.showFab === false) return;          // user hid it
  fabEnsure();
  // Close menu on outside click
  document.addEventListener("mousedown", (ev) => {
    const t = ev.target;
    if (t && t.closest?.(".fanyi-fab, .fanyi-fab-menu")) return;
    fabCloseMenu();
  }, true);
}

export async function boot() {
  ensureStyles();
  // One-off sweep for any stale multi-wrapper state left behind by earlier
  // buggy versions of appendTranslation. Safe no-op on clean pages.
  const removed = dedupStaleWrappers(document.body);
  if (removed) console.warn("[fanyi] boot: removed %d stale duplicate wrappers", removed);
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

  // Page-world postMessage bridge for toggle/enable/disable + dev storage helpers.
  //   window.postMessage({ __fanyi: 'toggle' }, '*')
  //   window.postMessage({ __fanyi: 'set', key: 'showFab', value: true }, '*')
  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    const cmd = d?.__fanyi;
    if (cmd === "toggle") toggle();
    else if (cmd === "enable") enable();
    else if (cmd === "disable") disable();
    else if (cmd === "set" && typeof d.key === "string") chrome.storage.sync.set({ [d.key]: d.value });
  });

  // Load user prefs from storage.
  const prefs = await chrome.storage.sync.get(["autoSites", "targetLang", "model", "glossary", "showFab", "translationFont"]).catch(() => ({}));
  const autoSites = Array.isArray(prefs.autoSites) && prefs.autoSites.length ? prefs.autoSites : DEFAULT_AUTO_SITES;
  state.target = prefs.targetLang || DEFAULT_TARGET;
  state.model  = prefs.model || null;
  state.glossary = Array.isArray(prefs.glossary) && prefs.glossary.length ? prefs.glossary : null;
  state.showFab = prefs.showFab !== false;  // default on; user can hide via FAB menu
  applyTranslationFont(prefs.translationFont || "");

  // Re-read on the fly when user changes settings in popup. Coalesce
  // retranslate calls on a short timer so simultaneous multi-key updates
  // (e.g. user changing provider + glossary in one popup action) don't fire
  // two competing scans back-to-back.
  let retransTimer = null;
  const scheduleRetranslate = () => {
    if (retransTimer) clearTimeout(retransTimer);
    retransTimer = setTimeout(() => {
      retransTimer = null;
      retranslate().catch((e) => console.warn("[fanyi] retranslate failed", e));
    }, 150);
  };
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    let needsRetranslate = false;
    if (changes.targetLang) {
      state.target = changes.targetLang.newValue || DEFAULT_TARGET;
      needsRetranslate = true;
    }
    if (changes.model) {
      state.model = changes.model.newValue || null;
      needsRetranslate = true;
    }
    if (changes.glossary) {
      state.glossary = Array.isArray(changes.glossary.newValue) && changes.glossary.newValue.length ? changes.glossary.newValue : null;
      needsRetranslate = true;
    }
    if (changes.showFab) {
      state.showFab = changes.showFab.newValue !== false;
      if (state.showFab) fabInstall();
      else fabRemove();
    }
    if (changes.translationFont) applyTranslationFont(changes.translationFont.newValue || "");
    if (needsRetranslate && state.enabled) scheduleRetranslate();
  });

  console.info("[fanyi] boot: adapter=%s site=%s target=%s model=%s auto=%o", state.adapter.name, state.site, state.target, state.model || "(default)", autoSites);

  state._autoSites = autoSites;
  // Selection translation is independent of page-translate mode — install once.
  if (window.top === window) { selInstall(); fabInstall(); }

  if (state.site && autoSites.includes(state.site)) enable();
}

export async function enable() {
  if (state.enabled) return;
  state.enabled = true;
  document.documentElement.setAttribute("data-fanyi-state", "dual");
  fabRender();

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
  fabRender();
}

export async function toggle() {
  if (state.enabled) disable();
  else await enable();
}

/** Wipe current translations and re-run an initial scan with whatever
 * state.model / state.target / state.glossary hold. Used when the user
 * changes provider / model / target language in the popup — the stale
 * Chinese in the DOM would otherwise hide the fact that the new model
 * is now active. Silently no-ops when translation is off. */
export async function retranslate() {
  if (!state.enabled) return;
  for (const [, ac] of state.inflight) ac.abort();
  state.inflight.clear();
  removeAllTranslations();
  pillReset();
  const ad = state.adapter;
  if (!ad) return;
  const first = ad.discoverUnits();
  console.info("[fanyi] retranslate: scan found %d units (model=%s target=%s)",
    first.length, state.model || "(default)", state.target);
  const sortedFirst = ad.prioritize ? ad.prioritize(first) : first;
  translateUnits(sortedFirst);
}
