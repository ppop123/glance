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
  "SCRIPT","STYLE","NOSCRIPT",
  "SVG","CANVAS","IMG","VIDEO","AUDIO","IFRAME","TEXTAREA","INPUT","SELECT",
  "BUTTON","MATH","TIME",
]);

// Code-like elements — their text is passed through the LLM wrapped in backticks
// (single for inline, triple for block). The prompt instructs the model to leave
// backtick-enclosed spans verbatim. This keeps prose around code translatable
// while not mangling identifiers, CLI flags, etc.
const INLINE_CODE_TAGS = new Set(["CODE","KBD","SAMP","TT","VAR"]);
const BLOCK_CODE_TAGS = new Set(["PRE"]);

// ignore nodes inside these structural containers (often UI noise)
const SKIP_SELECTORS = [
  "[contenteditable='true']",
  "[data-fanyi-wrapper]",
  "[data-fanyi-skip]",
  // placeholders & toasts on many sites
  "[role='tooltip']",
  // Navigation menus: sidebar items are short link labels packed into a narrow
  // column. Translating them produces CJK that wraps mid-word, stacking each
  // char on its own line (see Wikipedia Vector skin sidebar). Same story for
  // language pickers, table-of-contents bars, etc. The main content is what
  // matters; menu labels almost never are.
  "nav",
  "[role='navigation']",
  ".sidebar",
  ".navbox",
  ".vector-menu",
  ".vector-main-menu-landmark",
  ".interlanguage-link",
  ".interlanguage-link-target",
  ".mw-portlet",
];

export const MARK_ATTR = "data-fanyi-id";
export const SRC_HASH_ATTR = "data-fanyi-src";    // short hash of the last-translated source text
export const WRAPPER_TAG = "font";
export const WRAPPER_CLASS = "fanyi-translation";

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

/** `display:none` / `visibility:hidden` / ancestor with 0 bounding box.
 * Called only on the nearestBlock (not per text node) since getComputedStyle
 * is ~10μs and we want to batch the cost. Collapsed ancestors are found
 * cheaply via offsetParent === null. */
export function isHiddenBlock(el) {
  if (!el || !(el instanceof Element)) return true;
  // offsetParent === null catches display:none AND detached-from-flow ancestors.
  // Exception: position:fixed and <body> have offsetParent===null legitimately.
  if (el.offsetParent === null) {
    const cs = getComputedStyle(el);
    if (cs.position !== "fixed" && cs.position !== "sticky") return true;
    if (cs.display === "none") return true;
  }
  // visibility:hidden keeps layout but not painted — we don't want to pay to
  // translate what the user can't see.
  const vs = getComputedStyle(el).visibility;
  if (vs === "hidden" || vs === "collapse") return true;
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

/** Walk a block subtree and build text with semantic markers:
 *   - <code>foo</code> → `foo` (inline, single backticks)
 *   - <pre>...</pre>   → ```\n...\n``` (fenced block)
 *   - <br>             → "\n"
 *   - <img alt="..">   → alt text (emoji shortcuts, flags, etc.)
 *   - children of SKIP_TAGS / SKIP_SELECTORS contribute nothing. */
function extractBlockText(block) {
  const out = [];
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out.push(node.nodeValue || "");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.tagName;
    if (SKIP_TAGS.has(tag)) return;
    for (const s of SKIP_SELECTORS) {
      if (node.matches && node.matches(s)) return;
    }
    if (node.classList && node.classList.contains(WRAPPER_CLASS)) return;
    if (tag === "IMG") {
      const alt = node.getAttribute("alt");
      if (alt) out.push(alt);
      return;
    }
    if (tag === "BR") { out.push("\n"); return; }
    if (INLINE_CODE_TAGS.has(tag)) {
      out.push("`");
      for (const c of node.childNodes) walk(c);
      out.push("`");
      return;
    }
    if (BLOCK_CODE_TAGS.has(tag)) {
      out.push("\n```\n");
      for (const c of node.childNodes) walk(c);
      out.push("\n```\n");
      return;
    }
    for (const c of node.childNodes) walk(c);
  };
  for (const c of block.childNodes) walk(c);
  return out.join("");
}

/** Pull a short disambiguation hint from the element's surroundings.
 * Looks at: nearest section heading (h1..h6), enclosing table caption, parent
 * <th>/<dt> label, or infobox section header. Returns a compact string or "".
 */
function findContextHint(el) {
  const parts = [];
  // 1. If we're inside a <td>, the row's <th> or first <td> is a label.
  const tr = el.closest("tr");
  if (tr) {
    const th = tr.querySelector("th");
    const rowLabel = th && th !== el && !th.contains(el) ? th.textContent : null;
    if (rowLabel) parts.push(rowLabel.trim().slice(0, 40));
    const cap = el.closest("table")?.querySelector("caption");
    if (cap) parts.push(cap.textContent.trim().slice(0, 40));
  }
  // 2. Nearest preceding heading within the same section/article.
  const section = el.closest("section, article, [role='region'], .infobox, .mw-body-content") || document.body;
  let scan = el;
  while (scan && scan !== section) {
    let prev = scan.previousElementSibling;
    while (prev) {
      if (/^H[1-6]$/.test(prev.tagName)) {
        const head = prev.textContent.trim().slice(0, 60);
        if (head) parts.push(head);
        scan = section;  // done
        break;
      }
      prev = prev.previousElementSibling;
    }
    scan = scan.parentElement;
  }
  // 3. De-dup and keep it short — tokens cost money.
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    const s = p.replace(/\s+/g, " ").trim();
    if (s && !seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out.slice(0, 2).join(" · ").slice(0, 80);
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
      seenBlocks.add(block);  // memoize regardless of keep/skip decision
      if (isHiddenBlock(block)) continue;  // invisible → don't spend tokens
      const text = normalizeText(extractBlockText(block));
      if (text.length < 2) continue;
      if (isAllPunctOrShort(text)) continue;
      const unit = { el: block, text };
      // For very short items, ambiguous terms ("Body", "Head", "List") lean on
      // surrounding context. Attach a short hint pulled from the nearest
      // ancestor heading / table caption / infobox section so the LLM can
      // disambiguate. Long items don't need it.
      if (text.length <= 40) {
        const ctx = findContextHint(block);
        if (ctx) unit.context = ctx;
      }
      units.push(unit);
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
  // Sweep ALL wrapper + failure-chip siblings, not just the first. A race
  // (React re-render, concurrent dispatch, stale cache on model-switch) can
  // leave more than one behind — querySelector('...') misses the extras.
  el.querySelectorAll(`:scope > .${WRAPPER_CLASS}, :scope > .fanyi-failed-msg`).forEach(n => n.remove());
  el.removeAttribute(SRC_HASH_ATTR);
  // keep MARK_ATTR so idCounter stays stable; the stale check forces re-queue
}

/**
 * Insert translation after the original block.
 * Uses a <font> wrapper (same trick as Immersive Translate — zero default styling).
 */
export function appendTranslation(el, translated) {
  if (!translated || !translated.trim()) return;
  // Remove ALL prior wrappers + any failure chip. The duplicate-translation
  // regression this catches: user switches model while old wrappers are still
  // in the DOM, then a re-scan or scroll event fires a fresh translate call
  // that goes through here — without this, stacks 2+ wrappers.
  el.querySelectorAll(`:scope > .${WRAPPER_CLASS}, :scope > .fanyi-failed-msg`).forEach(n => n.remove());

  const wrap = document.createElement(WRAPPER_TAG);
  wrap.className = WRAPPER_CLASS;
  wrap.setAttribute("data-fanyi-wrapper", "1");
  wrap.textContent = translated;
  el.appendChild(wrap);
}

export function removeAllTranslations(root = document.body) {
  // Kill any translation wrappers AND the failure-chip we render when a block
  // has exhausted retries. The chip is a sibling, not a child, of the marker.
  root.querySelectorAll(`.${WRAPPER_CLASS}, .fanyi-failed-msg`).forEach(n => n.remove());
  root.querySelectorAll(
    `[${MARK_ATTR}], [${SRC_HASH_ATTR}], [data-fanyi-fail]`
  ).forEach(n => {
    n.removeAttribute(MARK_ATTR);
    n.removeAttribute(SRC_HASH_ATTR);
    n.removeAttribute("data-fanyi-fail");
  });
}
