const $ = (s) => document.querySelector(s);
const DEFAULT_URL = "http://127.0.0.1:8787";

async function serverFetch(path, init = {}) {
  const { serverUrl = DEFAULT_URL } = await chrome.storage.sync.get({ serverUrl: DEFAULT_URL });
  return fetch((serverUrl || DEFAULT_URL).replace(/\/$/, "") + path, init);
}

async function loadPrefs() {
  const p = await chrome.storage.sync.get({
    serverUrl: DEFAULT_URL,
    targetLang: "zh-CN",
    model: "claude-haiku-4-5",
    autoSites: ["x.com", "twitter.com", "github.com"],
    subDefaultSeconds: 60,
    subBilingual: true,
    subPreferDownload: true,
    glossary: [],
    showFab: true,
  });
  $("#serverUrl").value = p.serverUrl;
  $("#targetLang").value = p.targetLang;
  $("#model").value = p.model;
  $("#autoSites").value = (p.autoSites || []).join("\n");
  $("#subDefaultSeconds").value = p.subDefaultSeconds;
  $("#subBilingual").checked = !!p.subBilingual;
  $("#subPreferDownload").checked = !!p.subPreferDownload;
  $("#glossary").value = (p.glossary || []).map(([src, dst]) => `${src} => ${dst}`).join("\n");
  $("#showFab").checked = p.showFab !== false;
}

/** Parse glossary textarea — lines like "src => dst" or "src → dst". Lenient. */
function parseGlossary(raw) {
  const out = [];
  for (const line of String(raw || "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const m = t.match(/^(.*?)\s*(?:=>|→|->)\s*(.*?)\s*$/);
    if (!m) continue;
    const src = m[1].trim();
    const dst = m[2].trim();
    if (src && dst) out.push([src, dst]);
  }
  return out;
}

function parseAutoSites(raw) {
  return String(raw || "")
    .split(/\r?\n/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

async function save(key, value) {
  await chrome.storage.sync.set({ [key]: value });
}

async function refreshServer() {
  try {
    const r = await serverFetch("/health");
    const j = await r.json();
    $("#serverDot").className = j.ok ? "dot ok" : "dot err";
    $("#serverText").textContent = j.ok ? `服务器就绪 · ${j.model} → ${j.target}` : `服务器错误`;
  } catch {
    $("#serverDot").className = "dot err";
    $("#serverText").textContent = "无法连接服务器";
  }
  try {
    const r = await serverFetch("/asr/health");
    const j = await r.json();
    if (j.ok) {
      $("#asrDot").className = "dot ok";
      $("#asrText").textContent = `ASR 就绪 · ${j.upstream?.model || ""}`;
    } else if (j.reason === "disabled") {
      $("#asrDot").className = "dot";
      $("#asrText").textContent = "ASR 已在 config.yaml 中关闭";
    } else {
      $("#asrDot").className = "dot err";
      $("#asrText").textContent = "无法连接 ASR";
    }
  } catch {
    $("#asrDot").className = "dot err";
    $("#asrText").textContent = "无法连接 ASR";
  }
  try {
    const r = await serverFetch("/cache/stats");
    const s = await r.json();
    $("#cacheSummary").textContent =
      `${s.entries.toLocaleString()} 条 · 词表 v${s.glossary_version} · ${s.db_path}`;
  } catch {
    $("#cacheSummary").textContent = "缓存：—";
  }
}

/* ── bind fields ──────────────────────────────────────────────── */
$("#serverUrl").addEventListener("change", async (e) => {
  await save("serverUrl", e.target.value.trim() || DEFAULT_URL);
  refreshServer();
});
$("#targetLang").addEventListener("change", (e) => save("targetLang", e.target.value));
$("#model").addEventListener("change", (e) => save("model", e.target.value));
$("#autoSites").addEventListener("change", (e) => save("autoSites", parseAutoSites(e.target.value)));
$("#subDefaultSeconds").addEventListener("change", (e) => save("subDefaultSeconds", Math.max(5, parseInt(e.target.value || "60", 10))));
$("#subBilingual").addEventListener("change", (e) => save("subBilingual", e.target.checked));
$("#subPreferDownload").addEventListener("change", (e) => save("subPreferDownload", e.target.checked));
$("#glossary").addEventListener("change", (e) => save("glossary", parseGlossary(e.target.value)));
$("#showFab").addEventListener("change", (e) => save("showFab", e.target.checked));

$("#clearCache").addEventListener("click", async () => {
  try {
    await serverFetch("/cache/invalidate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  } catch (e) { /* ignore */ }
  refreshServer();
});

$("#reload-ext").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "fanyi:dev-reload" });
});

/* ── boot ─────────────────────────────────────────────────────── */
(async () => {
  await loadPrefs();
  const m = chrome.runtime.getManifest();
  $("#extInfo").textContent = `${m.name} v${m.version}`;
  refreshServer();
})();
