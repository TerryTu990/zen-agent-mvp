---
version: alpha
name: Atelier（zen-agent 采用）
description: zen-agent 内嵌辅助 agent 的暖人文工程感（editorial × technical）。近中性底 + 黏土色单一强调 + 衬线标题；服务于叠加在宿主系统上的对话抽屉，信息密度高、须被长时间注视，而非营销落地页。设计语言与 zen-flux 同族（Atelier），令牌一致、组件按 zen-agent 形态改写。
colors:
  primary: "#1C1B18"
  secondary: "#615C54"
  tertiary: "#B4552F"
  neutral: "#F4F3EF"
  surface: "#FBFAF8"
  on-surface: "#1C1B18"
  error: "#A23A2C"
  success: "#3E6B4E"
  warning: "#8F6516"
  agent: "#5E5396"
  muted: "#8E887D"
  border: "#E6E2DA"
  border-strong: "#D6D0C4"
typography:
  headline-md:
    fontFamily: "Fraunces, 'Noto Serif SC', serif"
    fontSize: 24px
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  body-md:
    fontFamily: "'Hanken Grotesk', 'Noto Sans SC', sans-serif"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.55
  label-md:
    fontFamily: "'Hanken Grotesk', 'Noto Sans SC', sans-serif"
    fontSize: 13px
    fontWeight: 500
    lineHeight: 1.4
  label-caps:
    fontFamily: "'Geist Mono', 'Noto Sans Mono', monospace"
    fontSize: 10.5px
    fontWeight: 500
    lineHeight: 1.0
    letterSpacing: "0.08em"
  mono-md:
    fontFamily: "'Geist Mono', 'Noto Sans Mono', monospace"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
rounded:
  none: 0px
  sm: 6px
  md: 10px
  lg: 14px
  bubble: 13px
  full: 9999px
spacing:
  2xs: 4px
  xs: 8px
  sm: 12px
  md: 14px
  lg: 24px
components:
  drawer:
    backgroundColor: "{colors.surface}"
    borderLeft: "1px solid {colors.border-strong}"
    elevation: "-14px 0 40px rgba(28,27,24,0.12)"
  bubble-user:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.neutral}"
    rounded: "{rounded.bubble}"
  bubble-assistant:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.bubble}"
    border: "1px solid {colors.border}"
  tool-card:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.secondary}"
    rounded: "{rounded.md}"
  hitl-card:
    backgroundColor: "#F2E6DE"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.lg}"
  input:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.md}"
    focusRing: "2px {colors.tertiary}"
---

## Overview

Atelier 把界面当作一本经过排版的工程刊物，而不是一块后台。zen-agent 的形态是**叠加在 ToB 宿主系统上的对话抽屉**——它挤在别人的页面右缘，信息密度高、技术标识符多（工具 id、令牌名、JSON 结果）、要被用户在工作流里长时间瞥视。抽屉必须一眼可辨为「zen 的东西」，又不与宿主页抢注意力。

**它要避开的两层 AI 套路：**

- 第一层（领域反射）：「AI 工具 → 深色 + 紫色渐变 + 霓虹」。Atelier 不碰深色霓虹。
- 第二层（反套路反射）：「不做 SaaS 套路 → 那就上奶油色编辑风」。**暖奶油近白底已经是当下的 AI 默认色**，`--paper`/`--cream` 命名本身就是 tell。Atelier 因此把底色拉到近中性 off-white（`neutral #F4F3EF`，chroma 压到极低），把「暖」与「人文」交给三样承载：黏土色强调（`tertiary`）、衬线标题（Fraunces）、等宽体排印的技术字符串。底色不负责制造温度。

**zen-agent 的身份记忆点**：黏土方块 + 描边 "Z" 的品牌标记（`icons/icon.svg`，Z=zen），复用于插件工具栏图标、抽屉头部、以及最小化后的悬浮球——三处同一个标记，是产品的结构署名。次一层记忆点是**三种 API 调用模式的色彩语义**（client 黏土 / server 紫 / mcp 中性），把「平台如何替用户发起调用」这件事外显成稳定的视觉分组。

三词性格：**克制、编辑感、有判断**。

## 令牌落地（实现事实）

抽屉运行在 content script 注入的 **Shadow DOM** 内，无法引用宿主页的 CSS 变量，故本规范的令牌以字面值内联于 `apps/extension/src/content.ts` 的 `PANEL_CSS`（`:host` 上声明 `--ink/--clay/--paper/...`）。**本文件是这些令牌取值与语义的 SSOT**；改令牌先改这里、再同步 `PANEL_CSS`。CJK 字体（思源宋/黑体、Noto Sans Mono）靠系统回退，不打包、不外链 Google Fonts。

## Colors

策略为 **Restrained（克制）**：近中性底 + 一个强调色 ≤ 10% 面积。颜色是稀缺资源，只表达含义，不做装饰。

- **primary `#1C1B18`** — 暖近黑（非纯黑）。正文、用户气泡底、次级按钮字。正文绝不用纯黑 `#000`。
- **secondary `#615C54`** — 暖石板灰。工具卡正文、次级说明。不用于长正文。
- **tertiary `#B4552F`（clay）** — 黏土色，唯一的交互/强调驱动：输入焦点环、HITL 主按钮、品牌标记、client 模式色。承载品牌温度。**小字号慎用为文本色**（对比接近 3:1，正文一律走 primary）。
- **neutral `#F4F3EF`** — 极低 chroma off-white，助手气泡底 / 工具卡底。
- **surface `#FBFAF8`** — 抽屉表面 / 输入框底，靠与 neutral 的明度差分层，而非阴影。
- **agent `#5E5396`** — 低饱和紫，专用于 AI/agent 语义：抽屉头部底（`#ECEAF3` 软色）、标题字、发送按钮、server 模式色。
- **语义色** — `success #3E6B4E` / `warning #8F6516` / `error #A23A2C`。仅在有信号时出现：工具卡状态边（运行 warning / 成功 success / 失败 error）、状态提示（error）。默认安静的中性灰。
- **border `#E6E2DA` / border-strong `#D6D0C4`** — 发丝边，结构靠它、不靠投影。抽屉左缘用 border-strong。

对比度（硬性）：正文 ≥ 4.5:1，大字（≥18px 或 bold ≥14px）≥ 3:1，placeholder ≥ 4.5:1。

### 三模式色彩语义（zen-agent 专属）

工具卡按 `tool-card.mode` 分三组，色彩承载「调用如何发起」的语义，不做装饰：

- **client（客户端发起）** → `tertiary` 黏土：扩展以用户会话代执行。
- **server（服务端发起）** → `agent` 紫：服务端以平台凭证直调。
- **mcp（客户端 MCP 调用）** → `muted` 中性灰：经 MCP 协议调用。

分组标题用 `label-caps`（mono 小字 + 前置 8px 色块），色块与标题字取该模式色。**这是唯一允许的「色块前缀」用法**；仍禁止单边彩色描边条（见 Shapes）。

## Typography

三族封顶：**Fraunces（展示衬线）+ Hanken Grotesk（正文无衬线）+ Geist Mono（技术字符串）**，配思源宋/黑/等宽 CJK 回退。

- 抽屉头部品牌字与（未来的）大标题用衬线——最低成本的「脱管理系统」动作。
- 所有技术字符串（工具 id、状态标签、令牌名、JSON、时间戳、模式分组标题）一律 **mono**。
- 正文（气泡、markdown 渲染体）用无衬线 body-md（14/1.55）。
- 层级靠 scale + 字重对比（400 / 500–600 两档），不堆叠字重。
- **禁止**：全大写正文；每个区块顶挂 eyebrow。`label-caps` 只作模式分组标题这类偶发系统标，不满屏铺。

字号阶（抽屉尺度）：headline-md 24 / body-md 14 / label 13 / mono 12 / caps 10.5。

## Layout

- 抽屉贴宿主页右缘：`position:fixed; top/right/bottom:0`；默认宽 400px、`max-width:94vw`；左缘拖拽把手改宽，clamp `[300, 720]px`，宽度记忆于 `chrome.storage.local['za.drawerWidth']`。
- 可折叠为悬浮球（FAB）：折叠态抽屉 `translateX(105%)` 滑出、右下悬浮球点回；状态记忆于 `['za.drawerCollapsed']`。
- 消息列 1D 用 flex 纵向流，`gap 11px`，`padding 14px`。
- z-index：抽屉与悬浮球取最大值 `2147483647`（Shadow DOM 内单层，需盖过宿主页所有层）；不在抽屉内部堆多级 z-index。
- 触控/点击目标 ≥ 28px（受抽屉尺度约束的收敛值），间距 ≥ 8px。

## Elevation & Depth

近乎扁平。抽屉内部分层靠 `neutral → surface` 明度差 + 发丝边，不靠投影。仅两处真正悬浮的层用极淡暖色阴影：抽屉本体 `-14px 0 40px rgba(28,27,24,.12)`、悬浮球 `0 8px 26px rgba(28,27,24,.16)`。**禁止**默认毛玻璃、彩色大投影、气泡投影。

## Shapes

圆角 `none 0 / sm 6 / md 10 / lg 14 / bubble 13 / full 9999`，编辑感取中等克制值。

- 气泡 `bubble 13`，并把「说话方向」的一角收成 5px（用户气泡右下、助手气泡左下）做尖角。
- 工具卡 `md 10`，HITL 卡 `lg 14`，输入框 `md 10`。
- **禁止**对大容器、卡片、主按钮用 `full`（pill）；`full` 仅用于圆形悬浮球。
- **禁止**单边彩色描边条（`border-left/top` 作装饰）——要强调用整边、背景色块、或前置色块/图标（如模式分组的前置色块）。

## Components

- **drawer chrome** — surface 底、左 border-strong、头部 agent 软紫底（`#ECEAF3`）内含品牌标记 + 「zen-agent」衬线/半粗标题 + 收起钮（`⟩`）。滑出/收起用 `transform` + `cubic-bezier(.16,1,.3,1)` .26s。
- **brand-mark** — 黏土圆角方块 + neutral 描边 "Z"（`createElementNS` 构造的内联 SVG，**非 innerHTML**）。三处复用：工具栏图标 / 头部 / 悬浮球。**禁止**改为 emoji 或换字形。
- **bubble-user** — ink 底 + neutral 字，右对齐，右下角 5px。纯文本（`white-space: pre-wrap`）。
- **bubble-assistant** — neutral 底 + border + 左下角 5px。内容经 markdown 渲染（见 mdlite）。
- **mdlite**（助手 markdown 渲染体）— 支持标题（降级 h4–h6）/列表/粗体/行内码/围栏代码块/GFM 表格；代码与表格用 mono + surface 底 + 发丝边，`overflow-x:auto` 自滚，**无语法高亮**。全程 `createElement + textContent` 构造，**零 innerHTML**（XSS 免疫是硬约束）。
- **tool-group**（三模式分组）— `label-caps` 标题 + 前置色块（模式色），组内工具卡按 toolCallId 就地更新。见「三模式色彩语义」。
- **tool-card** — neutral 底、mono 小字、`md` 圆角、整边；状态色只上边框（运行 warning / 成功 success 底+边 / 失败 error 底+边）。摘要不含实参/密钥值（SEC-04）。
- **hitl-card**（需你确认）— clay 软底（`#F2E6DE`）+ clay 标题；正文用人话列出将发生的真实动作与实参，技术名走 mono；两个「动词+宾语」按钮（「确认执行」主按钮 clay 底 / 「拒绝」次按钮 surface+border）。
- **status** — 居中 mono 小字、error 色 + 软底，仅承载可定位不可利用的错误/状态（SEC-04），不回显 token 原文。
- **composer** — 顶发丝边；textarea `md` 圆角、surface 底、焦点 2px clay 焦点环（**不可移除**）；发送按钮 agent 紫底 + 白字。
- **fab**（最小化悬浮球）— 圆形 surface 底 + 品牌标记，`hover` 微移 `translateY(-1px)`，无 emoji。

## Do's and Don'ts

**非协商基线（标准）**

- 可访问性：对比度按上文；输入焦点环 2px 可见、禁移除；图标按钮须 `title`/`aria`；不靠颜色单独传达信息（模式分组同时用色块 + 文字标签）。
- 动效：时长 120–300ms，缓动 ease-out（`cubic-bezier(.16,1,.3,1)`），**无 bounce/elastic**；只动 `transform`/`opacity`，不动 `width/height/top/left`（拖拽改宽是用户直接操作，例外）。
- 文案：按钮用「动词 + 宾语」（「确认执行」而非「确定」）；**禁止** em dash 作分隔；**禁止** 营销词（赋能/一站式/无缝/下一代/颠覆）；写具体名词与动作。
- 渲染安全：助手内容 markdown 渲染 **MUST** 走 DOM 构造、零 innerHTML；对外文案/卡片不含密钥值或 token 原文（SEC-04）。

**风格红线（match-and-refuse，命中即重写）**

- 禁止暖奶油近白底作为「编辑感」的实现方式；温度来自 tertiary + 衬线，不来自底色。
- 禁止单边彩色描边条、渐变文字、默认毛玻璃、霓虹/发光、紫色渐变。
- 禁止 emoji 充当图标（品牌标记、模式色块、图标按钮均用 SVG/CSS，不用 emoji）。
- AI slop 测试：若有人一眼能说「这是 AI 做的」，即失败；再过一遍二阶反射检查（见 Overview）。

**Do**

- 品牌标记三处一致，作结构署名。
- 颜色只在有信号处出现（模式语义、状态、焦点），其余交给中性 + 排版。
- 每个元素都要挣得它的位置；可删则删（如折叠/关闭合一为单一「收起」）。
