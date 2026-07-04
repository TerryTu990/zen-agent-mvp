# examples/host-demo — 静态 demo 宿主 + 锚定示例配置

后续开发与评测的锚定样例（MVP 验收即对本目录闭环，见 SSOT §9）。

- `order-list.html` / `order-detail.html`：两个假功能页面，静态托管即可
  （如 `npx serve examples/host-demo`）。
- `config/`：按 C4 config-snapshot 布局的示例快照——`manifest.json`
  （契约 `packages/contracts/schemas/config-snapshot.schema.json`）+
  `features/order-list/{feature.md, facts.md, tools.json}`（tools.json 元素契约
  `tool-definition.schema.json`，含一个 `execution=client` + `riskTier=hitl` 的取消订单工具）。
- `order-detail.html` 故意不配置：featureIdRules 无命中 → 仅装配稳定基座（fail-safe），
  用作拒答边界与装配换出的观察点。
