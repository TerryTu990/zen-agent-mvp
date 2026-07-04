# zen-agent-mvp 设计基准（Design Brief · 奠基期 SSOT）

> 本文件收敛 2026-07-04 与 Terry 的架构对谈结论，是奠基期（契约/治理/骨架/文档）的单一事实源。
> 后续产物与本文件冲突时，以本文件 + Terry 裁决为准；奠基完成后事实权威逐步移交代码与各 `.schema.json`。

## 1. 项目定位与宗旨

嵌入式"功能辅助智能体"平台：在 ToB 内部系统（下称**宿主系统**）上叠加一个 agent，
按用户当前所在功能（`featureId`）动态装配规则/skills/工具集，提供：

1. **功能讲解**（这个页面/字段/流程是什么、怎么用）
2. **UI 引导**（高亮/滚动到目标元素，"该点这里"）
3. **API 调用协助**（以用户身份代发宿主 API 请求，替用户完成操作）

**宗旨基准**（一切复杂度须能自证，否则不引入）：**如何让 agent 更准确地辅助用户使用宿主系统**。

参照系：本平台的机制层大量复用 zen-flux-mvp 已验证的模式（装配三元组、tool_call 门禁、HITL 卡片、
事件旁路审计、provider 插拔、eval 纪律），但**只复制模式与契约、不共享代码**（两产品演进方向不同）。

## 2. 双版本定义

| 维度 | MVP（先行落地） | 标准版（完整形态） |
|---|---|---|
| 客户端形态 | **仅 Chrome 插件** | 插件 / 嵌入 SDK / 浏览器壳 三形态，同一接入层契约 |
| 能力 | 讲解 + UI 引导 + API 调用协助（三者必须） | 同左 + 配置后台化 + 灰度 |
| 工具执行通道 | **客户端代执行优先**（签名一次性指令下发 → 插件在页面环境以用户会话发请求 → 结果回传校验）；`server` 通道枚举保留、暂不实现 | 双通道齐备：服务端直调（token 化 API 首选）+ 客户端代执行（legacy 扩展项） |
| 服务端部署 | 模块化单体（一个 Node 进程；模块=包，组装唯一在 apps/server） | **七系统独立部署**（接入层分发 / 会话网关 / 工具执行 / LLM 接入 / 配置中心 / 身份联邦 / 观测审计） |
| 配置 | **git 文件即配置**（`assets/features/<id>/`），无后台 UI | 配置中心后台 UI + 版本化发布 + 发布评测门 + 灰度 |
| 身份 | 对接企业 SSO / 简化 token，claims 结构即按标准版契约 | 完整身份联邦（宿主/SSO 签发短期 JWT） |
| 多用户 | 单租户多用户（会话按 userId 隔离；状态存本地 SQLite/文件，**接口按可外置设计**） | 多租户、会话状态外置（Redis/DB）、网关无状态水平扩展、SSE 集群 pub/sub、配额计量 |
| HITL | 有（分级矩阵命中即挂起，插件弹卡片确认） | 同左 + pending 持久化跨端恢复 |
| 评测 | 手动跑评测脚本（功能配置质量回归） | 评测门内置发布流程 |

## 3. 七系统与职责边界（速览）

| # | 系统 | 职责 | MVP 落点 | 标准版落点 |
|---|---|---|---|---|
| ① | 客户端接入层 | 身份获取、上下文上报（featureId+白名单快照）、会话 UI+HITL 卡片、页面动作（高亮）、代执行 | apps/extension（Chrome 插件） | 三形态各自实现同一契约 |
| ② | 会话网关 | 验 token、会话生命周期、**装配**（featureId→基座+规则块+skills+工具白名单，每轮换出）、agent loop、SSE 下发 | apps/server 内模块 | 独立服务，状态外置 |
| ③ | 工具执行层 | **唯一决策点**（分级矩阵+身份校验，fail-closed）+ 双通道执行器 + observation 规整回喂 | packages/toolgate（MVP 只实现 client 通道） | 独立服务 |
| ④ | LLM 接入层 | provider 白名单插拔、密钥托管、配额计量、故障切换 | packages/llm-port | 独立服务 |
| ⑤ | 配置中心 | featureId 管理、四件配置（规则 md/skills/工具定义/分级矩阵）、版本化快照发布 | git 文件 + assets/ 布局 | 独立后台系统 |
| ⑥ | 身份联邦 | 信任契约：短期 JWT 签发/验签/透传；平台零特权、不建账号 | 网关内验签模块 | 独立/复用企业 IAM |
| ⑦ | 观测审计 | record-only 旁路事件流（脱敏落盘）、操作审计、质量指标 | packages/audit → `.za/events.jsonl` | 独立服务 + DB |

**边界铁律**：装配对 agent 透明（治理不可被对话内容改变）；决策（分级/HITL）永远服务端，客户端零治理判定；审计永远旁路，故障不进控制流。

## 4. 平滑升级不变量（红线，须落入 `.claude/rules/`）

- **U1** 端口跨模块只传 JSON 可序列化值——拆服务时端口→RPC 不改契约。
- **U2** 模块间禁直接 import：只经 `@zen-agent/contracts` 类型 + 端口注入；组装唯一在 `apps/server`（依赖 lint 固化）。
- **U3** 工具定义含 `execution: 'client' | 'server'` 闭集；MVP 只实现 client，`server` 枚举值保留不删。
- **U4** 配置 = 版本化不可变快照；MVP 文件布局与标准版配置中心产出物**同构**（升级=换生产端，不换消费端）。
- **U5** 客户端接入层契约五能力不随形态变：身份获取 / 上下文上报 / 会话 UI+HITL / 页面动作 / 代执行。
- **U6** 审计事件 schema 独立于落点（MVP jsonl → 标准版 DB，只换 sink 不换 schema）。
- **U7** 决策（分级矩阵/HITL）永远服务端 fail-closed；代执行指令必须一次性签名（nonce+ttl），结果回传经服务端 schema 校验后才回喂 agent。

## 5. 契约清单（Phase 0 产物，各出 `.schema.json` + 契约文档）

- **C1 工具定义模型**（`tool-definition`）：`{id, featureIds[], description(面向 LLM), params(JSON Schema), execution('client'|'server'), riskTier('auto'|'hitl'|'forbidden'), adapter(client: 请求模板/server: API 映射), resultSchema}`。riskTier 即"操作分级矩阵"的落点。
- **C2 身份契约**（`identity-claims`）：JWT claims 闭集 `{sub, tenant, roles[], hostUserId, iss, exp(短时效)}`；平台零特权、工具执行透传用户身份。
- **C3 客户端接入层契约**（`client-access-layer`）：五能力接口 + 消息帧——上行（HTTP）：context-report / user-message / hitl-decision / exec-result；下行（SSE）：text-delta / tool-card / hitl-request / exec-instruction（签名+nonce+ttl）/ guide-action。
- **C4 配置快照**（`config-snapshot`）：`assets/features/<id>/{feature.md(规则), facts.md(事实), tools.json(工具+分级)}` + `assets/skills/<fn>/SKILL.md` + `manifest.json{version, featureIdRules(url→id 映射)}`。
- **C5 审计事件**（`audit-event`）：会话/装配/工具决策/执行/HITL 裁决全链路事件结构，落盘前脱敏。
- **C6 模块端口**（TS 类型，`packages/contracts`）：`AssemblyPort / ToolGatePort / LlmPort / AuditPort`，全部满足 U1。

## 6. 关键决策记录（源自架构对谈，落 `docs/adr/`）

- **D1 Chrome 插件优先**：同时覆盖可改造/不可改造宿主，企业可策略分发，倒逼接入层契约自足（拿不到宿主配合则所有能力必须自给）。
- **D2 客户端代执行优先**（Terry 裁定）：宿主多为 legacy/cookie 会话的内部系统，零改造接入优先；且客户端执行从构造上就是用户权限、无提权面。服务端直调保留为标准版主通道。
- **D3 决策与执行分离**：判定（分级/HITL）服务端 fail-closed，执行通道是工具定义里的配置维度，agent 对通道无感知。
- **D4 模块化单体起步**：端口纪律（U1/U2）使物理拆分廉价；将来先拆 LLM 接入层。
- **D5 复制 zen-flux 模式不共享代码**：搬七件已验证资产——装配三元组（稳定基座+换出块+skillsOverride）、tool_call 门禁（禁 setActiveTools 路线）、注入自省（describeInjection 同源）、HITL 卡片回喂、events 旁路审计、provider 插拔白名单、eval 纪律。
- **D6 SSE 而非 WS**：单向下行+HTTP 上行，负载均衡亲和、断线重连简单。
- **D7 配置先文件后 UI**：配置数据模型先于编辑界面稳定，避免把不稳定模型焊死在表单里。
- **D8 讲解质量为第一验证目标**：配置内容质量决定产品成败，eval 纪律先于规模化引入。
- **D9 MVP 不做 UI 自动化替点**（填表/点按钮的 DOM 自动化）：引导高亮 + API 代执行覆盖主要价值；DOM 自动化可靠性不足，锚点=标准版后按真实需求评估。

## 7. 治理适配原则（`.claude/` 建设，参照 zen-flux-mvp、注意适用性）

- **照抄改造**（改前缀 `ZA-`、改宗旨为本项目宗旨）：COMMON-META（宗旨基准/执行层⟂人读层/尺寸守卫 ≤200 行）、COMMON-WHEN（deferral 有界/验证通过才称完成）、COMMON-HOW（六条编码元准则+注释纪律）、COMMON-HOW-PROJECT（ESM/严格基线/catalog/测试串行）、COMMON-SEC（secret 永不入仓、凭证读禁区、错误不泄敏）。
- **适配重写**：WHERE → 以 U1-U7 升级不变量为本项目架构红线；AGENT → 运行期治理（`assets/` 装配制品）MUST NOT 进开发会话，与 zen-flux 同款铁律；EVAL → 评测对象改为功能配置质量（讲解正确/引导命中/工具触发/HITL 触发/拒答边界）。
- **不抄**：ZF-DOMAIN（DSL schema 族）、五相门控相关、画布投影相关。
- **hooks**：移植 secret-guard（凭证闭集拦截）、bash-guard（禁 --no-verify+commit 暂存扫描）、verify-on-stop（未验证提示）；去 zen-flux 专属路径与术语；settings.json 相应挂载。
- **运行期治理布局**：`assets/{system-prompt.md, features/, skills/}` 由平台运行时装配注入，编号 `ZA-SYS-*` / `ZA-FEAT-*`。

## 8. 目录规划

```
zen-agent-mvp/
├── CLAUDE.md                     # 开发期速查入口（红线摘要+治理分层+索引）
├── README.md                     # 结构/工具链/命令/配置
├── docs/
│   ├── reference/00-design-brief.md      # 本文件
│   ├── reference/01-architecture.md      # 双版本架构 + 七系统边界 + 升级路径
│   ├── reference/02-contracts.md         # 契约总览（指向各 schema）
│   ├── adr/                              # D1-D9 决策记录
│   └── roadmap.md                        # MVP→标准版分期
├── .claude/{rules/ZA-*.md, hooks/, skills/, settings.json}
├── packages/
│   ├── contracts/    # C1-C6 schema + TS 类型（零依赖底座）
│   ├── assembly/     # 装配引擎（快照读取、注入组合、describeInjection）
│   ├── toolgate/     # 分级判定 + 代执行指令签发/回收
│   ├── llm-port/     # provider 插拔
│   └── audit/        # record-only 事件旁路
├── apps/
│   ├── server/       # 模块化单体组装点（HTTP+SSE；唯一同时 import 全部包）
│   └── extension/    # Chrome 插件（接入层契约实现）
├── assets/           # 运行期治理制品（system-prompt + features/ + skills/）
└── examples/host-demo/   # 静态 demo 宿主页 + 一个完整示例功能配置
```

工具链对齐 zen-flux：Node ≥22、pnpm workspace + catalog、TS 5.8 全 ESM 严格、vitest 串行。

## 9. MVP 验收基准

1. 插件连上 server，对 `examples/host-demo` 完成闭环：URL 推断 featureId → 装配 → 讲解问答 / 高亮引导 / 一次 HITL API 代执行。
2. `.za/events.jsonl` 有全链路审计事件（脱敏）。
3. `pnpm -r build` + `pnpm -r test` 绿；依赖 lint（U2）通过。

## 10. 本期（奠基 workflow）范围声明

本期产出 = 治理资产 + C1-C6 契约 + 架构文档/ADR/roadmap + **可编译骨架**（各包 ports/类型/最小实现骨架 + 示例配置），**不含功能实现**。功能实现按 roadmap 分期在本目录续作，每期遵循 ZA 红线与 eval 纪律。
