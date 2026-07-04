# zen-agent-mvp Roadmap（MVP 分期 → 标准版分期）

> 人读层计划文档。事实权威：`reference/00-design-brief.md`（SSOT）；架构与升级不变量见 `reference/01-architecture.md`；决策依据见 `adr/`。
> 每期遵循 ZA 红线与 eval 纪律（adr-008）；分期边界可随真实进展调整，但升级不变量 U1-U7 不随分期妥协。

## 总览

```
MVP（模块化单体 + Chrome 插件 + git 配置 + client 通道）
  M0 奠基 ─► M1 讲解闭环 ─► M2 引导 ─► M3 代执行+HITL ─► M4 审计+评测门
                                                            │
                                                     MVP 验收（SSOT §9）
                                                            ▼
标准版（七系统 + 三形态 + 双通道 + 配置中心）
  S1 服务端直调通道 ─► S2 配置中心 ─► S3 多形态客户端 ─► S4 七系统拆分+状态外置
```

## MVP 分期

### M0 奠基（本期）

范围（SSOT §10）：治理资产 + C1-C6 契约 + 架构文档/ADR/roadmap + 可编译骨架（各包 ports/类型/最小实现骨架 + 示例配置），不含功能实现。

- 涉及模块：`.claude/`（ZA 红线/hooks/settings）、`docs/`（本套文档）、`packages/contracts`（C1-C6 schema + TS 类型）、各包骨架（assembly / toolgate / llm-port / audit）、`apps/{server,extension}` 骨架、`assets/` 布局、`examples/host-demo` 雏形。
- 验收基准：
  1. C1-C6 各有 `.schema.json` + 契约文档（`reference/02-contracts.md`）；
  2. `pnpm -r build` 绿（骨架可编译）；依赖 lint（U2）挂上并通过；
  3. 治理资产就位：ZA 红线 + hooks 挂载生效；
  4. 本套文档（01-architecture / adr-001..009 / roadmap / docs README）与 SSOT 无冲突。

### M1 讲解闭环

范围：第一条端到端能力——插件连上 server，对 `examples/host-demo` 完成 URL 推断 featureId → 装配 → 讲解问答（时序见 01-architecture §4.1/§4.2）。

- 涉及模块：`apps/extension`（身份获取、上下文上报、会话 UI、SSE 消费）、`apps/server`（会话网关：验签/会话/agent loop/SSE）、`packages/assembly`（快照读取、注入组合、describeInjection）、`packages/llm-port`（首个 provider）、`assets/`（system-prompt 基座）、`examples/host-demo/config/`（feature.md/facts.md/manifest.json——MVP 装配引擎 snapshotRoot 指向该示例快照）。
- 验收基准：
  1. 在 host-demo 页面提问，得到基于该功能配置的正确讲解（流式气泡）；
  2. 页面跳转后 featureId 切换、装配换出（describeInjection 可见注入变化）；
  3. 配置未覆盖的问题得到明确拒答而非编造（拒答边界首次可观察）。

### M2 引导

范围：UI 引导能力——agent 产出 guide-action，插件在宿主页面高亮/滚动到目标元素。

- 涉及模块：`apps/extension`（页面动作执行：高亮/滚动）、`packages/contracts`（guide-action 帧落地）、`examples/host-demo/config/`（补引导锚点事实）、`apps/server`（下发链路）。
- 验收基准：
  1. "在哪操作"类提问触发 guide-action，目标元素被正确高亮；
  2. 锚点失配（元素不存在）时插件如实回报、agent 如实告知用户，不假装成功；
  3. 引导不引入任何客户端治理判定（边界铁律复查）。

### M3 代执行 + HITL

范围：API 调用协助全链路——tool_call → toolgate 分级判定 → HITL 卡片 → 一次性签名指令 → 页面代执行 → 结果校验回喂（时序见 01-architecture §4.3）。

- 涉及模块：`packages/toolgate`（分级矩阵判定 fail-closed、指令签发/回收、nonce+ttl、resultSchema 校验）、`apps/extension`（HITL 卡片、代执行、结果回传）、`apps/server`（挂起/恢复编排、hitl-request/exec-instruction 下发）、`examples/host-demo/config/`（tools.json 补三档 riskTier 示例）。
- 验收基准：
  1. `auto` 工具直通执行、`hitl` 工具挂起弹卡确认、`forbidden` 工具被拒且 agent 收到规整拒绝 observation——三档各至少一例走通；
  2. 用户拒绝 HITL 后 agent 得到"用户拒绝"回喂并妥善收尾；
  3. 指令重放（nonce 复用）与超时（过 ttl）被服务端拒绝；伪造/畸形 exec-result 不通过 resultSchema、不进 agent 上下文；
  4. 一次完整 HITL API 代执行在 host-demo 上闭环（对齐 SSOT §9-1 最后一环）。

### M4 审计 + 评测门

范围：观测审计全链路 + eval 纪律就位（adr-008），补齐 MVP 验收的剩余两条。

- 涉及模块：`packages/audit`（C5 全链路事件：会话/装配/工具决策/执行/HITL 裁决，脱敏落盘 `.za/events.jsonl`）、评测脚本与评测集（讲解正确 / 引导命中 / 工具触发 / HITL 触发 / 拒答边界 五维度）、各模块补事件埋点。
- 验收基准：
  1. 跑完一次 M1-M3 全能力操作后，`.za/events.jsonl` 含全链路事件且已脱敏（抽查无 secret/凭证真值）；
  2. 审计旁路性验证：audit sink 故障时主链路行为不变；
  3. 评测脚本可对 host-demo 配置跑五维度评测并出报告；配置改动跑评测回归的纪律写入开发流程。

### MVP 验收（对齐 SSOT §9）

1. 插件连上 server，对 `examples/host-demo` 完成闭环：URL 推断 featureId → 装配 → 讲解问答 / 高亮引导 / 一次 HITL API 代执行。【M1+M2+M3】
2. `.za/events.jsonl` 有全链路审计事件（脱敏）。【M4】
3. `pnpm -r build` + `pnpm -r test` 绿；依赖 lint（U2）通过。【M0 起持续】

## 标准版分期

### S1 服务端直调通道

范围：③ 工具执行层补 `execution: 'server'` 执行器（token 化 API 直调），双通道齐备；server 成为首选主通道，client 降为 legacy 扩展项（adr-002 权衡的审计真实性在此补齐）。

- 涉及模块：`packages/toolgate`（server 执行器、宿主 API 映射 adapter）、⑥ 身份联邦（用户身份透传到直调请求）、C1 工具定义（无 schema 变更——U3 枚举早已保留）。
- 验收基准：同一工具定义仅改 `execution` 字段即从 client 切到 server，agent/网关/客户端零改动；server 通道执行的审计事件含服务端直接观测的请求/响应记录。

### S2 配置中心

范围：⑤ 从 git 文件升级为配置后台——featureId 管理、四件配置编辑、版本化快照发布、发布评测门（继承 M4 评测集）、灰度。

- 涉及模块：新配置中心系统（后台 UI + 发布流水线）、`packages/assembly`（零改动——U4 快照同构验证点）、M4 评测资产（接入发布门）。
- 验收基准：配置中心发布的快照与 git 文件布局同构、装配引擎无改动直接消费；未过评测门的配置无法发布；可按快照版本灰度与回滚。

### S3 多形态客户端

范围：① 扩展为三形态——补嵌入 SDK 与浏览器壳，同一 C3 契约。

- 涉及模块：新 `apps/sdk`、新浏览器壳应用、C3 契约测试套件（三形态共同验收门，U5 验证点）、`apps/server`（零改动目标）。
- 验收基准：三形态通过同一套接入层契约测试；服务端无任何按客户端形态的分支；HITL/代执行语义三形态一致。

### S4 七系统拆分 + 状态外置

范围：物理拆分为七系统独立部署——先拆 ④ LLM 接入层（adr-004），再依次拆 ③ 工具执行、⑦ 观测审计（jsonl→DB，U6）等；② 会话网关状态外置（Redis/DB）+ 无状态水平扩展 + SSE 集群 pub/sub；多租户与配额计量。

- 涉及模块：全部包→服务化（端口→RPC，U1 验证点）、会话状态存储、SSE pub/sub 基础设施、⑦ 独立服务+DB、租户隔离与配额。
- 验收基准：每拆一个服务，C6 端口契约不变（调用方只换传输实现）；网关多实例下会话与 SSE 正常；审计 schema 不变、历史 jsonl 可导入新 sink；多租户数据隔离通过验证。

## 分期依赖与原则

- M 线严格串行（每期建立在上期闭环上）；S 线按客户需求可调序，但 S4 依赖 S1-S3 对 U1-U7 的持续验证。
- 每期完成判定以本文验收基准为准，未验证不称完成；带未了结 deferral 的期不迁完成态。
- U1-U7 是贯穿全部分期的红线：任何一期为赶进度破坏不变量，等于把该期成本转嫁给 S4。
