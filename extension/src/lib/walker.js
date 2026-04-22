// Generic DOM walker — yields translatable "paragraph" units.
// Ideas borrowed from Immersive Translate but much simpler.
//
// A unit is the smallest block-like element that contains one coherent piece of text.
// We detect it by walking up from text nodes until we hit a block element OR an atomic
// inline-block wrapper.

const BLOCK_TAGS = new Set([
  "P","DIV","LI","DT","DD","BLOCKQUOTE","ARTICLE","SECTION","ASIDE","HEADER","FOOTER",
  "H1","H2","H3","H4","H5","H6","TD","TH","FIGCAPTION","SUMMARY","DETAILS","MAIN",
]);

const SKIP_TAGS = new Set([
  "SCRIPT","STYLE","NOSCRIPT","CODE","PRE","KBD","SAMP","TT","VAR",
  "SVG","CANVAS","IMG","VIDEO","AUDIO","IFRAME","TEXTAREA","INPUT","SELECT",
  "BUTTON","MATH","TIME",
]);

// ignore nodes inside these structural containers (often UI noise)
const SKIP_SELECTORS = [
  "[contenteditable='true']",
  "[data-fanyi-wrapper]",
  "[data-fanyi-skip]",
  // placeholders & toasts on many sites
  "[role='tooltip']",
];

export const MARK_ATTR = "data-fanyi-id";
export const SRC_HASH_ATTR = "data-fanyi-src";    // short hash of the last-translated source text
export const WRAPPER_TAG = "font";
export const WRAPPER_CLASS = "fanyi-translation";
export const LOADING_CLASS = "fanyi-loading";

// djb2 — small, fast, collision-resistant enough for "has the text changed?"
export function cheapHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Very fast "is this text mostly in target language already" check.
 * Conservative: only returns true for obvious same-language cases so we don't skip mixed text. */
export function sameLanguageAs(text, targetLang) {
  if (!text || !targetLang) return false;
  const sample = text.slice(0, 300);
  const total = sample.replace(/\s/g, "").length;
  if (total < 4) return true;  // too short to bother

  if (targetLang.startsWith("zh")) {
    const han    = (sample.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
    const kana   = (sample.match(/[\u3040-\u309f\u30a0-\u30ff]/g) || []).length;
    const hangul = (sample.match(/[\uac00-\ud7a3]/g) || []).length;
    // Kana or Hangul present → Japanese/Korean, not Chinese. Must translate.
    // Use >=2% threshold so a single quoted kana inside a Chinese tweet still counts as Chinese.
    if (kana / total >= 0.02) return false;
    if (hangul / total >= 0.02) return false;
    return han / total >= 0.3;
  }
  if (targetLang === "ja") {
    const kana = (sample.match(/[\u3040-\u30ff]/g) || []).length;
    return kana / total > 0.1;
  }
  if (targetLang === "ko") {
    const hangul = (sample.match(/[\uac00-\ud7a3]/g) || []).length;
    return hangul / total > 0.3;
  }
  if (targetLang === "en") {
    const latin = (sample.match(/[A-Za-z]/g) || []).length;
    const han = (sample.match(/[\u4e00-\u9fff]/g) || []).length;
    return latin / total > 0.8 && han === 0;
  }
  return false;
}

export function isSkippable(el) {
  if (!el || !(el instanceof Element)) return true;
  if (SKIP_TAGS.has(el.tagName)) return true;
  for (const s of SKIP_SELECTORS) {
    if (el.closest(s)) return true;
  }
  // don't translate our own output
  if (el.classList.contains(WRAPPER_CLASS)) return true;
  return false;
}

/** Normalize extracted text: collapse horizontal whitespace only, preserve \n paragraph structure. */
export function normalizeText(s) {
  return (s || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")       // collapse horizontal runs → single space
    .replace(/ *\n */g, "\n")          // trim spaces around line breaks
    .replace(/\n{3,}/g, "\n\n")        // cap blank lines at 1
    .trim();
}

function isAllPunctOrShort(s) {
  const t = s.trim();
  if (t.length < 2) return true;
  // e.g., "· · ·", "...", numbers only, emoji-only
  if (/^[\s\p{P}\p{S}\p{N}]+$/u.test(t)) return true;
  return false;
}

function nearestBlock(node) {
  let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  while (el && el !== document.body) {
    if (BLOCK_TAGS.has(el.tagName)) return el;
    el = el.parentElement;
  }
  return el || document.body;
}

/**
 * Find translatable units inside `root`. Default: whole page body.
 * Callers may pass a site-adapter-provided list of roots (e.g., tweet articles).
 *
 * Returns: Array<{el: Element, text: string}>
 */
export function findUnits(roots = [document.body]) {
  const units = [];
  const seenBlocks = new WeakSet();

  for (const root of roots) {
    if (!root || !(root instanceof Element)) continue;
    if (isSkippable(root)) continue;

    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const t = node.nodeValue;
          if (!t || isAllPunctOrShort(t)) return NodeFilter.FILTER_REJECT;
          const parent = node.parentElement;
          if (!parent || isSkippable(parent)) return NodeFilter.FILTER_REJECT;
          // skip nodes that look like injected translation output
          if (parent.closest("[data-fanyi-wrapper]")) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      },
    );
    let n;
    while ((n = walker.nextNode())) {
      const block = nearestBlock(n);
      if (!block || seenBlocks.has(block)) continue;
      if (block.hasAttribute(MARK_ATTR)) continue;
      const text = normalizeText(block.textContent);
      if (text.length < 2) continue;
      if (isAllPunctOrShort(text)) continue;
      seenBlocks.add(block);
      units.push({ el: block, text });
    }
  }
  return units;
}

let idCounter = 1;
export function markUnit(el, srcText = null) {
  if (!el.hasAttribute(MARK_ATTR)) {
    el.setAttribute(MARK_ATTR, "u" + (idCounter++));
  }
  if (srcText != null) {
    el.setAttribute(SRC_HASH_ATTR, cheapHash(srcText));
  }
  return el.getAttribute(MARK_ATTR);
}

/** Check whether a previously-marked element now has *different* text. */
export function isStale(el, currentText) {
  const prev = el.getAttribute(SRC_HASH_ATTR);
  if (!prev) return false;
  return cheapHash(currentText) !== prev;
}

/** Remove the translation wrapper and clear marks so the unit will be re-translated. */
export function clearUnit(el) {
  const w = el.querySelector(`:scope > .${WRAPPER_CLASS}`);
  if (w) w.remove();
  el.removeAttribute(SRC_HASH_ATTR);
  // keep MARK_ATTR so idCounter stays stable; the stale check forces re-queue
}

/** Insert a spinner placeholder while a batch is in flight. Replaced by appendTranslation on success. */
export function appendLoading(el) {
  if (el.querySelector(`:scope > .${WRAPPER_CLASS}`)) return;
  const wrap = document.createElement(WRAPPER_TAG);
  wrap.className = `${WRAPPER_CLASS} ${LOADING_CLASS}`;
  wrap.setAttribute("data-fanyi-wrapper", "1");
  wrap.setAttribute("role", "status");
  wrap.setAttribute("aria-label", "翻译中");
  wrap.textContent = "翻译中";
  el.appendChild(wrap);
}

export function clearLoading(el) {
  const w = el.querySelector(`:scope > .${WRAPPER_CLASS}.${LOADING_CLASS}`);
  if (w) w.remove();
}

/**
 * Insert translation after the original block.
 * Uses a <font> wrapper (same trick as Immersive Translate — zero default styling).
 */
export function appendTranslation(el, translated) {
  if (!translated || !translated.trim()) return;
  // Remove prior translation if any
  const existing = el.querySelector(`:scope > .${WRAPPER_CLASS}`);
  if (existing) existing.remove();

  const wrap = document.createElement(WRAPPER_TAG);
  wrap.className = WRAPPER_CLASS;
  wrap.setAttribute("data-fanyi-wrapper", "1");
  wrap.textContent = translated;
  el.appendChild(wrap);
}

export function removeAllTranslations(root = document.body) {
  root.querySelectorAll(`.${WRAPPER_CLASS}`).forEach(n => n.remove());
  root.querySelectorAll(`[${MARK_ATTR}]`).forEach(n => n.removeAttribute(MARK_ATTR));
}
