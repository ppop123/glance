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

/* ── hero toggle rendering ──────────────────────────────────────── */

function renderToggle(on, { ready = true } = {}) {
  const btn = $("#toggle");
  const primary = btn.querySelector(".primary");
  const secLabel = btn.querySelector(".sec-label");
  btn.setAttribute("aria-pressed", on ? "true" : "false");
  btn.classList.toggle("on", !!on);
  btn.classList.toggle("unavailable", !ready);
  if (!ready) {
    primary.textContent = "此页面不支持翻译";
    secLabel.textContent = "";
    return;
  }
  primary.textContent = on ? primary.dataset.on : primary.dataset.off;
  secLabel.textContent = on ? "" : "快捷键";
}

/* ── tab status / toggle ─────────────────────────────────────────── */

async function refreshStatus() {
  const tab = await currentTab();
  const host = hostOf(tab?.url || "");
  $("#host").textContent = host || "—";

  if (!tab?.id || !/^https?:/.test(tab.url || "")) {
    renderToggle(false, { ready: false });
    $("#autoSite").disabled = true;
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: "fanyi:ensure-loaded" });
    const s = await chrome.tabs.sendMessage(tab.id, { type: "fanyi:status" });
    const on = !!s?.enabled;
    renderToggle(on);

    const site = s?.site || host;
    const { autoSites = [] } = await chrome.storage.sync.get({ autoSites: [] });
    $("#autoSite").checked = autoSites.includes(site);
    $("#autoSite").dataset.site = site;
    $("#autoSite").disabled = false;
  } catch {
    renderToggle(false, { ready: false });
  }
}

/* ── server status & config sync ─────────────────────────────────── */

let _providers = [];

async function refreshServer() {
  const dot = $("#serverDot");
  try {
    const c = await getConfig();
    dot.className = "dot ok";
    $("#serverText").innerHTML = `<code>${escHtml(c.default_model)}</code> → <code>${escHtml(c.default_target)}</code>`;
    _providers = c.providers || [];
    const prefs = await chrome.storage.sync.get({ model: null, targetLang: null });
    populateProviderAndModel(prefs.model || c.default_model);
    $("#targetLang").value = prefs.targetLang || c.default_target;
  } catch {
    dot.className = "dot err";
    $("#serverText").textContent = "服务器连接失败";
  }
  try {
    const s = await getCacheStats();
    $("#cache-count").textContent = (s.entries || 0).toLocaleString();
    $("#cache-ver").textContent = `v${s.glossary_version}`;
  } catch {
    $("#cache-count").textContent = "—";
    $("#cache-ver").textContent = "";
  }
}

function escHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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

$("#provider").addEventListener("change", async (e) => {
  const p = _providers.find((x) => x.name === e.target.value);
  renderModelsForProvider(p, null);
  const firstModel = $("#model").value;
  if (firstModel) await chrome.storage.sync.set({ model: firstModel });
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
$("#open-options-top")?.addEventListener("click", () => chrome.runtime.openOptionsPage?.());

// Advanced disclosure: reveals the server URL input.
$("#adv-toggle").addEventListener("click", () => {
  const panel = $("#adv-panel");
  const open = panel.classList.toggle("open");
  $("#adv-toggle").setAttribute("aria-expanded", String(open));
});

// Live sub-status label reflecting the seconds input.
$("#subSeconds").addEventListener("input", () => {
  const n = Math.max(5, Math.min(600, Number($("#subSeconds").value) || 60));
  $("#sub-status").innerHTML = `<span>准备就绪 · 点击开始将转录当前视频的前 ${n} 秒</span>`;
});

$("#sub-go").addEventListener("click", async () => {
  const tab = await currentTab();
  if (!tab?.id) return;
  const seconds = Math.max(5, parseInt($("#subSeconds").value || "60", 10));
  const translate = $("#subTranslate").checked;
  const targetLang = $("#targetLang").value || "zh-CN";
  $("#sub-status").innerHTML = "<span>已启动 · 请看视频右上角</span>";
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "fanyi:ensure-loaded" });
    const r = await chrome.tabs.sendMessage(tab.id, {
      type: "fanyi:transcribe-video",
      opts: { maxSeconds: seconds, translate, targetLang, showToast: true },
    });
    if (r?.ok) $("#sub-status").innerHTML = `<span>✓ 已生成 ${r.cues} 条字幕</span>`;
    else $("#sub-status").innerHTML = `<span>✗ ${escHtml(r?.err || "失败")}</span>`;
  } catch (e) {
    $("#sub-status").innerHTML = `<span>✗ ${escHtml(e?.message || String(e))}</span>`;
  }
});

/** Populate provider + model selects from the server's /config list. */
function populateProviderAndModel(desired) {
  const provSel = $("#provider");
  provSel.innerHTML = "";
  for (const p of _providers) {
    const o = document.createElement("option");
    o.value = p.name;
    o.textContent = p.label || p.name;
    provSel.appendChild(o);
  }
  const [wantedProv, wantedModel] = (desired || "").split(":");
  const pickedProv = _providers.find((p) => p.name === wantedProv) || _providers[0];
  if (pickedProv) provSel.value = pickedProv.name;
  renderModelsForProvider(pickedProv, wantedModel || (desired && !desired.includes(":") ? desired : null));
}

function renderModelsForProvider(provider, desiredModel) {
  const mSel = $("#model");
  mSel.innerHTML = "";
  if (!provider) return;
  for (const m of (provider.models || [])) {
    const o = document.createElement("option");
    o.value = `${provider.name}:${m}`;
    o.textContent = m;
    mSel.appendChild(o);
  }
  if (desiredModel) {
    const hit = Array.from(mSel.querySelectorAll("option")).find(
      (o) => o.value === `${provider.name}:${desiredModel}` || o.value.endsWith(":" + desiredModel)
    );
    if (hit) mSel.value = hit.value;
  }
}

async function getServerUrl() {
  const { serverUrl = DEFAULT_URL } = await chrome.storage.sync.get({ serverUrl: DEFAULT_URL });
  return (serverUrl || DEFAULT_URL).replace(/\/$/, "");
}

/* ── boot ────────────────────────────────────────────────────────── */

(async () => {
  const { serverUrl = DEFAULT_URL } = await chrome.storage.sync.get({ serverUrl: DEFAULT_URL });
  $("#serverUrl").value = serverUrl;
  renderToggle(false);
  refreshStatus();
  refreshServer();
})();
