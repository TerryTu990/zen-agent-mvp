# assets/ — Zen Commerce Agent 生产配置快照根

本目录是运行期装配制品的生产快照根：`system-prompt.md`（跨功能稳定基座）+
`packs/<packId>/` 站点包 + 根 `manifest.json` registry。生产首期只安装
`xianyu-seller`，未命中闲鱼 URL 时只装配稳定基座。

## 发布纪律

- 快照内容变更必须同时提升 registry/pack 版本。
- 发布前运行 `pnpm verify:phase1` 和命中 pack 的功能评测。
- 生产按版本目录上传、完整拒载校验后切换；禁止覆盖活动快照目录。
- `examples/acceptance/packs/xianyu-seller` 保留为多 pack 验收输入，生产事实权威为本目录。
