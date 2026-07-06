# docs — 人读层文档导航

> 本目录是 zen-agent-mvp 的人读层：设计推理、取舍论证、背景与计划都在这里。
> 执行层（AI 行为规则本体）在 `.claude/`，运行期治理制品在 `assets/`，两者不放人读内容。
> 分区遵循 Diátaxis 四象限（tutorial / how-to / reference / explanation）+ adr + roadmap。

## 分区

### reference/ — 参考（事实与结构的权威描述）

| 文档 | 内容 | 何时读 |
|---|---|---|
| [00-design-brief.md](reference/00-design-brief.md) | 设计基准（奠基期 SSOT，头部附奠基后演进勘误）：定位、双版本定义、七系统速览、升级不变量 U1-U7、契约清单、决策清单 D1-D13 | 对齐项目定位与不变量时；历史原貌保留，现状以勘误与 01/02/03 为准 |
| [01-architecture.md](reference/01-architecture.md) | 双版本架构、七系统职责边界、六条关键时序（含 dom 代操作/跨站任务组/上下文治理）、U1-U7 升级路径、**模块边界与扩展点清单**（§7） | 需要理解系统怎么组织、边界在哪、怎么扩展时 |
| [02-contracts.md](reference/02-contracts.md) | C1-C6 契约总览（adapter 三形 × hitlMode、registry/pack 两级快照、六端口现签名、内建工具） | 实现或消费任一契约前 |
| [03-configuration.md](reference/03-configuration.md) | 配置参考：站点包目录树与字段表、**新增站点完整示例**、环境变量全表、凭证注入、运行数据落点 | 新增/修改站点配置、部署配置排障时 |
| [04-deployment.md](reference/04-deployment.md) | 部署参考：Docker 镜像构建、卷规划（站点包外挂不进镜像）、secret 注入、日志双通道、健康检查 | 发布服务端到容器环境时 |

事实权威递变：奠基期以 00-design-brief 为准；奠基已完成，**事实权威在代码与各 `.schema.json` / `ports.ts`**，reference 文档为解释性描述（与代码冲突时以代码为准）；站点包/任务组/上下文治理的决策推理以 adr-013 为准。

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
| [adr-010](adr/adr-010-api-invocation-forms.md) | D10 API 调用形式：server 直调在 MVP 落地（credentialRef 凭证注入），双通道并存 |
| [adr-011](adr/adr-011-visible-dom-operation.md) | D11 可见页面代操作：dom 通道（每步高亮 + 闭集步骤 + 任务级授权），取代 D9 的"不做" |
| [adr-012](adr/adr-012-session-tab-group.md) | D12 会话=标签组：显式点图标建组（会话组语义被 adr-013 吸收） |
| [adr-013](adr/adr-013-site-pack-and-cross-site-task-group.md) | D13 站点包与跨站任务组：registry/pack 两级、site 围栏、per-origin 身份、上下文治理 P0-P2 |

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
