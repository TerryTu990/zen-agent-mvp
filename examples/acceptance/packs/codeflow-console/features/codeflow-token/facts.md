# codeflow-token 功能事实

## 页面构成

- 这是 CodeFlow 控制台的"令牌"页（`/console/token`）：以表格列出用户的 API 令牌，列为 名称 / 分组 / 密钥 / 可用模型 / 操作。
- "添加令牌"按钮：打开创建令牌对话框，需填名称并选择令牌分组。
- 每个令牌行可"显示/复制"密钥、编辑、禁用、删除。

## 令牌用途

- API 令牌（key，形如 `sk-...`）用于以 OpenAI 兼容协议调用 CodeFlow 中转的大模型。
- 用法：请求头 `Authorization: Bearer <key>`，接口 base URL `https://codeflow.asia/v1`（如 `POST /v1/chat/completions`）。
- 令牌分组决定计费倍率：`ato` = 1x（最低），其余分组倍率更高。

## 操作 API

- 创建令牌：`POST /api/token/`，以用户会话身份发起，成功返回 `{ "success": true }`；对应工具 `codeflow-token.create-token`（默认分组 `ato`、永不过期、不限额度）。
- 取回令牌列表：`GET /api/token/?p=1&size=20`，返回 `{ "success": true, "data": { "items": [ { "name", "key", "group", ... } ] } }`；对应工具 `codeflow-token.get-token-key`，用于取回刚创建令牌的密钥（按名称在 `data.items` 中定位）。

## 站点组件库交互提示（Semi Design）

- 本站 UI 使用 Semi Design 组件库：下拉选择（Select）不是原生 `<select>`——必须先点击展开下拉、再**点击选项行**完成选择，仅在输入框内填字不会选中任何值。
- 令牌分组等选择项均属此类下拉：走 page-operate 时用 click 命中选项行，不要用 fill 假设已选。
- 任一操作步之后以页面实际变化为准复核（重新 page_snapshot），不以执行结果 `ok` 判定业务成败。
