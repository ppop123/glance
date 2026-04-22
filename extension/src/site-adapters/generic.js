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

/** Observer: DOM mutations trigger re-scan. Returns a disconnect fn. */
export function observe(onNewUnits, opts) {
  const mo = new MutationObserver(() => onNewUnits(discoverUnits()));
  mo.observe(document.body, { childList: true, subtree: true, characterData: true });
  return () => mo.disconnect();
}
