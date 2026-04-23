# Claude Design — 三屏改造 brief

每一屏一个 Claude Design 会话。把截图（"before"）和对应 prompt 一起丢进去。
附上 `docs/design-tokens.md` 保持视觉一致性。

---

## 屏 ① · Popup（扩展图标弹窗）

**固定尺寸**: 400 × 动态高度
**截图**:
- light: 之前 preview_screenshot 在 `glance-ext-static` 服务器 420×820 浅色
- dark:  同上，深色模式

**要解决的问题**
- 布局功能性但无设计语言；"视觉就像个 raw form"
- 各区块之间节奏感弱，用户第一眼抓不到主操作
- Footer 的 "清空缓存 / 重载扩展 / 服务器 URL" 过于工程感

**prompt**
> 为一个 Chrome 浏览器翻译扩展设计 popup（固定 400px 宽）。产品名 glance。使用深色浅色双模式，颜色和字体见附件 design-tokens.md。
>
> 区块与优先级：
> 1. **Hero 切换按钮** — 最大最显眼。开/关两态："翻译中 · 点击关闭 ⌥A" / "翻译此页 ⌥A"。开态是渐变蓝填充按钮，关态是带边框的浅色按钮。按钮内有副标签"⌥A · 快捷键"。
> 2. **当前网站行** — 一行：显示 `x.com` 等当前 hostname + "自动翻译此网站" 切换复选。
> 3. **翻译设置卡**（标题"翻译服务"）— 四行标签:值布局: 目标语言 / 服务商 / 模型 / 服务器状态（绿点 + "claude-haiku-4-5 → zh-CN"）。
> 4. **视频字幕卡**（副标"无字幕视频转录"）— 时长输入 + "开始转录"主按钮 + "生成双语字幕" 勾选 + 状态行。
> 5. **Footer** — 缓存用量（一条细进度条 + "2763 条 · v1"），右侧图标按钮：清空缓存 / 重载 / 打开完整设置页。服务器 URL 输入折叠为 "⚙ 高级"（展开才出现）。
>
> 风格关键词：lean, modern, system-native, 克制，像 Linear 或 Arc 的小面板。不要花哨 emoji。
>
> 交付：HTML + CSS（CSS variables 兼容深色浅色）。handoff bundle 里标注各元素的数据绑定点（目前用 `#toggle / #model / #provider / #sub-go` 等 id）。

---

## 屏 ② · Options → "LLM 服务商"（卡片内重新设计）

**截图**: preview_screenshot options.html 760×2400 的底部滚到 "LLM 服务商" 卡片

**要解决的问题**
- 模板下拉 → 表单 → 列表的三段节奏不清晰
- "测试连接"结果行和按钮挤在一起，反馈不显眼
- config.yaml-owned provider 和用户添加的 provider 在同一个列表里，区分靠小 chip，容易忽略
- "获取 API Key ↗" 链接像被遗忘

**prompt**
> 为 Chrome 翻译扩展的设置页设计"LLM 服务商"卡片（父容器宽 ≤640px）。
>
> 交互分三段：
> 1. **添加** — 从下拉选模板（分组：免费/付费/自定义），选中后表单展开动画。
> 2. **表单** — 字段：显示名 / 名称 / API Key（密码输入，带显示/隐藏眼睛图标）/ 端点 / 模型列表（textarea + 右上"从服务商拉取"按钮）。"获取 API Key ↗" 文档链接紧邻 API Key 字段。按钮组：测试连接 / 保存 / 取消。测试/保存结果行要醒目（成功绿色 / 失败红色 bg tint，带图标）。
> 3. **已配置服务商列表** — 卡片式每行显示：图标（文字首字母或 logo）/ 显示名 / 端点 URL / 模型数 / 来源徽章（config.yaml = 锁图标灰；用户添加 = 可编辑蓝）。右侧操作：⋯ 溢出菜单包含编辑/删除/测试。
>
> 设计感：像 GitHub Settings 或 Vercel Dashboard，不像 Bootstrap 表单。
>
> 约束：使用 design-tokens.md 的配色；保持 ≤640px 可用；深色模式。交付 HTML/CSS，标注元素绑定（`#pfName / #pfApiKey / ...`）。

---

## 屏 ③ · In-page 浮层（FAB + 进度 pill + 划词 "译" + 结果 popover + 失败 chip）

**截图**: Wikipedia Osaka 页，已启用翻译，FAB + pill + 选区同时可见

**要解决的问题**
- 五个元素视觉语言不够统一（都是玻璃磨砂 + 蓝 accent 但尺寸/圆角不完全一套）
- FAB 的右键菜单位置和动画可以更顺
- 选区 "译" 按钮太小（24px），hover 才放大有点隐藏过头
- 失败 chip 用了警告橙，但形态跟译文 wrapper 一样，仍容易被误读为"这是译文"

**prompt**
> 为浏览器页内浮层设计一套统一视觉语言，覆盖五个元素，必须保持 z-index 2147483645+ 且不依赖宿主站点 CSS。
>
> 元素清单：
> 1. **进度 pill** — 右下角 bottom:16px right:16px。深色玻璃背景，12px 文字"翻译中 123/661"左边小 spinner，完成态变勾 "已完成 123"。点击取消整个翻译。lazy 600ms 才出现；完成后 1200ms 消失。
> 2. **FAB** — 右侧垂直居中。32×32 圆形。空闲 opacity 0.3；hover 0.8；激活态（翻译开启）主色蓝填充 opacity 0.85。内置文字"译"。右键打开菜单（向左展开）：翻译此页 / 始终自动翻译本站 / 设置… / 隐藏悬浮球。
> 3. **划词 "译" 按钮** — 选区结束处下方 4px，24×24 圆形蓝色带"译"。点击后替换为加载 spinner，加载完变结果 popover。
> 4. **结果 popover** — 最大宽 360px，最小 120px。深色玻璃，圆角 10px。内容：译文。底部可选显示原文小字灰色。边缘检测：若会越过视口右/下边，翻转位置。
> 5. **失败 chip**（当翻译彻底失败）— 紧接在原文段落下，**不应该**和译文 wrapper 形态一致，否则用户误以为是译文。建议：独立形态，比如 inline pill 橙色背景 "⚠ 翻译失败 · 重试"，形状明显更小、更像工具栏按钮。
>
> 总语言：半透明深色磨砂（`rgba(22,28,36, 0.9)` + backdrop-filter blur），主色蓝 `#2d8cf0` 点缀，绝不用橘黄色以外的其他色调（橘黄留给失败）。所有动画时长统一到 150-200ms ease-out。
>
> 交付：`inject.css` 的完整替换文件 + 任何需要的 HTML 模板（每个元素的结构）。保留现有 class 名: `.fanyi-progress / .fanyi-fab / .fanyi-fab-menu / .fanyi-sel-btn / .fanyi-sel-pop / .fanyi-failed`。

---

## 工作流建议

1. 三屏独立开 Claude Design 会话，避免互相干扰
2. 每屏第一轮让 Claude 出 3 个方向变体（"modern minimal" / "richer with more depth" / "data-dense"），挑一个继续迭代
3. 选定后用 Claude Design 的 handoff → Claude Code 导出 bundle
4. 我这边收到 bundle 后：
   - 屏 ① 替换 `popup.html` + `popup.css`
   - 屏 ② 替换 options.html 里那个 `<section class="card">` 块 + 相关 CSS
   - 屏 ③ 替换 `styles/inject.css` + 更新 `content_main.js` 里 FAB/pill/selection 的 DOM 结构（如果需要）
5. 每屏独立 commit，方便回滚

## 我需要保留的外部行为（让 Claude Design 知道）

- Popup 的 `#toggle / #provider / #model / #targetLang / #subSeconds / #subTranslate / #sub-go / #clear / #dev-reload / #open-options / #serverUrl` id 不能改，现有 popup.js 绑定
- Options LLM 服务商卡片内 `#providerTemplate / #pfLabel / #pfName / #pfApiKey / #pfToggleKey / #pfBaseUrl / #pfModels / #pfFetchModels / #pfFetchResult / #pfDocLink / #pfResult / #pfTest / #pfSave / #pfCancel / #providerList / #providerForm` 同上
- 浮层 class 名（`.fanyi-progress / .fanyi-fab / .fanyi-fab-menu / .fanyi-fab-on / .fanyi-sel-btn / .fanyi-sel-pop / .fanyi-failed / .fanyi-translation`）同上
- 所有浮层必须 `!important` 覆盖 host CSS 的关键属性（position / z-index）
