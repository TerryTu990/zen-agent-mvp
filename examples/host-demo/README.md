# examples/host-demo — 静态 demo 宿主 + 锚定示例配置

后续开发与评测的锚定样例（MVP 验收即对本目录闭环，见 SSOT §9）。

- `order-list.html` / `order-detail.html`：两个假功能页面，静态托管即可
  （如 `npx serve examples/host-demo`）。
- `config/`：按 C4 config-snapshot 布局的示例快照——`manifest.json`
  （契约 `packages/contracts/schemas/config-snapshot.schema.json`）+
  `features/{order-list, order-detail}/{feature.md, facts.md, tools.json}`（tools.json
  元素契约 `tool-definition.schema.json`；order-list 含一个 `execution=client` +
  `riskTier=hitl` 的取消订单工具，order-detail 无工具）。
- 两页各有功能配置，页面跳转即装配换出观察点；featureIdRules 无命中 → 仅装配
  稳定基座（fail-safe）的场景用未登记 URL 在集成测试覆盖。
