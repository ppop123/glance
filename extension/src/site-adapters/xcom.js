// Adapter for x.com / twitter.com.
// Strategy: each "article[data-testid='tweet']" is one unit. Use the status URL as the tag.
// This gives a very stable per-tweet cache key; even if the timeline re-renders, we hit cache.
//
// Sub-structures inside a tweet we care about:
//   div[data-testid='tweetText']   -> the actual text (primary)
//   div[data-testid='User-Name']   -> skip (names)
//   div[data-testid='card.*']      -> skip (link card preview, often junk)
//   nested article[role='article'] -> quoted tweet; recurse separately

import { MARK_ATTR, cheapHash, normalizeText } from "../lib/walker.js";
import { transcribeVideo } from "../subtitle.js";

export const name = "xcom";
export const site = "x.com";
export const topic = "social";

export function match() {
  const h = location.hostname.toLowerCase();
  return h === "x.com" || h === "twitter.com" || h.endsWith(".x.com") || h.endsWith(".twitter.com");
}

/** ── Inline subtitle button on tweet videos ─────────────────────────────
 * For every <video> inside a tweet (not ad), inject a small corner button
 * that transcribes the tweet's audio using its permalink URL via yt-dlp.
 * No popup needed. */

const SUB_WRAP_CLASS = "fanyi-sub-wrap";
const SUB_BTN_CLASS = "fanyi-sub-button";
const SUB_MENU_CLASS = "fanyi-sub-menu";

function ensureSubtitleButtonStyle() {
  if (document.getElementById("fanyi-sub-style")) return;
  const st = document.createElement("style");
  st.id = "fanyi-sub-style";
  st.textContent = `
    .${SUB_WRAP_CLASS} {
      position: absolute; right: 8px; top: 8px;
      z-index: 10;
      opacity: 0;
      transition: opacity .18s;
      pointer-events: none;
      font: 500 12px/1.2 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
      color: #fff;
    }
    /* JS toggles .fanyi-hover on the wrap via pointer events on the video container — more
       reliable than CSS :hover, which can flicker when X's control overlay captures the cursor. */
    .${SUB_WRAP_CLASS}.fanyi-hover,
    .${SUB_WRAP_CLASS}.fanyi-open,
    .${SUB_WRAP_CLASS}.fanyi-working,
    .${SUB_WRAP_CLASS}[data-loading="1"] {
      opacity: 1;
      pointer-events: auto;
    }

    .${SUB_BTN_CLASS} {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 5px 10px 5px 8px; height: 28px;
      border: none; border-radius: 9999px;
      background: rgba(15,20,25,.78); color: #fff; cursor: pointer;
      pointer-events: auto;
      font: inherit;
      transition: background .15s, transform .12s;
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
    }
    .${SUB_BTN_CLASS}:hover { background: rgba(29,155,240,.95); }
    .${SUB_BTN_CLASS}:active { transform: scale(.97); }
    .${SUB_BTN_CLASS} svg { width: 14px; height: 14px; }
    .${SUB_BTN_CLASS}[data-busy="1"] .fanyi-sub-icon { display: none; }
    .${SUB_BTN_CLASS}[data-busy="1"]::before {
      content: ""; width: 12px; height: 12px; display: inline-block;
      border: 2px solid rgba(255,255,255,.35); border-top-color: #fff;
      border-radius: 50%; animation: fanyi-spin .7s linear infinite;
    }
    @keyframes fanyi-spin { to { transform: rotate(360deg); } }

    .${SUB_MENU_CLASS} {
      position: absolute; right: 0; bottom: calc(100% + 6px);
      min-width: 200px;
      background: rgba(22,28,36,.96);
      color: #fff;
      border-radius: 10px;
      box-shadow: 0 8px 24px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,255,.06);
      padding: 6px;
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
    }
    .${SUB_MENU_CLASS}[hidden] { display: none; }
    .fanyi-sub-hint {
      padding: 6px 10px 4px; font-size: 11px; color: rgba(255,255,255,.5);
    }
    .fanyi-sub-item {
      display: flex; align-items: center; gap: 10px;
      width: 100%; padding: 8px 10px; border: none; border-radius: 6px;
      background: transparent; color: #fff; cursor: pointer;
      font: inherit; text-align: left;
    }
    .fanyi-sub-item:hover { background: rgba(255,255,255,.08); }
    .fanyi-sub-item.primary { color: #58a6ff; }
    .fanyi-sub-item svg { width: 16px; height: 16px; flex-shrink: 0; }
    .fanyi-sub-item.disabled { opacity: .45; cursor: not-allowed; }
  `;
  document.documentElement.appendChild(st);
}

function tweetPermalinkFromArticle(article) {
  const a = article.querySelector('a[href*="/status/"]');
  if (!a) return null;
  const href = a.getAttribute("href");
  return href.startsWith("http") ? href : `https://x.com${href.split("?")[0]}`;
}

function videoContainerFor(video) {
  // X's stable video wrapper = [data-testid="videoPlayer"]. Prefer it.
  // Fallback: first positioned ancestor.
  const stable = video.closest('[data-testid="videoPlayer"]');
  if (stable) return stable;
  let el = video.parentElement;
  while (el && el !== document.body) {
    const cs = getComputedStyle(el);
    if (cs.position === "relative" || cs.position === "absolute" || cs.position === "fixed") return el;
    el = el.parentElement;
  }
  return video.parentElement;
}

const ICON_CC = `<svg class="fanyi-sub-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 11h4M7 14h3M13 11h4M13 14h4"/></svg>`;
const ICON_SPARKLE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"/></svg>`;
const ICON_DOWNLOAD = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>`;
const ICON_SETTINGS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v6M12 17v6M4.22 4.22l4.24 4.24M15.54 15.54l4.24 4.24M1 12h6M17 12h6M4.22 19.78l4.24-4.24M15.54 8.46l4.24-4.24"/></svg>`;

function addSubtitleButton(article) {
  const videos = article.querySelectorAll("video");
  if (!videos.length) return;
  ensureSubtitleButtonStyle();
  const permalink = tweetPermalinkFromArticle(article);
  if (!permalink) return;
  for (const video of videos) {
    const container = videoContainerFor(video);
    if (!container || container.querySelector(`:scope > .${SUB_WRAP_CLASS}`)) continue;
    if (getComputedStyle(container).position === "static") container.style.position = "relative";

    const wrap = document.createElement("div");
    wrap.className = SUB_WRAP_CLASS;
    wrap.setAttribute("data-fanyi-skip", "1");
    wrap.innerHTML = `
      <button class="${SUB_BTN_CLASS}" aria-haspopup="menu" aria-expanded="false" title="AI 字幕">
        ${ICON_CC}<span>AI 字幕</span>
      </button>
      <div class="${SUB_MENU_CLASS}" role="menu" hidden>
        <div class="fanyi-sub-hint">为视频自动生成字幕</div>
        <button class="fanyi-sub-item primary" data-action="generate">
          ${ICON_SPARKLE}<span>开始生成字幕</span>
        </button>
        <button class="fanyi-sub-item" data-action="download" disabled>
          ${ICON_DOWNLOAD}<span>下载字幕文件</span>
        </button>
        <button class="fanyi-sub-item" data-action="options">
          ${ICON_SETTINGS}<span>翻译设置</span>
        </button>
      </div>
    `;
    // Resolve the <video> dynamically every time — X's virtualized feed can swap
    // the element under us. Container stays stable because we positioned it.
    wrap._fanyiGetVideo = () => container.querySelector("video") || video;
    wrap._fanyiPermalink = permalink;
    container.appendChild(wrap);

    // Reliable hover gating — tracks pointer over the real video container region.
    // Use pointerenter/pointerleave so briefly entering the wrap's own area counts as hover.
    const setHover = (on) => {
      if (on) wrap.classList.add("fanyi-hover");
      else wrap.classList.remove("fanyi-hover");
    };
    container.addEventListener("pointerenter", () => setHover(true));
    container.addEventListener("pointerleave", (ev) => {
      // Keep visible if leaving into the menu, or if a job is in flight.
      const to = ev.relatedTarget;
      if (to && wrap.contains(to)) return;
      if (wrap.classList.contains("fanyi-open") || wrap.classList.contains("fanyi-working")) return;
      setHover(false);
    });
  }
}

/** Build a VTT blob from cues and trigger download. */
function downloadVttForVideo(video, filename = "subtitles.vtt") {
  const track = Array.from(video.textTracks || []).find(t => t.label === "fanyi");
  if (!track || !track.cues?.length) return false;
  const pad = (n, w) => String(n).padStart(w, "0");
  const fmt = (s) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s - h * 3600 - m * 60;
    return `${pad(h,2)}:${pad(m,2)}:${sec.toFixed(3).padStart(6,"0")}`;
  };
  const lines = ["WEBVTT", ""];
  Array.from(track.cues).forEach((c, i) => {
    lines.push(String(i + 1));
    lines.push(`${fmt(c.startTime)} --> ${fmt(c.endTime)}`);
    lines.push(c.text);
    lines.push("");
  });
  const blob = new Blob([lines.join("\n")], { type: "text/vtt" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

/** Close all open fanyi menus. */
function closeAllSubMenus() {
  document.querySelectorAll(`.${SUB_WRAP_CLASS}.fanyi-open`).forEach(w => {
    w.classList.remove("fanyi-open");
    w.querySelector(`.${SUB_MENU_CLASS}`)?.setAttribute("hidden", "");
    w.querySelector(`.${SUB_BTN_CLASS}`)?.setAttribute("aria-expanded", "false");
  });
}

/** Global delegated handlers — installed once. Robust to React re-renders. */
let _clickHandlerInstalled = false;
function ensureSubClickHandler() {
  if (_clickHandlerInstalled) return;
  _clickHandlerInstalled = true;

  document.addEventListener("click", async (ev) => {
    // Toggle menu on button click
    const btn = ev.target?.closest?.(`.${SUB_BTN_CLASS}`);
    if (btn) {
      ev.stopPropagation(); ev.preventDefault();
      const wrap = btn.closest(`.${SUB_WRAP_CLASS}`);
      const menu = wrap?.querySelector(`.${SUB_MENU_CLASS}`);
      if (!menu) return;
      const open = !wrap.classList.contains("fanyi-open");
      closeAllSubMenus();
      if (open) {
        wrap.classList.add("fanyi-open");
        menu.removeAttribute("hidden");
        btn.setAttribute("aria-expanded", "true");
        // Refresh enabled state of download
        const video = wrap._fanyiGetVideo?.();
        const track = Array.from(video?.textTracks || []).find(t => t.label === "fanyi");
        const dl = menu.querySelector('[data-action="download"]');
        if (dl) dl.disabled = !(track?.cues?.length);
      }
      return;
    }

    // Handle menu actions
    const item = ev.target?.closest?.(".fanyi-sub-item");
    if (item) {
      ev.stopPropagation(); ev.preventDefault();
      const wrap = item.closest(`.${SUB_WRAP_CLASS}`);
      const video = wrap?._fanyiGetVideo?.();
      const permalink = wrap?._fanyiPermalink;
      const action = item.dataset.action;
      closeAllSubMenus();

      if (action === "generate") {
        if (!video || !permalink) return;
        if (wrap.dataset.loading) return;
        wrap.dataset.loading = "1";
        const mainBtn = wrap.querySelector(`.${SUB_BTN_CLASS}`);
        mainBtn.dataset.busy = "1";
        const setLabel = (txt) => { const s = mainBtn.querySelector("span"); if (s) s.textContent = txt; };
        setLabel("生成中…");
        // Keep the pill visible while a job is running (override the hover-only CSS)
        wrap.classList.add("fanyi-working");
        try {
          await transcribeVideo(video, {
            maxSeconds: 600,
            sourceUrl: permalink,
            preferDownload: true,
            translate: true,
            targetLang: "zh-CN",
            showToast: true,
            onStatus: (s) => {
              if (s.phase === "starting" || s.phase === "queued" || s.phase === "downloading" || s.phase === "chunking") {
                setLabel("准备中…");
              } else if (s.phase === "transcribing") {
                if (s.total && s.total > 1) setLabel(`生成中 ${s.completed || 0}/${s.total}`);
                else setLabel("生成中…");
              } else if (s.phase === "translating") {
                setLabel("翻译中…");
              } else if (s.phase === "attaching") {
                setLabel("挂载字幕…");
              }
            },
          });
          setLabel("字幕已生成");
          setTimeout(() => setLabel("AI 字幕"), 3000);
        } catch (e) {
          console.warn("[fanyi sub] generate failed:", e);
          setLabel("生成失败");
          setTimeout(() => setLabel("AI 字幕"), 3000);
        } finally {
          wrap.classList.remove("fanyi-working");
          delete mainBtn.dataset.busy;
          delete wrap.dataset.loading;
        }
      } else if (action === "download") {
        if (!video) return;
        // Use clean filename based on tweet id + author if available
        const m = (wrap._fanyiPermalink || "").match(/x\.com\/([^/]+)\/status\/(\d+)/);
        const name = (m ? `${m[1]}-${m[2]}` : (document.title || "subtitles")).replace(/[/\\?%*:|"<>]/g, "_").slice(0, 80) + ".vtt";
        downloadVttForVideo(video, name);
      } else if (action === "options") {
        chrome.runtime.sendMessage({ type: "fanyi:open-options" }).catch(() => chrome.runtime.openOptionsPage?.());
      }
    }
  }, true);

  // Click outside → close menus
  document.addEventListener("click", (ev) => {
    if (!ev.target?.closest?.(`.${SUB_WRAP_CLASS}`)) closeAllSubMenus();
  });
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") closeAllSubMenus(); });
}

/** X marks sponsored posts with a bare "Ad" label inside a <span>. */
function isAdArticle(article) {
  const spans = article.querySelectorAll("span");
  for (const s of spans) {
    if (s.textContent?.trim() === "Ad") return true;
  }
  // Some variants expose it via aria-label
  if (article.querySelector('[aria-label="Ad" i], [aria-label*="promot" i]')) return true;
  return false;
}

function extractTweetTag(article) {
  // The tweet permalink is always present as an anchor with /status/<id>
  const a = article.querySelector('a[href*="/status/"]');
  if (!a) return null;
  const m = a.getAttribute("href").match(/\/status\/(\d+)/);
  return m ? "tweet:" + m[1] : null;
}

/** textContent-like walker that recovers <img alt="..."> (X uses these for flag emoji, custom emoji).
 * `skipSet` is a Set of elements to treat as opaque (don't descend into, don't emit their text). */
function gatherTextWithImages(root, skipSet) {
  const out = [];
  const walker = (node) => {
    if (skipSet && skipSet.has(node)) return;
    if (node.nodeType === Node.TEXT_NODE) {
      out.push(node.nodeValue || "");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    // Also skip anything we marked as a translation wrapper / failure chip, even
    // if it isn't in skipSet (defense in depth — a dup sneak-in should never
    // pollute the source text fed back to the LLM).
    if (node.classList?.contains("fanyi-translation") ||
        node.classList?.contains("fanyi-failed-msg") ||
        node.hasAttribute?.("data-fanyi-wrapper")) return;
    // <img alt="🇺🇸"> or custom emoji — use alt
    if (node.tagName === "IMG") {
      const alt = node.getAttribute("alt");
      if (alt) out.push(alt);
      return;
    }
    // <br> → newline
    if (node.tagName === "BR") { out.push("\n"); return; }
    for (const c of node.childNodes) walker(c);
  };
  for (const c of root.childNodes) walker(c);
  return out.join("");
}

function tweetTextUnits(article) {
  const units = [];
  const textEl = article.querySelector('[data-testid="tweetText"]');
  if (textEl) {
    // Exclude ALL previously-attached wrappers (and failure chips) from source
    // extraction. A prior bug could leave 2+ wrappers on the same element;
    // using `querySelector` (singular) would only skip the first, and the rest
    // would leak Chinese translation into the 'source' re-sent to the LLM —
    // which is exactly how a single wrapper ends up containing duplicated
    // translation content. `querySelectorAll` is the fix.
    const skipSet = new Set(textEl.querySelectorAll(
      `:scope > .fanyi-translation, :scope > .fanyi-failed-msg, :scope [data-fanyi-wrapper]`
    ));
    const raw = gatherTextWithImages(textEl, skipSet);
    const text = normalizeText(raw);
    if (text.length >= 2) {
      const base = extractTweetTag(article);
      const tag = base ? `${base}:${cheapHash(text)}` : null;
      units.push({ el: textEl, text, tag });
    }
  }
  return units;
}

export function discoverUnits() {
  ensureSubClickHandler();
  const articles = document.querySelectorAll('article[data-testid="tweet"]');
  const units = [];
  for (const a of articles) {
    if (isAdArticle(a)) continue;   // skip promoted tweets entirely
    addSubtitleButton(a);           // mount inline subtitle button on any <video> inside
    units.push(...tweetTextUnits(a));
    const quoted = a.querySelector('div[role="link"] article[role="article"]');
    if (quoted && !isAdArticle(quoted)) units.push(...tweetTextUnits(quoted));
  }
  return units;
}

/** Visible tweets first; bottom-to-top scrolling (common in long threads) is handled the same way. */
export function prioritize(units) {
  const vh = window.innerHeight || 800;
  return units.slice().sort((a, b) => {
    const ra = a.el.getBoundingClientRect();
    const rb = b.el.getBoundingClientRect();
    const onScreenA = ra.top < vh && ra.bottom > 0;
    const onScreenB = rb.top < vh && rb.bottom > 0;
    if (onScreenA !== onScreenB) return onScreenA ? -1 : 1;
    return ra.top - rb.top;
  });
}

/**
 * Watch the timeline. X uses a virtualized list, so we observe the first
 * primary column region instead of the whole body.
 */
export function observe(onNewUnits) {
  const target =
    document.querySelector('[data-testid="primaryColumn"]') ||
    document.querySelector('main') ||
    document.body;
  console.debug("[fanyi xcom] observer target:", target.tagName, target.getAttribute?.("data-testid") || "");

  let pending = null;
  let tickCount = 0;
  const schedule = (reason) => {
    tickCount++;
    if (pending) return;
    pending = requestAnimationFrame(() => {
      pending = null;
      const units = discoverUnits();
      console.debug("[fanyi xcom] schedule fired, reason=%s ticks=%d units=%d", reason, tickCount, units.length);
      tickCount = 0;
      onNewUnits(units);
    });
  };

  const mo = new MutationObserver(() => schedule("mutation"));
  mo.observe(target, { childList: true, subtree: true, characterData: true });
  const onScroll = () => schedule("scroll");
  window.addEventListener("scroll", onScroll, { passive: true, capture: true });

  // Safety: x.com's primaryColumn may not have existed when we subscribed.
  // Re-subscribe once it appears, then stop this fallback.
  const retargetInterval = setInterval(() => {
    const pc = document.querySelector('[data-testid="primaryColumn"]');
    if (pc && pc !== target && target === document.body) {
      mo.disconnect();
      mo.observe(pc, { childList: true, subtree: true, characterData: true });
      console.debug("[fanyi xcom] re-targeted observer to primaryColumn");
      clearInterval(retargetInterval);
      schedule("retarget");
    } else if (pc) {
      clearInterval(retargetInterval);
    }
  }, 1000);

  // Kick off a first scan after a beat in case the initial scan ran before tweets mounted.
  setTimeout(() => schedule("timeout-kick"), 800);

  // X lazy-loads <video> on intersection; observer may fire before video exists in DOM.
  // Periodic kick ensures addSubtitleButton eventually runs for every video.
  const periodicScan = setInterval(() => schedule("periodic"), 2000);

  return () => {
    mo.disconnect();
    window.removeEventListener("scroll", onScroll, { capture: true });
    clearInterval(retargetInterval);
    clearInterval(periodicScan);
  };
}
