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

/** PDF URLs: arxiv /pdf/<id>, plain /foo.pdf, data-URI/blob: excluded.
 * Chrome's built-in PDF viewer sits inside a <embed> that content scripts
 * can't reach — the popup-triggered redirect to our own bilingual viewer is
 * the only way to translate these. */
function isPdfTab(tab) {
  const u = tab?.url || "";
  if (!/^https?:\/\//.test(u)) return false;
  try {
    const parsed = new URL(u);
    const path = parsed.pathname.toLowerCase();
    if (path.endsWith(".pdf")) return true;
    // arxiv.org/pdf/<id> (no extension) → .pdf path segment
    if (parsed.hostname.endsWith("arxiv.org") && path.startsWith("/pdf/")) return true;
    return false;
  } catch { return false; }
}

async function getServerUrlSync() {
  const { serverUrl = DEFAULT_URL } = await chrome.storage.sync.get({ serverUrl: DEFAULT_URL });
  return (serverUrl || DEFAULT_URL).replace(/\/$/, "");
}

async function refreshStatus() {
  const tab = await currentTab();
  const host = hostOf(tab?.url || "");
  $("#host").textContent = host || "—";

  const banner = $("#pdf-banner");
  if (banner) {
    const isPdf = isPdfTab(tab);
    banner.hidden = !isPdf;
    if (isPdf) banner.dataset.pdfUrl = tab.url;
  }

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

const CACHED_CONFIG_KEY = "lastServerConfig";

async function refreshServer() {
  const dot = $("#serverDot");
  let c = null;
  try {
    c = await getConfig();
    // Cache for next offline/restart window — avoids the "dropdown is empty
    // because server was down for 3s during a restart" surprise. The cache
    // holds no secrets; /config already hides api_key per design.
    await chrome.storage.local.set({ [CACHED_CONFIG_KEY]: c }).catch(() => {});
    dot.className = "dot ok";
    $("#serverText").innerHTML = `<code>${escHtml(c.default_model)}</code> → <code>${escHtml(c.default_target)}</code>`;
  } catch {
    // Fall back to last-known config so the provider/model dropdowns stay
    // populated with what the user had. We still mark the dot as an error
    // so the disconnect is visible.
    const cached = (await chrome.storage.local.get({ [CACHED_CONFIG_KEY]: null }).catch(() => ({})))[CACHED_CONFIG_KEY];
    dot.className = "dot err";
    if (cached) {
      c = cached;
      $("#serverText").textContent = "服务器连接失败 · 显示上次缓存";
    } else {
      $("#serverText").textContent = "服务器连接失败";
    }
  }
  if (c) {
    _providers = c.providers || [];
    const prefs = await chrome.storage.sync.get({ model: null, targetLang: null });
    populateProviderAndModel(prefs.model || c.default_model);
    $("#targetLang").value = prefs.targetLang || c.default_target;
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

$("#pdf-open").addEventListener("click", async () => {
  const banner = $("#pdf-banner");
  const pdfUrl = banner?.dataset.pdfUrl;
  if (!pdfUrl) return;
  const base = await getServerUrlSync();
  const { targetLang = "zh-CN", model } = await chrome.storage.sync.get({ targetLang: "zh-CN", model: null });
  const params = new URLSearchParams({ src: pdfUrl, target: targetLang });
  if (model) params.set("model", model);
  const viewerUrl = `${base}/pdf/view?${params.toString()}`;
  chrome.tabs.create({ url: viewerUrl });
  window.close();
});
$("#open-options-top")?.addEventListener("click", () => chrome.runtime.openOptionsPage?.());

// Advanced disclosure: reveals the server URL input.
$("#adv-toggle").addEventListener("click", () => {
  const panel = $("#adv-panel");
  const open = panel.classList.toggle("open");
  $("#adv-toggle").setAttribute("aria-expanded", String(open));
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
