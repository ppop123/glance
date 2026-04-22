// Client wrapper for fanyi-server. All network goes via background service worker
// to bypass mixed-content / Private Network Access restrictions from https pages
// targeting http://127.0.0.1.

const DEFAULT_BASE = "http://127.0.0.1:8787";

async function send(path, method, body) {
  const { serverUrl = DEFAULT_BASE } = await chrome.storage.sync.get({ serverUrl: DEFAULT_BASE });
  const resp = await chrome.runtime.sendMessage({
    type: "fanyi:fetch",
    url: (serverUrl || DEFAULT_BASE).replace(/\/$/, "") + path,
    method,
    body,
  });
  if (!resp) throw new Error("no response from background");
  if (!resp.ok) throw new Error(resp.error || `http ${resp.status}`);
  return resp.data;
}

export function translateBatch(items, { site = null, topic = null, model = null, target = null, signal = null } = {}) {
  // signal is ignored — background cannot be AbortController'd cross-message yet.
  const payload = items.map(x => typeof x === "string" ? { text: x } : x);
  return send("/translate", "POST", { items: payload, site, topic, model, target_lang: target });
}

/**
 * Streaming translate. Opens a chrome.runtime.Port to the background SW which fetches
 * `/translate/stream` (SSE) and relays each batch back. `onChunk` fires for every
 * {items: [...]} event. Pass `signal` (AbortSignal) to cancel.
 */
export function translateStream(items, { site = null, topic = null, model = null, target = null, onChunk = null, signal = null } = {}) {
  return new Promise(async (resolve, reject) => {
    const { serverUrl = DEFAULT_BASE } = await chrome.storage.sync.get({ serverUrl: DEFAULT_BASE });
    const url = (serverUrl || DEFAULT_BASE).replace(/\/$/, "") + "/translate/stream";
    const payload = items.map(x => typeof x === "string" ? { text: x } : x);

    const port = chrome.runtime.connect({ name: "fanyi-translate-stream" });
    let settled = false;
    const settle = (fn, val) => { if (settled) return; settled = true; fn(val); };

    const onAbort = () => {
      try { port.disconnect(); } catch {}
      settle(resolve, { aborted: true });
    };
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    port.onMessage.addListener((msg) => {
      if (!msg) return;
      if (msg.type === "chunk") { try { onChunk?.(msg.data); } catch (e) { console.warn("[fanyi] onChunk threw", e); } return; }
      if (msg.type === "done")  { settle(resolve, {}); try { port.disconnect(); } catch {} return; }
      if (msg.type === "error") { settle(reject, new Error(msg.error || "stream error")); try { port.disconnect(); } catch {} return; }
    });
    port.onDisconnect.addListener(() => {
      if (settled) return;
      const err = chrome.runtime.lastError;
      settle(err ? reject : resolve, err ? new Error(err.message || "port disconnected") : {});
    });

    port.postMessage({
      type: "start",
      url,
      body: { items: payload, site, topic, model, target_lang: target },
    });
  });
}

export function getConfig()     { return send("/config",     "GET"); }
export function getCacheStats() { return send("/cache/stats","GET"); }
