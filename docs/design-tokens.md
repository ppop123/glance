# glance — Design Tokens (current)

Snapshot of the CSS variables, recurring values, and visual language used in the
Chrome extension today. Paste this into Claude Design so generated designs
stay consistent with the existing codebase.

## Brand

- **Name**: glance （译）
- **Tagline**: 轻量网页翻译，读外文像读原文
- **Primary icon glyph**: 文 / 译

## Core colors

### Accent (translation)
- Primary: `#2d8cf0` (`--fanyi-accent`, used for FAB, pill, selection "译" button)
- Dark-mode tweak: `#6db3ff` (applies via `prefers-color-scheme: dark`)

### Options / popup UI palette (already theme-aware via `color-scheme: light dark`)

| Token | Light | Dark |
|---|---|---|
| `--fg` | `#1f2328` | `#e6edf3` |
| `--fg-dim` | `#656d76` | `#9da7b3` |
| `--fg-muted` | `#8c959f` | `#6e7681` |
| `--bg` | `#f6f8fa` | `#0d1117` |
| `--bg-1` (cards) | `#ffffff` | `#161b22` |
| `--bg-2` (inputs) | `#eaeef2` | `#21262d` |
| `--border` | `#d0d7de` | `#30363d` |
| `--accent` | `#3b82f6` | `#58a6ff` |
| `--success` | `#1a7f37` | `#3fb950` |
| `--danger` | `#cf222e` | `#f85149` |

### Overlay (in-page) palette
Used for FAB, pill, selection popover — must stand out against any host site,
so colors are explicit (not inherited from host).

- Pill / popover bg: `rgba(22, 28, 36, 0.92)` → `0.96` on popover
- Pill text: `#fff`
- Pill spinner track: `rgba(255, 255, 255, 0.25)`
- "Done" green checkmark: `#3ecf8e`
- Failure chip: `rgba(230, 150, 60, 0.95)` text on transparent bg, border `rgba(230, 150, 60, 0.55)`

## Typography

- System stack: `-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", system-ui, sans-serif`
- Mono stack: `ui-monospace, SFMono-Regular, Menlo, monospace`
- Pill / FAB: `500 12px/1`
- Selection popover: `400 13px/1.5`
- Body translation: inherits from host (allow override via `--fanyi-font`)

## Shape / depth

| Element | Radius | Shadow |
|---|---|---|
| Card (options) | 10px | `0 1px 2px rgba(0,0,0,.1)` or none |
| Pill (bottom-right) | 9999px (fully round) | `0 6px 20px rgba(0,0,0,0.3), 0 0 0 1px rgba(255,255,255,0.06)` |
| FAB (right-middle) | 50% | `0 3px 10px rgba(0,0,0,0.22), 0 0 0 1px rgba(255,255,255,0.05)` |
| Selection 译 button | 12px (round) | `0 3px 10px rgba(0,0,0,0.25)` |
| Selection popover | 10px | `0 10px 30px rgba(0,0,0,0.35)` |
| Button / input | 6px | `0 0 0 2px` focus ring in subtle accent |
| Menu (FAB right-click) | 10px | `0 10px 30px rgba(0,0,0,0.35)` |
| Button pill (small action) | 9999px | — |

## Motion

- Spinner: 0.7s linear infinite rotate (`@keyframes fanyi-spin`)
- Hover transitions: `transform 0.12s–0.2s`, `opacity 0.15s–0.2s`
- Pill reveal delay: 600 ms (only shows if translation takes longer than that)
- Pill "done" linger: 1200 ms before auto-hide

## Sizes (fixed, for overlay elements)

- Pill: auto-width, 8-14px padding, bottom-right 16px
- FAB: 32×32 circle, right edge `right: 4px`, vertically centered (`top: 50%`)
- FAB menu: 180px min-width
- Selection 译 button: 24×24 circle, 4px below selection end
- Selection popover: max-width 360px, min-width 120px
- Popup: 400px wide, dynamic height
- Options: max 640px centered (currently; could go wider with responsive)

## z-index contract

Overlays use `2147483645–2147483647` (max range) so they escape any host
stacking context. Pill = 2147483646, FAB = 2147483645, menus = 2147483646,
selection button / popover = 2147483647.

## Light/dark switching

- Popup + options: native `prefers-color-scheme` via CSS variables above.
- In-page overlays: fixed dark theme regardless of host (dark pill always,
  dark popover always). Rationale: host sites have every possible palette;
  a consistent dark glass-morphism overlay always legible.
- Translation wrapper (`.fanyi-translation`): inherits host color, no bg.
  Goal: feels like native content.

## Voice (copy tone)

- 短、克制、中英混排
- 技术词保持英文（"provider", "API Key"）
- 少 emoji，几乎不用
- 按钮偏命令式："翻译此页" / "保存" / "取消"，不用 "点击翻译"
- 状态偏描述："翻译中 123/661" / "已完成 90" / "✗ 测试失败"
