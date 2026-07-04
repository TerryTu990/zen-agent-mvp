# docs — 人读层文档导航

> 本目录是 zen-agent-mvp 的人读层：设计推理、取舍论证、背景与计划都在这里。
> 执行层（AI 行为规则本体）在 `.claude/`，运行期治理制品在 `assets/`，两者不放人读内容。
> 分区遵循 Diátaxis 四象限（tutorial / how-to / reference / explanation）+ adr + roadmap。

## 分区

### reference/ — 参考（事实与结构的权威描述）

| 文档 | 内容 | 何时读 |
|---|---|---|
| [00-design-brief.md](reference/00-design-brief.md) | 设计基准（奠基期 SSOT）：定位、双版本定义、七系统速览、升级不变量 U1-U7、契约清单、决策清单、目录规划、验收基准 | 一切产物的对齐起点；与其他文档冲突时以它为准 |
| [01-architecture.md](reference/01-architecture.md) | 双版本架构（MVP 模块化单体 ↔ 标准版七系统）、七系统职责边界、三条关键时序、U1-U7 升级路径展开、风险与权衡 | 需要理解系统怎么组织、边界在哪、如何升级时 |
| [02-contracts.md](reference/02-contracts.md) | C1-C6 契约总览（指向各 `.schema.json`） | 实现或消费任一契约前 |

事实权威递变：奠基期以 00-design-brief 为准；奠基完成后逐步移交代码与各 `.schema.json`，reference 文档随之降为解释性描述。

### adr/ — 架构决策记录（为什么这么选）

设计基准 §6 的 D1-D9 各一份，格式：状态 / 背景 / 决策 / 理由 / 被否方案 / 后果。

| ADR | 决策 |
|---|---|
| [adr-001](adr/adr-001-chrome-extension-first.md) | D1 Chrome 插件优先作为 MVP 唯一客户端形态 |
| [adr-002](adr/adr-002-client-side-execution-first.md) | D2 客户端代执行优先（含"无提权面 vs 审计真实性弱一档"权衡） |
| [adr-003](adr/adr-003-decision-execution-separation.md) | D3 决策与执行分离：判定服务端 fail-closed，通道是配置维度 |
| [adr-004](adr/adr-004-modular-monolith.md) | D4 模块化单体起步，端口纪律使物理拆分廉价 |
| [adr-005](adr/adr-005-copy-zen-flux-patterns-not-code.md) | D5 复制 zen-flux 模式不共享代码（七件已验证资产） |
| [adr-006](adr/adr-006-sse-not-websocket.md) | D6 下行 SSE + 上行 HTTP，而非 WebSocket |
| [adr-007](adr/adr-007-config-files-before-ui.md) | D7 配置先文件后 UI：数据模型先于编辑界面稳定 |
| [adr-008](adr/adr-008-explanation-quality-first.md) | D8 讲解质量为第一验证目标，eval 纪律先于规模化 |
| [adr-009](adr/adr-009-no-dom-automation-in-mvp.md) | D9 MVP 不做 UI 自动化替点（DOM 级填表/点按钮） |

新增非显然决策（架构/接口/依赖层）时按同格式续编号；已接受的 ADR 不改写，推翻用新 ADR 标注取代关系。

### roadmap.md — 分期计划

[roadmap.md](roadmap.md)：MVP 内五期（M0 奠基 / M1 讲解闭环 / M2 引导 / M3 代执行+HITL / M4 审计+评测门）→ 标准版四期（S1 服务端直调 / S2 配置中心 / S3 多形态客户端 / S4 七系统拆分+状态外置），每期含验收基准与涉及模块。

### 预留分区（有真实内容时再建目录）

- **tutorial/** — 教程：手把手走一遍完整闭环（预期首篇：从零跑通 host-demo 讲解问答）。
- **how-to/** — 操作指南：面向具体任务的步骤（预期首篇：为一个新 featureId 编写四件配置）。
- **explanation/** — 解释：跨文档的概念性论述（预期首篇：装配三元组为什么这样设计）。

## 阅读路径建议

- 新加入者：00-design-brief → 01-architecture → roadmap，按需查 adr。
- 实现某模块前：02-contracts 中相关契约 + 01-architecture 对应系统边界 + roadmap 当期验收基准。
- 质疑某设计时：先查对应 adr 的"被否方案/后果"，再决定是否发起新 ADR。
