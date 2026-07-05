# mail-compose 功能事实

> 以下结构取自 2026-07-06 真机实测（已登录态，见实施方案 §七.5 spike 结论）。

## 页面构成

- 顶层为单页应用（SPA），入口 `/js6/main.jsp`，写信页由 hash 路由承载（形如 `#module=compose.ComposeModule|{...}`），origin `https://mail.126.com`。
- 写信入口：左侧栏"写信"按钮；点击后进入写信页。
- 写信页含 4 个 iframe，**全部与顶层同源**（`contentDocument` 直接可达）；正文编辑器为其中一个无 `src` 的 iframe。

## 元素定位

- **元素 id 动态生成，勿依赖 id**：一律靠 aria-label / 可见文本 / 角色定位。
- 收件人输入框：`input.nui-editableAddr-ipt`，aria-label 含"收件人地址输入框……多人时地址请以分号隔开"；**多个收件人以分号 `;` 隔开**。
- 主题输入框：`input`，id 形如 `<动态cid>_subjectInput`（id 动态，勿硬编码）。
- 正文编辑器：位于无 `src` 的同源 iframe 内，其 `body[contenteditable="true"]`（可见区约 1134×219）即编辑区；快照器以 `[contenteditable="true"]` 选择器命中，需下钻该 iframe 后可见。
- 发送按钮：`div.js-component-button.nui-mainBtn`，内部 `span` 文本为"发送"，id 全动态。

## 帧路径与操作

- 快照 ref 带 frame 路径（如 `f1:e12`）：正文编辑等 iframe 内元素的 ref 前缀标记所在帧，dom 步进器按 frame 路径解析到对应 `contentDocument`。
- 每次页面操作后以页面实际变化为准复核（重新 `page_snapshot`），不以执行结果 `ok` 判定业务成败。
