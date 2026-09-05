# .claude/skills/ — 现状与移植计划

已落地：`release/`（发布流程 skill：服务端镜像 / 插件 zip 构建 → lingm2 部署 → 冒烟与回滚；
产物与脚本事实权威 `release/README.md`，部署面语义见 `docs/reference/04-deployment.md`）。
其余仍是按锚点触发的移植候选——锚点到达时从
`/Users/terrytu/Workspace2025/Working/zen-flux-mvp/.claude/skills/` 对应目录取源改造
（改前缀 ZF→ZA、去 zen-flux 专属路径/术语；本项目事实权威：`docs/reference/00-design-brief.md`）。

| 候选 skill（zen-flux 源） | 触发锚点（何时移植） | 改造要点 |
|---|---|---|
| `zen-agentic-engineering` | 首个跨多包/多阶段实现任务开工时 | 项目锚点（测试命令等）换本仓工具链，红线编号引用改 `ZA-` |
| `zen-decision-record` | 奠基后首个新增"非显然"架构/接口/依赖决策时 | `docs/adr/` 编号续现有 D1-D23 之后；保留"事实权威归代码、ADR 只承载人读推理"定位 |
| `zen-eval-harness` | 原锚点（评测集建立）已触发，runner 已自建于 `scripts/evals/run.mjs`；重挂锚点：判据形态大改时重估是否还要移植 | dataset 种子源改为 `assets/packs/<packId>/` + `examples/host-demo`；维度对齐 `ZA-C-EVAL-01` 闭集（讲解/装配换出/引导/工具/HITL/自动化） |
| `zen-rules-distill` | 首次怀疑 ZA 红线漂移/重复/缺口时 | 扫描前缀 `ZF-*` → `ZA-*` |
| `zen-rule-comply` | 首个新增/改动 guard hook 需回归验证时 | 依赖 session-log hook（未移植），届时同批引入并改遥测落点与编号区清单 |
| `zen-harness-construction` / `zen-agent-audit` | 装配引擎/agent loop 接口设计或行为异常定位时 | 按本项目 C6 端口（以 `packages/contracts/src/ports.ts` 导出为准）与装配链路重写，只保诊断分层法与接口设计准则骨架 |
