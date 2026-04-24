// Default adapter used when no site-specific module matches.
// Translates the whole <body> lazily, prioritizing what's in the viewport.

import { findUnits } from "../lib/walker.js";

export const name = "generic";
export const site = null;

export function match() { return true; }

export function discoverUnits() {
  return findUnits([document.body]);
}

/** Sort by document order (top-to-bottom). The viewport-gate in
 * content_main.translateUnits() already narrows candidates to items near
 * the user's current scroll; within that window, strict DOM order matches
 * how people actually read (from the top of whatever section they're on).
 *
 * Earlier we sorted by "viewport distance" — on-screen first, then
 * below-viewport by increasing distance, then above-viewport last. That
 * fought the user's mental model: after scrolling down then back up, the
 * queue was full of middle-of-doc items scheduled first, and the top
 * comments stayed untranslated for tens of seconds. DOM order makes
 * progress visibly propagate from wherever the user currently is, always
 * forward in reading direction.
 */
export function prioritize(units) {
  return units.slice().sort((a, b) => {
    const ra = a.el.getBoundingClientRect();
    const rb = b.el.getBoundingClientRect();
    return ra.top - rb.top;   // same scrollY for both → equivalent to doc order
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
