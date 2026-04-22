import { getConfig, getCacheStats } from "./lib/client.js";

const $ = (s) => document.querySelector(s);
const DEFAULT_URL = "http://127.0.0.1:8787";

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ""; }
}

/* ── tab status / toggle ─────────────────────────────────────────── */

async function refreshStatus() {
  const tab = await currentTab();
  const host = hostOf(tab?.url || "");
  $("#siteName").textContent = host || "—";

  if (!tab?.id || !/^https?:/.test(tab.url || "")) {
    $("#toggleState").textContent = "不可用";
    $("#toggleHint").textContent = "此页面不支持翻译";
    $("#toggle").setAttribute("aria-pressed", "false");
    $("#autoSite").disabled = true;
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: "fanyi:ensure-loaded" });
    const s = await chrome.tabs.sendMessage(tab.id, { type: "fanyi:status" });
    const on = !!s?.enabled;
    $("#toggleState").textContent = on ? "翻译中" : "未翻译";
    $("#toggleHint").textContent  = on ? "点击关闭 · ⌥A" : "点击翻译此页 · ⌥A";
    $("#toggle").setAttribute("aria-pressed", on ? "true" : "false");

    const site = s?.site || host;
    const { autoSites = [] } = await chrome.storage.sync.get({ autoSites: [] });
    $("#autoSite").checked = autoSites.includes(site);
    $("#autoSite").dataset.site = site;
    $("#autoSite").disabled = false;
  } catch {
    $("#toggleState").textContent = "—";
    $("#toggleHint").textContent = "页面未就绪，请刷新";
  }
}

/* ── server status & config sync ─────────────────────────────────── */

async function refreshServer() {
  const dot = $("#serverDot");
  try {
    const c = await getConfig();
    dot.className = "dot ok";
    $("#serverText").textContent = `${c.default_model} → ${c.default_target}`;
    populateModelDropdown(c.providers || [], c.default_model);
    const prefs = await chrome.storage.sync.get({ model: null, targetLang: null });
    $("#model").value = prefs.model || c.default_model;
    $("#targetLang").value = prefs.targetLang || c.default_target;
  } catch (e) {
    dot.className = "dot err";
    $("#serverText").textContent = "服务器连接失败";
  }
  try {
    const s = await getCacheStats();
    const size = s.entries.toLocaleString();
    $("#cacheText").textContent = `缓存：${size} 条 · v${s.glossary_version}`;
  } catch {
    $("#cacheText").textContent = "缓存：—";
  }
}

/* ── handlers ────────────────────────────────────────────────────── */

$("#toggle").addEventListener("click", async () => {
  const tab = await currentTab();
  if (!tab?.id) return;
  await chrome.tabs.sendMessage(tab.id, { type: "fanyi:ensure-loaded" });
  await chrome.tabs.sendMessage(tab.id, { type: "fanyi:toggle" });
  setTimeout(refreshStatus, 150);
});

$("#autoSite").addEventListener("change", async (e) => {
  const site = e.target.dataset.site;
  if (!site) return;
  const { autoSites = [] } = await chrome.storage.sync.get({ autoSites: [] });
  const set = new Set(autoSites);
  e.target.checked ? set.add(site) : set.delete(site);
  await chrome.storage.sync.set({ autoSites: [...set] });
});

$("#targetLang").addEventListener("change", async (e) => {
  await chrome.storage.sync.set({ targetLang: e.target.value });
});

$("#model").addEventListener("change", async (e) => {
  await chrome.storage.sync.set({ model: e.target.value });
});

$("#serverUrl").addEventListener("change", async (e) => {
  await chrome.storage.sync.set({ serverUrl: (e.target.value || DEFAULT_URL).trim() });
  refreshServer();
});

$("#clear").addEventListener("click", async () => {
  try {
    await chrome.runtime.sendMessage({ type: "fanyi:fetch", url: (await getServerUrl()) + "/cache/invalidate", method: "POST", body: {} });
    refreshServer();
  } catch (e) { console.warn(e); }
});

$("#dev-reload").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "fanyi:dev-reload" });
});

$("#open-options").addEventListener("click", () => chrome.runtime.openOptionsPage?.());

$("#sub-go").addEventListener("click", async () => {
  const tab = await currentTab();
  if (!tab?.id) return;
  const seconds = Math.max(5, parseInt($("#subSeconds").value || "60", 10));
  const translate = $("#subTranslate").checked;
  const targetLang = $("#targetLang").value || "zh-CN";
  $("#sub-status").textContent = "已启动 · 请看视频右上角";
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "fanyi:ensure-loaded" });
    const r = await chrome.tabs.sendMessage(tab.id, {
      type: "fanyi:transcribe-video",
      opts: { maxSeconds: seconds, translate, targetLang, showToast: true },
    });
    if (r?.ok) $("#sub-status").textContent = `✓ 已生成 ${r.cues} 条字幕`;
    else $("#sub-status").textContent = `✗ ${r?.err || "失败"}`;
  } catch (e) {
    $("#sub-status").textContent = `✗ ${e?.message || e}`;
  }
});

/** Rebuild the model <select> from server-reported providers. Single-provider
 * case renders flat; multi-provider renders <optgroup> per provider so the
 * user can tell DeepSeek's "chat" from OpenRouter's "chat" at a glance. */
function populateModelDropdown(providers, defaultModel) {
  const sel = $("#model");
  const current = sel.value;
  sel.innerHTML = "";
  if (!providers.length) return;
  const multi = providers.length > 1;
  for (const p of providers) {
    const parent = multi ? (() => {
      const g = document.createElement("optgroup");
      g.label = p.label || p.name;
      sel.appendChild(g);
      return g;
    })() : sel;
    for (const m of (p.models || [])) {
      const opt = document.createElement("option");
      // Always stable provider:model form so the server can route unambiguously.
      opt.value = `${p.name}:${m}`;
      opt.textContent = multi ? m : `${m}`;
      parent.appendChild(opt);
    }
  }
  // Prefer previous user pick → server default → first option.
  const desired = current || defaultModel;
  if (!desired) return;
  let opt = sel.querySelector(`option[value="${CSS.escape(desired)}"]`);
  if (!opt) opt = Array.from(sel.querySelectorAll("option")).find(o => o.value.endsWith(":" + desired));
  if (opt) sel.value = opt.value;
}

async function getServerUrl() {
  const { serverUrl = DEFAULT_URL } = await chrome.storage.sync.get({ serverUrl: DEFAULT_URL });
  return (serverUrl || DEFAULT_URL).replace(/\/$/, "");
}

/* ── boot ────────────────────────────────────────────────────────── */

(async () => {
  const { serverUrl = DEFAULT_URL } = await chrome.storage.sync.get({ serverUrl: DEFAULT_URL });
  $("#serverUrl").value = serverUrl;
  refreshStatus();
  refreshServer();
})();
