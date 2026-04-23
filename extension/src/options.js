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
    translationFont: "",
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
  $("#translationFont").value = p.translationFont || "";
  renderGlossaryStatus?.();
}

/** Fetch /providers/stats and render the table. Hidden gracefully if empty. */
async function refreshProviderStats() {
  const host = $("#providerStats");
  if (!host) return;
  try {
    const r = await serverFetch("/providers/stats?days=30");
    const j = await r.json();
    const rows = j.rows || [];
    if (!rows.length) {
      host.innerHTML = `<em class="hint">还没有调用记录，去翻译一个页面再来看看。</em>`;
      return;
    }
    const fmtCost = (v) => {
      const c = Number(v || 0);
      if (c === 0) return "—";
      if (c < 0.01) return `<$0.01`;
      return `$${c.toFixed(c < 1 ? 3 : 2)}`;
    };
    const totalCost = rows.reduce((s, r) => s + (r.cost_usd || 0), 0);
    const totalIn = rows.reduce((s, r) => s + (r.tokens_in || 0), 0);
    const totalOut = rows.reduce((s, r) => s + (r.tokens_out || 0), 0);
    host.innerHTML = `
      <table class="prov-table">
        <thead><tr>
          <th>服务商</th><th>模型</th><th>调用</th><th>成功率</th>
          <th>平均延迟</th><th>输入 token</th><th>输出 token</th><th title="按公开单价粗估，仅供参考">估算费用</th>
        </tr></thead>
        <tbody>${rows.map(r => `
          <tr>
            <td>${escHtml(r.provider)}</td>
            <td>${escHtml(r.model)}</td>
            <td>${r.calls}</td>
            <td>${(r.success_rate * 100).toFixed(1)}%</td>
            <td>${Math.round(r.avg_latency_ms)} ms</td>
            <td>${r.tokens_in.toLocaleString()}</td>
            <td>${r.tokens_out.toLocaleString()}</td>
            <td>${fmtCost(r.cost_usd)}</td>
          </tr>`).join("")}
          <tr style="font-weight:600; border-top:2px solid var(--border)">
            <td colspan="5">合计（近 30 天）</td>
            <td>${totalIn.toLocaleString()}</td>
            <td>${totalOut.toLocaleString()}</td>
            <td>${fmtCost(totalCost)}</td>
          </tr></tbody>
      </table>
      <p class="hint" style="margin-top:8px">费用按公开单价粗估（本地模型默认 0）。实际账单以各服务商为准。</p>`;
  } catch (e) {
    host.innerHTML = `<em class="hint">读取统计失败：${escHtml(String(e?.message || e))}</em>`;
  }
}

/* ── Provider template catalog ───────────────────────────────────────────
 * Pre-filled provider templates shown in the "添加" dropdown. Picking one
 * prefills the provider form with sensible defaults; the user just pastes
 * their API key and saves. `freeTier` flag surfaces the ones with a usable
 * free offering. */
const PROVIDER_CATALOG = [
  {
    id: "glm", label: "智谱 GLM（有免费模型）", region: "cn", freeTier: true,
    note: "GLM-4.5-Flash / GLM-4-Flash 完全免费。注册即用，国内直连。",
    docUrl: "https://open.bigmodel.cn",
    base_url: "https://open.bigmodel.cn/api/paas/v4",
    protocol: "openai",
    models: ["glm-4.5-flash", "glm-4-flash", "glm-4-plus"],
  },
  {
    id: "siliconflow", label: "硅基流动（有免费模型）", region: "cn", freeTier: true,
    note: "Qwen2.5-7B-Instruct 等模型免费调用。国内稳定，注册送 ¥14 额度。",
    docUrl: "https://cloud.siliconflow.cn",
    base_url: "https://api.siliconflow.cn/v1",
    protocol: "openai",
    models: ["Qwen/Qwen2.5-7B-Instruct", "Qwen/Qwen2.5-72B-Instruct", "deepseek-ai/DeepSeek-V3"],
  },
  {
    id: "groq", label: "Groq（免费层，超快）", region: "intl", freeTier: true,
    note: "LPU 硬件 2000+ tok/s。每天 14.4k 请求免费。翻译质量略逊 GPT/Claude。",
    docUrl: "https://console.groq.com",
    base_url: "https://api.groq.com/openai/v1",
    protocol: "openai",
    models: ["llama-3.3-70b-versatile", "deepseek-r1-distill-llama-70b"],
  },
  {
    id: "gemini", label: "Gemini（免费层）", region: "intl", freeTier: true,
    note: "Google AI Studio。每分钟限速，但有免费调用次数。OpenAI 兼容模式。",
    docUrl: "https://aistudio.google.com/apikey",
    base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
    protocol: "openai",
    models: ["gemini-2.5-flash", "gemini-2.5-flash-lite"],
  },
  {
    id: "openrouter", label: "OpenRouter（聚合，部分免费）", region: "intl", freeTier: true,
    note: "一个 key 聚合 Claude / GPT / Gemini / Llama。:free 后缀的模型零费用。",
    docUrl: "https://openrouter.ai",
    base_url: "https://openrouter.ai/api/v1",
    protocol: "openai",
    models: [
      "google/gemini-2.0-flash-exp:free",
      "meta-llama/llama-3.3-70b-instruct:free",
      "anthropic/claude-haiku-4.5",
    ],
  },
  {
    id: "deepseek", label: "DeepSeek", region: "cn",
    note: "按量付费便宜（input ¥1/M，output ¥2/M）。国内直连。",
    docUrl: "https://platform.deepseek.com",
    base_url: "https://api.deepseek.com/v1",
    protocol: "openai",
    models: ["deepseek-chat", "deepseek-v3.1"],
  },
  {
    id: "kimi", label: "Moonshot Kimi", region: "cn",
    note: "长上下文 128k。价格中等。国内访问稳。",
    docUrl: "https://platform.moonshot.cn",
    base_url: "https://api.moonshot.cn/v1",
    protocol: "openai",
    models: ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"],
  },
  {
    id: "doubao", label: "Doubao（字节豆包）", region: "cn",
    note: "火山引擎。豆包 pro 翻译质量不错，价格和 DeepSeek 相近。",
    docUrl: "https://www.volcengine.com/product/doubao",
    base_url: "https://ark.cn-beijing.volces.com/api/v3",
    protocol: "openai",
    models: ["doubao-seed-1-6-250615", "doubao-seed-1-6-flash-250615"],
  },
  {
    id: "openai", label: "OpenAI", region: "intl",
    note: "官方 API。gpt-4o-mini 便宜，gpt-4.1 / o4 质量顶。无免费额度。",
    docUrl: "https://platform.openai.com",
    base_url: "https://api.openai.com/v1",
    protocol: "openai",
    models: ["gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini"],
  },
  {
    id: "ollama", label: "Ollama（本地，零成本）", region: "local", freeTier: true,
    note: "本机跑开源模型，离线、无 API 费用。需要先 `ollama pull qwen2.5`。",
    docUrl: "https://ollama.com",
    base_url: "http://localhost:11434/v1",
    protocol: "openai",
    models: ["qwen2.5:7b", "qwen2.5:14b", "llama3.3"],
  },
  {
    id: "vllm", label: "vLLM / LM Studio（本地）", region: "local", freeTier: true,
    note: "自己起 OpenAI 兼容服务（vLLM / llama.cpp / LM Studio）。",
    docUrl: "https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html",
    base_url: "http://localhost:8000/v1",
    protocol: "openai",
    models: [],
  },
  {
    id: "custom", label: "自定义（OpenAI 兼容）", region: "intl",
    note: "任何 /chat/completions 兼容端点。",
    docUrl: "",
    base_url: "",
    protocol: "openai",
    models: [],
  },
];

/* ── Provider management UI ───────────────────────────────────────────── */

function regionTag(r) { return r === "cn" ? "国内" : r === "local" ? "本地" : "海外"; }

function populateProviderTemplateDropdown() {
  const sel = $("#providerTemplate");
  sel.innerHTML = '<option value="">— 选择服务商 —</option>';
  // Free first, then paid/intl, then custom.
  const groups = [
    ["免费或有免费层", PROVIDER_CATALOG.filter(p => p.freeTier)],
    ["付费 / 其他",   PROVIDER_CATALOG.filter(p => !p.freeTier && p.id !== "custom")],
    ["自定义",        PROVIDER_CATALOG.filter(p => p.id === "custom")],
  ];
  for (const [title, items] of groups) {
    if (!items.length) continue;
    const g = document.createElement("optgroup"); g.label = title;
    for (const p of items) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = `${p.label} · ${regionTag(p.region)}`;
      g.appendChild(o);
    }
    sel.appendChild(g);
  }
}

/** Form reveal is controlled by aria-hidden (the new design's CSS uses
 *  .llm-reveal[aria-hidden=false] for the slide-down). */
function showForm() { $("#providerForm").setAttribute("aria-hidden", "false"); }
function hideForm() { $("#providerForm").setAttribute("aria-hidden", "true"); }

function openProviderForm(template) {
  $("#pfLabel").value = template.label;
  $("#pfName").value = template.id === "custom" ? "" : template.id;
  $("#pfName").disabled = false;
  $("#pfApiKey").value = "";
  $("#pfApiKey").type = "password";
  $("#pfBaseUrl").value = template.base_url;
  $("#pfModels").value = (template.models || []).join("\n");
  const link = $("#pfDocLink");
  if (template.docUrl) { link.href = template.docUrl; link.hidden = false; }
  else link.hidden = true;
  $("#pfResult").textContent = "";
  $("#pfFetchResult").textContent = "";
  $("#providerForm").dataset.editing = "";
  showForm();
}

function openProviderFormForEdit(provider) {
  $("#pfLabel").value = provider.label || provider.name;
  $("#pfName").value = provider.name;
  $("#pfName").disabled = true;
  $("#pfApiKey").value = "";
  $("#pfApiKey").placeholder = provider.has_api_key ? "（已设置，不动则保留）" : "sk-...";
  $("#pfApiKey").type = "password";
  $("#pfBaseUrl").value = provider.base_url;
  $("#pfModels").value = (provider.models || []).join("\n");
  $("#pfDocLink").hidden = true;
  $("#pfResult").textContent = "";
  $("#pfFetchResult").textContent = "";
  $("#providerForm").dataset.editing = provider.name;
  showForm();
  $("#providerForm").scrollIntoView({ behavior: "smooth", block: "center" });
}

function closeProviderForm() {
  hideForm();
  $("#providerTemplate").value = "";
  $("#pfName").disabled = false;
}

function readProviderForm() {
  return {
    name: $("#pfName").value.trim(),
    label: $("#pfLabel").value.trim(),
    base_url: $("#pfBaseUrl").value.trim(),
    api_key: $("#pfApiKey").value,
    protocol: "openai",
    models: $("#pfModels").value.split("\n").map(s => s.trim()).filter(Boolean),
    enabled: true,
  };
}

/** Stable pastel color for the provider avatar, derived from the name's hash
 *  so the same provider always gets the same color across reloads. */
function pastelFor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return `hsl(${hue} 60% 88%)`;
}
function pastelTextFor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return `hsl(${hue} 60% 28%)`;
}

async function refreshProviderList() {
  const host = $("#providerList");
  if (!host) return;
  try {
    const r = await serverFetch("/providers");
    const j = await r.json();
    const rows = j.providers || [];
    const count = $("#providerCount");
    if (count) count.textContent = rows.length ? `${rows.length} 个` : "";
    if (!rows.length) { host.innerHTML = ""; return; }
    host.innerHTML = rows.map(p => {
      const first = (p.label || p.name || "?").trim().slice(0, 1).toUpperCase();
      const chip = p.source === "config"
        ? `<span class="llm-chip llm-chip--config"><svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="2" y="4.5" width="6" height="4" rx="1"/><path d="M3.5 4.5V3a1.5 1.5 0 1 1 3 0v1.5"/></svg>config.yaml</span>`
        : `<span class="llm-chip llm-chip--user">用户添加</span>`;
      const rightCol = p.source === "user"
        ? `<div class="llm-provider__right">
             <button type="button" class="llm-menu-btn" aria-label="更多" data-menu>⋯</button>
             <div class="llm-menu" data-menu-list>
               <button type="button" class="llm-menu__item" data-act="edit">编辑</button>
               <button type="button" class="llm-menu__item llm-menu__item--danger" data-act="delete">删除</button>
             </div>
           </div>`
        : `<span class="llm-menu-hint">config.yaml 管理</span>`;
      return `
        <div class="llm-provider" data-name="${escHtml(p.name)}">
          <span class="llm-provider__avatar" style="background:${pastelFor(p.name)};color:${pastelTextFor(p.name)}">${escHtml(first)}</span>
          <div class="llm-provider__body">
            <div class="llm-provider__line1">
              <span class="llm-provider__name">${escHtml(p.label)}</span>
              ${chip}
            </div>
            <div class="llm-provider__line2">${escHtml(p.base_url)} <span class="sep">·</span> ${p.models.length} 个模型</div>
          </div>
          ${rightCol}
        </div>`;
    }).join("");
    // Wire the ⋯ overflow menus
    host.querySelectorAll(".llm-provider").forEach(row => {
      const menuBtn = row.querySelector("[data-menu]");
      const menu = row.querySelector("[data-menu-list]");
      if (menuBtn && menu) {
        menuBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          // Close any other open menu first
          host.querySelectorAll(".llm-menu.is-open").forEach(m => { if (m !== menu) m.classList.remove("is-open"); });
          menu.classList.toggle("is-open");
        });
        menu.addEventListener("click", async (ev) => {
          const b = ev.target.closest("button[data-act]");
          if (!b) return;
          ev.stopPropagation();
          menu.classList.remove("is-open");
          const name = row.dataset.name;
          const provider = rows.find(x => x.name === name);
          if (b.dataset.act === "edit" && provider) openProviderFormForEdit(provider);
          else if (b.dataset.act === "delete" && provider) {
            if (!confirm(`删除服务商 "${provider.label}"？`)) return;
            await serverFetch(`/providers/${encodeURIComponent(name)}`, { method: "DELETE" });
            await refreshProviderList();
          }
        });
      }
    });
    // Click-anywhere-else closes any open menu
    document.addEventListener("click", () => {
      host.querySelectorAll(".llm-menu.is-open").forEach(m => m.classList.remove("is-open"));
    }, { once: true });
  } catch (e) {
    host.innerHTML = `<em class="hint">加载失败：${escHtml(String(e?.message || e))}</em>`;
  }
}

function wireProviderForm() {
  populateProviderTemplateDropdown();
  $("#providerTemplate").addEventListener("change", (e) => {
    const id = e.target.value;
    if (!id) { closeProviderForm(); return; }
    const tpl = PROVIDER_CATALOG.find(p => p.id === id);
    if (tpl) openProviderForm(tpl);
  });
  $("#pfCancel").addEventListener("click", closeProviderForm);
  $("#pfToggleKey").addEventListener("click", () => {
    const input = $("#pfApiKey");
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    $("#pfToggleKey").setAttribute("aria-label", showing ? "显示" : "隐藏");
    // Toggle a class in case the design uses :has() or similar to swap icon state
    $("#pfToggleKey").classList.toggle("is-showing", !showing);
  });
  $("#pfFetchModels").addEventListener("click", async () => {
    const base_url = $("#pfBaseUrl").value.trim();
    const api_key = $("#pfApiKey").value;
    if (!base_url) { $("#pfFetchResult").textContent = "先填端点"; return; }
    $("#pfFetchResult").textContent = "拉取中…";
    try {
      const r = await serverFetch("/providers/list-models", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ base_url, api_key }),
      });
      const j = await r.json();
      if (!j.ok) { $("#pfFetchResult").textContent = `✗ ${j.error}`; return; }
      const models = j.models || [];
      if (!models.length) {
        $("#pfFetchResult").textContent = `无模型（返回 ${j.total || 0} 条，都被过滤）`;
        return;
      }
      $("#pfModels").value = models.join("\n");
      const dropped = j.filtered ? ` · 已过滤 ${j.filtered} 个非文本模型` : "";
      $("#pfFetchResult").textContent = `✓ ${models.length} 个模型${dropped}`;
    } catch (e) {
      $("#pfFetchResult").textContent = `✗ ${e?.message || e}`;
    }
  });
  $("#pfTest").addEventListener("click", async () => {
    const body = readProviderForm();
    if (!body.base_url || !body.models.length) {
      $("#pfResult").textContent = "缺 base_url 或模型列表";
      return;
    }
    $("#pfResult").textContent = "测试中…";
    try {
      const r = await serverFetch("/providers/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (j.ok) $("#pfResult").textContent = `✓ ${j.latency_ms}ms · ${j.sample}`;
      else $("#pfResult").textContent = `✗ ${j.error}`;
    } catch (e) {
      $("#pfResult").textContent = `✗ ${e?.message || e}`;
    }
  });
  $("#pfSave").addEventListener("click", async () => {
    const body = readProviderForm();
    if (!body.name || !body.base_url) {
      $("#pfResult").textContent = "name 和 base_url 必填";
      return;
    }
    if (!body.models.length) {
      $("#pfResult").textContent = "至少一个模型";
      return;
    }
    // Keep existing api_key on edit if field is blank — server doesn't return it, so
    // an empty value would wipe the saved key. Skip the PATCH by setting enabled.
    const editing = $("#providerForm").dataset.editing;
    if (editing && !body.api_key) {
      // Fetch current provider to retain its api_key — the only way we can here is to
      // temporarily send "". Server's upsert will overwrite. So require re-entry in UI.
      $("#pfResult").textContent = "编辑时 API Key 必填（之前的值不会返回）";
      return;
    }
    $("#pfResult").textContent = "保存中…";
    try {
      const r = await serverFetch("/providers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({ detail: r.statusText }));
        $("#pfResult").textContent = `✗ ${j.detail || "保存失败"}`;
        return;
      }
      $("#pfResult").textContent = "✓ 已保存";
      closeProviderForm();
      await refreshProviderList();
      await refreshServer();   // re-pull /config so the model dropdown includes the new provider
    } catch (e) {
      $("#pfResult").textContent = `✗ ${e?.message || e}`;
    }
  });
}

function escHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

let _providers = [];

function populateModelDropdown(providers, defaultModel) {
  _providers = providers || [];
  const provSel = $("#provider");
  if (!provSel) return;
  provSel.innerHTML = "";
  for (const p of _providers) {
    const o = document.createElement("option");
    o.value = p.name;
    o.textContent = p.label || p.name;
    provSel.appendChild(o);
  }
  const [wantedProv, wantedModel] = (defaultModel || "").split(":");
  const picked = _providers.find((p) => p.name === wantedProv) || _providers[0];
  if (picked) provSel.value = picked.name;
  renderModelsForProvider(picked, wantedModel || (defaultModel && !defaultModel.includes(":") ? defaultModel : null));
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
    const r = await serverFetch("/config");
    const c = await r.json();
    populateModelDropdown(c.providers || [], c.default_model);
    const prefs = await chrome.storage.sync.get({ model: null });
    if (prefs.model && $("#model").querySelector(`option[value="${CSS.escape(prefs.model)}"]`)) {
      $("#model").value = prefs.model;
    }
  } catch { /* already surfaced via health dot */ }
  refreshProviderStats();
  refreshProviderList();
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
$("#provider").addEventListener("change", (e) => {
  const p = _providers.find((x) => x.name === e.target.value);
  renderModelsForProvider(p, null);
  const first = $("#model").value;
  if (first) save("model", first);
});
$("#model").addEventListener("change", (e) => save("model", e.target.value));
$("#autoSites").addEventListener("change", (e) => save("autoSites", parseAutoSites(e.target.value)));
$("#subDefaultSeconds").addEventListener("change", (e) => save("subDefaultSeconds", Math.max(5, parseInt(e.target.value || "60", 10))));
$("#subBilingual").addEventListener("change", (e) => save("subBilingual", e.target.checked));
$("#subPreferDownload").addEventListener("change", (e) => save("subPreferDownload", e.target.checked));
/** Live glossary validation: count valid mappings, warn about malformed
 * lines, reassure the user that what they typed is what the translator
 * will actually receive. Previously there was no feedback at all and users
 * couldn't tell whether their entries were being used. */
function renderGlossaryStatus() {
  const raw = $("#glossary").value || "";
  const lines = raw.split(/\r?\n/);
  const total = lines.filter(l => l.trim() && !l.trim().startsWith("#")).length;
  const parsed = parseGlossary(raw);
  const dot = $("#glossaryStatus")?.querySelector(".dot");
  const text = $("#glossaryStatusText");
  if (!text) return;
  if (raw.trim() === "") {
    text.textContent = "尚未填写";
    dot?.classList.remove("ok", "err");
    return;
  }
  const bad = total - parsed.length;
  const savedNote = "（保存后自动触发已翻译网页的重译）";
  if (parsed.length && bad === 0) {
    text.textContent = `${parsed.length} 条已启用 ${savedNote}`;
    dot?.classList.add("ok"); dot?.classList.remove("err");
  } else if (parsed.length && bad > 0) {
    text.textContent = `${parsed.length} 条已启用，${bad} 行格式不正确（被忽略）`;
    dot?.classList.add("err"); dot?.classList.remove("ok");
  } else {
    text.textContent = `无法解析 · 检查格式（原文 => 译文）`;
    dot?.classList.add("err"); dot?.classList.remove("ok");
  }
}

$("#glossary").addEventListener("input", renderGlossaryStatus);
$("#glossary").addEventListener("change", (e) => {
  save("glossary", parseGlossary(e.target.value));
  renderGlossaryStatus();
});
$("#showFab").addEventListener("change", (e) => save("showFab", e.target.checked));
$("#translationFont").addEventListener("change", (e) => save("translationFont", (e.target.value || "").trim()));

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
  wireProviderForm();
  const m = chrome.runtime.getManifest();
  $("#extInfo").textContent = `${m.name} v${m.version}`;
  refreshServer();
})();
