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

export function getConfig()     { return send("/config",     "GET"); }
export function getCacheStats() { return send("/cache/stats","GET"); }
