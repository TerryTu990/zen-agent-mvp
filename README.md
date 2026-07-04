# zen-agent-mvp

嵌入式"功能辅助智能体"平台：在 ToB 宿主系统上叠加 agent，按用户当前功能动态装配
规则/skills/工具集，提供功能讲解、UI 引导与 API 调用协助。

**双版本一句话**：MVP = 模块化单体 + Chrome 插件 + git 文件配置 + 客户端代执行通道；
标准版 = 七系统独立部署 + 三形态客户端 + 双执行通道 + 配置中心——靠升级不变量 U1-U7
保证从前者平滑长成后者。

设计基准（SSOT）：`docs/reference/00-design-brief.md`；架构与升级路径：
`docs/reference/01-architecture.md`；契约总览：`docs/reference/02-contracts.md`；
决策记录：`docs/adr/`；分期计划：`docs/roadmap.md`。

## 结构

```
packages/
├── contracts/    # C1-C6 schema + TS 类型（零依赖底座，schema 为事实权威）
├── assembly/     # ② 装配引擎：快照读取、注入组合、describeInjection
├── toolgate/     # ③ 工具门禁：分级判定 fail-closed + 代执行指令签发/回收
├── llm-port/     # ④ LLM 接入：provider 白名单插拔
└── audit/        # ⑦ 观测审计：record-only 旁路 → .za/events.jsonl
apps/
├── server/       # 模块化单体组装点（唯一同时依赖全部包，U2）
└── extension/    # Chrome 插件（C3 接入层契约实现，零 @zen-agent 依赖、经 HTTP/SSE 通信）
assets/           # 运行期治理制品：system-prompt.md（ZA-SYS-*）+ features/ + skills/
examples/host-demo/   # 静态 demo 宿主页 + 示例功能配置（开发与评测锚定样例）
```

模块间禁直接 import：只经 `@zen-agent/contracts` 类型 + 端口注入，组装唯一在
`apps/server`（U2）；端口出入参全部 JSON 可序列化（U1）。

## 工具链

Node ≥22 · pnpm workspace + catalog（typescript/vitest/zod）· TypeScript 全 ESM 严格
（NodeNext / strict / noUncheckedIndexedAccess / exactOptionalPropertyTypes）· vitest 串行。

## 命令速查

| 命令 | 作用 |
|---|---|
| `pnpm install` | 安装依赖 |
| `pnpm build` | 全仓构建（`pnpm -r build`，按拓扑序） |
| `pnpm test` | 全仓测试（`pnpm -r --workspace-concurrency=1 test`，串行） |
| `pnpm lint:deps` | 依赖 lint（U2 星形组装约束，`scripts/lint-deps.mjs`） |
