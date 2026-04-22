// MV3 service worker.
// Two jobs: forward keyboard commands, and proxy all HTTP for content scripts
// (content-world fetch to http://127.0.0.1 is blocked from https pages by mixed-content rules).

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "fanyi:open-options") {
    chrome.runtime.openOptionsPage?.();
    sendResponse({ ok: true });
    return true;
  }
  if (msg?.type === "fanyi:dev-reload") {
    sendResponse({ ok: true });
    setTimeout(() => chrome.runtime.reload(), 50);
    return true;
  }
  if (msg?.type === "fanyi:upload-audio") {
    (async () => {
      try {
        const bytes = new Uint8Array(msg.data);
        const blob = new Blob([bytes], { type: msg.mime || "audio/webm" });
        const fd = new FormData();
        fd.append("file", blob, "audio.webm");
        fd.append("task", "transcribe");
        if (msg.language) fd.append("language", msg.language);
        const r = await fetch(msg.url, { method: "POST", body: fd });
        const text = await r.text();
        let data; try { data = JSON.parse(text); } catch { data = text; }
        if (!r.ok) sendResponse({ ok: false, error: typeof data === "string" ? data : JSON.stringify(data) });
        else sendResponse({ ok: true, data });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }
  if (msg?.type !== "fanyi:fetch") return false;
  (async () => {
    try {
      const init = { method: msg.method || "GET" };
      if (msg.body != null) {
        init.headers = { "content-type": "application/json" };
        init.body = JSON.stringify(msg.body);
      }
      const r = await fetch(msg.url, init);
      const text = await r.text();
      let data; try { data = JSON.parse(text); } catch { data = text; }
      if (!r.ok) {
        sendResponse({ ok: false, status: r.status, error: typeof data === "string" ? data : JSON.stringify(data) });
      } else {
        sendResponse({ ok: true, status: r.status, data });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true; // async
});

// Long-lived port for /translate/stream. Content script opens one port per stream, posts
// `{type:"start",url,body}`, and receives `{type:"chunk",data}`, `{type:"done"}`, or
// `{type:"error",error}` messages as the SSE response is parsed here.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "fanyi-translate-stream") return;
  let aborted = false;
  let reader = null;
  port.onDisconnect.addListener(() => {
    aborted = true;
    reader?.cancel().catch(() => {});
  });
  port.onMessage.addListener(async (msg) => {
    if (msg?.type !== "start") return;
    try {
      const resp = await fetch(msg.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(msg.body),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        if (!aborted) port.postMessage({ type: "error", error: `http ${resp.status}: ${text.slice(0, 200)}` });
        return;
      }
      reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() || "";
        for (const ev of events) {
          const line = ev.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") {
            if (!aborted) port.postMessage({ type: "done" });
            return;
          }
          try {
            const data = JSON.parse(payload);
            if (!aborted) port.postMessage({ type: "chunk", data });
          } catch { /* ignore malformed chunk */ }
        }
      }
      if (!aborted) port.postMessage({ type: "done" });
    } catch (e) {
      if (!aborted) port.postMessage({ type: "error", error: String(e?.message || e) });
    }
  });
});

async function toggleActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:/.test(tab.url || "")) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "fanyi:ensure-loaded" });
    await chrome.tabs.sendMessage(tab.id, { type: "fanyi:toggle" });
  } catch (e) {
    console.warn("[fanyi bg] cannot reach tab", tab.id, e);
  }
}

chrome.commands.onCommand.addListener((cmd) => {
  if (cmd === "toggle-translate") toggleActiveTab();
});

// Right-click → "翻译此页（临时）". One-shot translation without touching autoSites.
const CTX_MENU_ID = "fanyi-translate-page";
function ensureContextMenu() {
  // Recreate on every SW boot; ignore "already exists" errors.
  chrome.contextMenus.create(
    {
      id: CTX_MENU_ID,
      title: "翻译此页（临时）",
      contexts: ["page", "selection", "link"],
      documentUrlPatterns: ["http://*/*", "https://*/*"],
    },
    () => void chrome.runtime.lastError,  // swallow "duplicate id" on reload
  );
}
chrome.runtime.onInstalled.addListener(ensureContextMenu);
chrome.runtime.onStartup.addListener(ensureContextMenu);

chrome.contextMenus.onClicked.addListener((info, _tab) => {
  if (info.menuItemId === CTX_MENU_ID) toggleActiveTab();
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === "install") {
    // sane defaults
    await chrome.storage.sync.set({
      serverUrl: "http://127.0.0.1:8787",
      autoSites: ["x.com", "twitter.com", "github.com"],
    });
  }
});
