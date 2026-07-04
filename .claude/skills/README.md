# .claude/skills/ — 奠基期占位

本期不移植任何 skill（不写投机内容）。以下为按锚点触发的移植计划——锚点到达时从
`/Users/terrytu/Workspace2025/Working/zen-flux-mvp/.claude/skills/` 对应目录取源改造
（改前缀 ZF→ZA、去 zen-flux 专属路径/术语；本项目事实权威：`docs/reference/00-design-brief.md`）。

| 候选 skill（zen-flux 源） | 触发锚点（何时移植） | 改造要点 |
|---|---|---|
| `zen-agentic-engineering` | 首个跨多包/多阶段实现任务开工时 | 项目锚点（测试命令等）换本仓工具链，红线编号引用改 `ZA-` |
| `zen-decision-record` | 奠基后首个新增"非显然"架构/接口/依赖决策时 | `docs/adr/` 编号续 D1-D9 之后；保留"事实权威归代码、ADR 只承载人读推理"定位 |
| `zen-eval-harness` | 功能配置评测集建立时（与 `ZA-C-EVAL-01` 锚点同步） | dataset 种子源改为 `assets/features/` + `examples/host-demo`；维度对齐讲解/引导/工具/HITL/拒答 |
| `zen-rules-distill` | 首次怀疑 ZA 红线漂移/重复/缺口时 | 扫描前缀 `ZF-*` → `ZA-*` |
| `zen-rule-comply` | 首个新增/改动 guard hook 需回归验证时 | 依赖 session-log hook（本期未移植），届时同批引入并改遥测落点与编号区清单 |
| `zen-harness-construction` / `zen-agent-audit` | 装配引擎/agent loop 接口设计或行为异常定位时 | 按本项目端口（C6 四端口）与装配链路重写，只保诊断分层法与接口设计准则骨架 |
| `zen-release` | 出现第一个可分发产物时 | 不搬 zen-flux 发布线，按本项目产物形态另立 |
