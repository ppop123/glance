// Default adapter used when no site-specific module matches.
// Translates the whole <body> lazily, prioritizing what's in the viewport.

import { findUnits } from "../lib/walker.js";

export const name = "generic";
export const site = null;

export function match() { return true; }

export function discoverUnits() {
  return findUnits([document.body]);
}

/** Sort by viewport distance so visible content gets translated first. */
export function prioritize(units) {
  const vh = window.innerHeight || 800;
  return units.slice().sort((a, b) => {
    const ra = a.el.getBoundingClientRect();
    const rb = b.el.getBoundingClientRect();
    const keyA = ra.top < 0 ? 2000 + Math.abs(ra.top) : ra.top;
    const keyB = rb.top < 0 ? 2000 + Math.abs(rb.top) : rb.top;
    return keyA - keyB;
  });
}

/** Observer: DOM mutations AND scroll both trigger re-scan. The scroll path
 * is essential for static-HTML pages (Hacker News, Reddit's old UI, plain
 * news articles) where ALL content is in the DOM from first paint — without
 * a scroll listener, units far below the initial viewport stay deferred
 * forever by the viewport-gate in content_main.translateUnits(). Throttled
 * via rAF so fast-scroll spam doesn't fire a thousand discoverUnits calls. */
export function observe(onNewUnits, opts) {
  let pending = null;
  const schedule = () => {
    if (pending) return;
    pending = requestAnimationFrame(() => {
      pending = null;
      onNewUnits(discoverUnits());
    });
  };
  const mo = new MutationObserver(schedule);
  mo.observe(document.body, { childList: true, subtree: true, characterData: true });
  window.addEventListener("scroll", schedule, { passive: true, capture: true });
  // Safety timer — if the page is wholly static and scroll events happen to
  // be swallowed by a nested scroll container, the periodic sweep still
  // catches any deferred units the user has since scrolled near.
  const periodic = setInterval(schedule, 2000);
  return () => {
    mo.disconnect();
    window.removeEventListener("scroll", schedule, { capture: true });
    clearInterval(periodic);
  };
}
