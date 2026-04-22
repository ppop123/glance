// Light guard script — runs in every frame at document_start.
// Job: decide if this frame is worth loading the big content_main.js,
// then dynamic-import it via web-accessible module.
//
// Heuristics (cheap, no network):
//   - skip ad/analytics iframes by hostname blocklist
//   - skip cloudflare challenge pages
//   - in cross-origin iframes, skip if viewport is 0x0 or effectively hidden
//   - otherwise, load on-demand when user toggles or site is auto-enabled

(() => {
  const AD_DOMAINS = [
    "doubleclick.net", "googlesyndication.com", "pubmatic.com",
    "openx.net", "adnxs.com", "criteo.com", "taboola.com",
    "outbrain.com", "rubiconproject.com", "3lift.com", "moatads.com",
    "amazon-adsystem.com", "scorecardresearch.com",
  ];

  function inAdFrame() {
    try {
      const h = location.hostname.toLowerCase();
      return AD_DOMAINS.some(d => h === d || h.endsWith("." + d));
    } catch { return true; }
  }

  function inChallenge() {
    try { return location.pathname.includes("/cdn-cgi/challenge-platform/"); }
    catch { return false; }
  }

  function likelyHiddenFrame() {
    if (window.top === window) return false;
    try {
      const fe = window.frameElement;
      if (!fe) return false; // cross-origin: can't tell
      const r = fe.getBoundingClientRect();
      return r.width <= 1 || r.height <= 1;
    } catch { return false; }
  }

  const isTop = window.top === window;
  if (inAdFrame() || inChallenge() || likelyHiddenFrame()) {
    if (isTop) console.info("[fanyi] guard: skipped frame", location.href);
    return;
  }
  if (isTop) console.info("[fanyi] guard active on", location.hostname);

  async function loadMain() {
    if (window.__fanyiMainLoaded) return;
    window.__fanyiMainLoaded = true;
    try {
      const url = chrome.runtime.getURL("src/content_main.js");
      const mod = await import(url);
      await mod.boot();
    } catch (e) {
      console.warn("[fanyi] main load failed", e);
      window.__fanyiMainLoaded = false;
    }
  }

  // Listen for toggle commands from background.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "fanyi:ensure-loaded") {
      loadMain().then(() => sendResponse({ ok: true }));
      return true;
    }
  });

  if (isTop) loadMain();

  // Dev bridge: lets page-world JS (e.g. dev tools) trigger an extension reload
  //   window.postMessage({__fanyi: 'dev-reload'}, '*')
  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__fanyi !== "dev-reload") return;
    chrome.runtime.sendMessage({ type: "fanyi:dev-reload" });
  });
})();
