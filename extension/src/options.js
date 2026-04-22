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
    host.innerHTML = `
      <table class="prov-table">
        <thead><tr>
          <th>服务商</th><th>模型</th><th>调用</th><th>成功率</th>
          <th>平均延迟</th><th>输入 token</th><th>输出 token</th>
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
          </tr>`).join("")}</tbody>
      </table>`;
  } catch (e) {
    host.innerHTML = `<em class="hint">读取统计失败：${escHtml(String(e?.message || e))}</em>`;
  }
}

/* ── Free / popular LLM provider catalog ─────────────────────────────────
 * Static list. YAML snippets are meant to be copy-pasted into server's
 * config.yaml `providers:` section. Users still have to create their own
 * API key at each service's console. */
const FREE_PROVIDER_CATALOG = [
  {
    id: "deepseek", label: "DeepSeek", region: "cn",
    note: "国内直连稳，按量付费便宜（input ¥1/M，output ¥2/M）。首次注册送额度。",
    console: "https://platform.deepseek.com",
    yaml: `  - name: deepseek
    label: DeepSeek
    base_url: "https://api.deepseek.com/v1"
    api_key: "sk-YOUR-KEY"
    protocol: openai
    models: [deepseek-chat, deepseek-v3.1]`,
  },
  {
    id: "kimi", label: "Moonshot Kimi", region: "cn",
    note: "月之暗面，长上下文 128k，国内访问稳。价格中等。",
    console: "https://platform.moonshot.cn",
    yaml: `  - name: kimi
    label: Moonshot Kimi
    base_url: "https://api.moonshot.cn/v1"
    api_key: "sk-YOUR-KEY"
    protocol: openai
    models: [moonshot-v1-8k, moonshot-v1-32k, moonshot-v1-128k]`,
  },
  {
    id: "doubao", label: "Doubao (字节豆包)", region: "cn",
    note: "火山引擎。豆包 pro 翻译质量不错，价格和 DeepSeek 相近。",
    console: "https://www.volcengine.com/product/doubao",
    yaml: `  - name: doubao
    label: Doubao
    base_url: "https://ark.cn-beijing.volces.com/api/v3"
    api_key: "YOUR-ARK-KEY"
    protocol: openai
    models: [doubao-seed-1-6-250615, doubao-seed-1-6-flash-250615]`,
  },
  {
    id: "zhipu", label: "智谱 GLM", region: "cn",
    note: "GLM-4 / GLM-4-Flash（免费模型）。新用户送 2M tokens。",
    console: "https://open.bigmodel.cn",
    yaml: `  - name: zhipu
    label: 智谱 GLM
    base_url: "https://open.bigmodel.cn/api/paas/v4"
    api_key: "YOUR-KEY"
    protocol: openai
    models: [glm-4-plus, glm-4-flash]`,
  },
  {
    id: "groq", label: "Groq", region: "intl",
    note: "LPU 硬件超快（2000+ tok/s），免费额度每天 14.4k 请求。质量略逊 Claude/GPT。",
    console: "https://console.groq.com",
    yaml: `  - name: groq
    label: Groq
    base_url: "https://api.groq.com/openai/v1"
    api_key: "gsk-YOUR-KEY"
    protocol: openai
    models: [llama-3.3-70b-versatile, deepseek-r1-distill-llama-70b]`,
  },
  {
    id: "openrouter", label: "OpenRouter", region: "intl",
    note: "一个 key 聚合 Claude / GPT / Gemini / Llama。部分 :free 模型零费用。",
    console: "https://openrouter.ai",
    yaml: `  - name: openrouter
    label: OpenRouter
    base_url: "https://openrouter.ai/api/v1"
    api_key: "sk-or-YOUR-KEY"
    protocol: openai
    models:
      - anthropic/claude-haiku-4.5
      - google/gemini-2.0-flash-exp:free
      - meta-llama/llama-3.3-70b-instruct:free`,
  },
  {
    id: "openai", label: "OpenAI", region: "intl",
    note: "官方 API。gpt-4o-mini 便宜，gpt-4.1 / o4 质量顶。需付费，没免费额度。",
    console: "https://platform.openai.com",
    yaml: `  - name: openai
    label: OpenAI
    base_url: "https://api.openai.com/v1"
    api_key: "sk-YOUR-KEY"
    protocol: openai
    models: [gpt-4o-mini, gpt-4.1, gpt-4.1-mini]`,
  },
  {
    id: "gemini-openai", label: "Gemini (OpenAI 兼容模式)", region: "intl",
    note: "Google AI Studio 的 OpenAI 兼容端点，免费层每分钟有限调用次数。",
    console: "https://aistudio.google.com/apikey",
    yaml: `  - name: gemini
    label: Gemini
    base_url: "https://generativelanguage.googleapis.com/v1beta/openai"
    api_key: "YOUR-GEMINI-KEY"
    protocol: openai
    models: [gemini-2.5-flash, gemini-2.5-flash-lite]`,
  },
  {
    id: "ollama", label: "Ollama（本地）", region: "local",
    note: "本机跑开源模型，无 API 费用，完全离线。需要先 `ollama pull qwen2.5`。",
    console: "https://ollama.com",
    yaml: `  - name: ollama-local
    label: 本地 Ollama
    base_url: "http://localhost:11434/v1"
    api_key: ""
    protocol: openai
    models: [qwen2.5:7b, qwen2.5:14b, llama3.3]`,
  },
  {
    id: "vllm", label: "vLLM / LM Studio（本地）", region: "local",
    note: "自己起 OpenAI 兼容服务（vLLM / llama.cpp / LM Studio），适合自定义模型。",
    console: "https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html",
    yaml: `  - name: local
    label: 本地 vLLM
    base_url: "http://localhost:8000/v1"
    api_key: ""
    protocol: openai
    models: [your-local-model-name]`,
  },
];

function renderFreeProviderCatalog() {
  const host = $("#freeProviders");
  if (!host) return;
  host.innerHTML = FREE_PROVIDER_CATALOG.map((p) => `
    <div class="free-prov" data-id="${escHtml(p.id)}">
      <div class="free-prov-head">
        <span class="free-prov-title">${escHtml(p.label)}</span>
        <span class="free-prov-region region-${p.region}">${
          p.region === "cn" ? "国内" : p.region === "local" ? "本地" : "海外"
        }</span>
        <a class="free-prov-link" target="_blank" rel="noopener" href="${escHtml(p.console)}">控制台 ↗</a>
        <button type="button" class="free-prov-copy" data-id="${escHtml(p.id)}">复制 YAML</button>
      </div>
      <div class="free-prov-note">${escHtml(p.note)}</div>
      <pre class="free-prov-yaml">${escHtml(p.yaml)}</pre>
    </div>
  `).join("");
  host.querySelectorAll(".free-prov-copy").forEach((b) => {
    b.addEventListener("click", async () => {
      const p = FREE_PROVIDER_CATALOG.find((x) => x.id === b.dataset.id);
      try {
        await navigator.clipboard.writeText(p.yaml + "\n");
        b.textContent = "已复制 ✓";
        setTimeout(() => (b.textContent = "复制 YAML"), 1500);
      } catch {
        b.textContent = "复制失败";
      }
    });
  });
}

function escHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

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
      opt.value = `${p.name}:${m}`;
      opt.textContent = multi ? m : m;
      parent.appendChild(opt);
    }
  }
  const desired = current || defaultModel;
  if (!desired) return;
  // Exact match first; otherwise match on suffix (legacy unprefixed defaults).
  let opt = sel.querySelector(`option[value="${CSS.escape(desired)}"]`);
  if (!opt) opt = Array.from(sel.querySelectorAll("option")).find(o => o.value.endsWith(":" + desired));
  if (opt) sel.value = opt.value;
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
  renderFreeProviderCatalog();
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
  const m = chrome.runtime.getManifest();
  $("#extInfo").textContent = `${m.name} v${m.version}`;
  refreshServer();
})();
