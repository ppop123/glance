// Adapter for github.com. Focus on prose surfaces:
//   - issue / PR title and body (.markdown-body within .js-comment-body parent)
//   - comments (.comment-body / .js-comment-body)
//   - README on repo home (.markdown-body)
//   - PR conversation timeline items' text
//   - release notes (.markdown-body under releases)
//
// Skipped automatically by walker: <code>, <pre>, <kbd>, <samp>.
// We also skip file tree, code diffs' code lines, and syntax highlighting spans.

import { findUnits, MARK_ATTR } from "../lib/walker.js";

export const name = "github";
export const site = "github.com";
export const topic = "code";

export function match() {
  return location.hostname.toLowerCase() === "github.com";
}

// Roots where we look for prose
const PROSE_SELECTORS = [
  ".markdown-body",              // README, issue body, release notes
  ".js-comment-body",            // individual comments
  ".comment-body",
  "[data-testid='issue-title']",
  "[data-testid='pull-request-title']",
  ".js-issue-title",             // classic issue/PR titles
  ".gh-header-title",
  ".release-entry",
].join(",");

function gatherRoots() {
  return Array.from(document.querySelectorAll(PROSE_SELECTORS));
}

function tagFor(el) {
  // Use the nearest comment id (github provides stable ids on many timeline items)
  const container = el.closest("[id^='issuecomment-'], [id^='pullrequestreview-'], [id^='discussion_r']");
  if (container && container.id) return "gh:" + container.id;
  return null;
}

export function discoverUnits() {
  const units = findUnits(gatherRoots());
  for (const u of units) {
    u.tag = tagFor(u.el);
  }
  return units;
}

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

export function observe(onNewUnits) {
  // GitHub uses both Turbo (classic) and a React app (newer issue/PR pages).
  // React often mounts content async after navigation; rely on MutationObserver + polling fallback.
  let pending = null;
  let tickCount = 0;
  const schedule = (reason) => {
    tickCount++;
    if (pending) return;
    pending = requestAnimationFrame(() => {
      pending = null;
      const units = discoverUnits();
      console.info("[fanyi gh] schedule reason=%s ticks=%d units=%d", reason, tickCount, units.length);
      tickCount = 0;
      onNewUnits(units);
    });
  };

  const mo = new MutationObserver(() => schedule("mutation"));
  const attachTo = document.body || document.documentElement;
  mo.observe(attachTo, { childList: true, subtree: true, characterData: true });
  document.addEventListener("turbo:render", () => schedule("turbo"));
  document.addEventListener("pjax:end", () => schedule("pjax"));
  // If we attached to documentElement because body wasn't ready yet, re-target once body exists.
  let rebindInterval = null;
  if (attachTo !== document.body) {
    rebindInterval = setInterval(() => {
      if (document.body) {
        mo.disconnect();
        mo.observe(document.body, { childList: true, subtree: true, characterData: true });
        clearInterval(rebindInterval);
        rebindInterval = null;
        schedule("body-ready");
      }
    }, 200);
  }

  // SPA navigation watcher (React router doesn't emit turbo events)
  let lastUrl = location.href;
  const urlInterval = setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      schedule("url-change");
    }
  }, 500);

  // Safety kick at 1s, 2s, 4s — React often takes a few hundred ms to mount
  const kicks = [1000, 2000, 4000].map(ms => setTimeout(() => schedule("kick-" + ms), ms));

  return () => {
    mo.disconnect();
    clearInterval(urlInterval);
    if (rebindInterval) clearInterval(rebindInterval);
    kicks.forEach(clearTimeout);
  };
}
