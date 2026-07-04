# adr-011: 可见页面代操作 = agent-in-the-loop + content-script DOM 原语（修订 adr-009）

## 状态

已接受（2026-07-05，Terry 裁定；修订 adr-009）

## 背景

Terry 明确 MVP 真实需求：用户要**看到** agent 在页面上操作（如建 key 时页面切到 /console/token、可见点击填写）——adr-009 预留的"真实需求出现"锚点提前到来。交互范式参考 claude-in-chrome（观察→决策→操作→再观察），但其 CDP/debugger 机制不可采用。

## 决策

新增「客户端 DOM 代操作」形态（adr-010 表中②），归属 **delegated-execution**（带副作用，走 U7 全套治理），而非 page-action（纯引导）：

- **agent-in-the-loop 分批签发**：content script 采集 **DOM 快照**（可交互元素清单，ref 编号）上报 → 服务端 agent 决策**一批**原语动作 → toolgate fail-closed 校验后一次性签名（nonce+ttl）下发 → content script 解释执行（每步先高亮再执行，用户可见）→ 页面状态实质变化时重新观察。
- **原语闭集**：`{navigate, waitFor, click, fill, select, read, scroll, highlight}`；navigate 规定为批次终结动作。签发校验：动作在闭集内、ref 出自上一份快照、URL 在功能配置的**路径围栏**内。
- **结果回喂**：`read` 步骤采集的 DOM 值作为 exec-result.body，过既有 resultSchema 校验——治理链路（判定/签名/HITL/校验）全部复用，仅新增指令类型与客户端解释器。
- **HITL 粒度**：整任务前置确认一次；破坏性单步逐个确认挂锚点（破坏性操作密集的功能上线时）。
- **禁区**：不用 CDP/chrome.debugger；不 eval 任意 JS 字符串；客户端零治理判定。
- **实施分期**：②-a 单页面（fill/click/read 通链路）→ ②-b 跨导航续跑（navigate 为观察边界，服务端 loop 收新页快照续推）。

## 理由（对 adr-009 三条否决的逐条回应）

- **可靠性**：adr-009 否决的是**静态选择器脚本**（页面改版即静默失效）；agent 临场观察快照、引用 ref 而非预存 selector，页面改版下顽健，失效形态是显式失败+可见过程而非"悄悄点错"。
- **价值**：是否值得由真实需求裁决——需求已由产品负责人明确提出。
- **治理**：声明式闭集批次可判定、可签名、可校验（read 值过 resultSchema），U7 一条不破；adr-009"DOM 序列难以同粒度治理"的前提被批次签发模型解除。
- **CDP 排除**：调试横幅对 ToB 是信任杀手；嵌入 SDK 形态根本无 debugger 能力（选 CDP 即砍掉三形态承诺，违 U5）；CDP 能力无法收敛成治理闭集。
- **三形态可移植**：快照采集器与原语解释器是纯 DOM 库，插件/SDK/浏览器壳共用；新增帧禁止形态特有字段（U5）。

## 被否方案

- **预编声明式步骤脚本回放**：每功能配置步骤+selector，配置重、改版脆、无临场智能。降级为未来优化——锚点：同场景高频重复时，把成功轨迹沉淀为缓存脚本走快路径。
- **照搬 claude-in-chrome（CDP+截图+坐标）**：见上 CDP 排除三条；另整页截图送 LLM 有隐私面，坐标有缩放误差。

## 后果

- 正：零功能级配置（只需允许 dom 操作 + 围栏策略）；"agent 真在操作"的产品智能感。
- 负：每次操作 2-3 次 LLM 决策往返（时延靠批量决策 + 叙述流填充 + 动作节奏化掩盖）；确定性低于脚本，靠围栏 + HITL + 显式失败兜底。
- 新增架构面：C1 `adapter` 判别式 union（http | dom）、C3 快照上报帧 + dom 批次指令帧、toolgate 批次校验签发、content script 快照采集器 + 原语解释器。
- 边界：非 DOM 渲染宿主（canvas/Flutter Web）本范式失效——锚点：真实宿主出现时，浏览器壳形态内部以 CDP 实现同一能力契约兜底。
