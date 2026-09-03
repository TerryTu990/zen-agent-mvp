# adr-024: 无人值守回合的服务端收口、批准的恢复期复核与授权作用域指纹

## 状态

提议（2026-09-03，随对标优化 B3 批次立案；闭合 r1 A-ARCH-02 / A-GOV-01 / A-GOV-02，
并采纳对标模式卡 PC-ORCH-06、G1-02、G1-03/04/09、PC-GOV-08）。

## 背景

三条缺陷指向同一个结构问题：**「这次执行是否仍然被授权」这件事，服务端在关键时刻并不知情。**

1. **无人值守回合与人工回合在服务端完全同构**（A-ARCH-02、A-GOV-03）。
   网关识别到 `automationRun` 后，仍以与人工回合相同的签名调用 `runTurn`；「本回合无人在场」既不进
   `runExecSubflow` 也不进 `ToolGatePort.decide`。命中 `riskTier: 'hitl'` 时照常广播 `hitl-request` 并无界等待，
   无人在场时靠**插件**收到帧后自动回 `reject` 收尾——治理性拒绝落在不可信端，与 U7「客户端零治理判定」反向依赖。
   `riskTier: 'auto'` 的写类工具则直接执行，R7「无人值守 MUST NOT 自动执行不可撤销写操作」在服务端没有任何结构强制。

2. **用户点「停止」不吊销已登记的任务级授权**（A-GOV-01）。
   `toolgate` 的 `revokeGrants` 只在 `acceptExecResult` 收到 `error: 'user-stopped'` 时触发，
   而网关 `handleStop` 先把 messageId 标为 cancelled，`runExecSubflow` 在等待返回后一律 `cancelled() → stopped()` 提前返回，
   根本走不到 `acceptExecResult`。`ToolGatePort` 也没有任何吊销方法。结果：授权在滑动 TTL 内原样保留，
   下一轮模型复用同一 task 标题即直接放行。文档承诺的「用户停止即吊销授权」与事实不符。

3. **批准之后、签发之前不复核**（G1-02，r1 九镜头未抓到，由对标 vercel/ai 反查得出）。
   用户 approve 之后直接进入签发链路。挂起期间可能发生：页面已跳转、快照已换（旧 ref 指向别的元素）、
   用户刚在配置中心把该工具收紧到 forbidden、pack 已被禁用。这些都不复核。
   vercel/ai 对同一攻击面的处置是三重复核（签名 + 实参 schema + 重跑授权策略），并把
   「从客户端历史重建的批准」默认当作不可信输入。

4. 附带的作用域问题（A-GOV-02、G1-03/04/09）：任务级授权的键是 `(sessionId, task)`，
   而 `task` 是**模型自己写的字符串**。同会话内换一个站点、换一个 pack，只要模型沿用同一标题就能复用授权。
   openai-agents-python 对 sticky approval 的做法是绑定到服务端可验证的身份指纹，且 scope 变了就回到逐次确认。

## 决策

### D1 无人值守是一个显式的治理维度，判定回服务端

- `GateDecisionInput` 与 `IssueExecInstructionInput` 新增可选字段 `unattended?: true`（U3 加法：不传即人工回合，旧行为逐字节不变）。
- 网关在 `automationRun !== null` 的回合里，对每一次 `decide` / `issueExecInstruction` 传入 `unattended: true`。
- `toolgate` 对 `unattended` 回合：生效档为 `hitl` 一律 `deny`，`reason: 'hitl-unattended'`，**并且不消费任务级授权**
  （无人值守回合 MUST NOT 因为「同任务此前有人批准过」而放行）；`auto` 档维持现状放行。
- 审计事件 `tool-decision` 以该 reason 落盘，使「无人值守时没有静默执行需确认项」成为机械可检事实。
- 插件侧原有的自动 `reject` 退化为展示兜底，不再是治理收口的依赖。

**明确不做**：`readOnly` / `irreversible` 的工具级声明（PC-GOV-08 的另一半）。
`auto` 档写类工具在无人值守下仍会执行——这一半维持 adr-021 已登记的锚点（首个 `readOnly: false` 模板 / 第二个履约 pack 接入时），
本 ADR 只把「服务端知道本轮无人值守」这个**前提**建立起来。这是有意的范围收窄，不是遗漏。

### D2 撤回权必须可达：吊销进端口

- `ToolGatePort` 新增 `revokeHitlGrants(sessionId: string): Promise<void>`（纯数据入参，满足 U1；
  MUST NOT 把回调塞进端口）。
- `handleStop` 在标记 cancelled 之后同步调用它；调用失败只记本地错误、不阻断停止流程（停止本身不能因吊销失败而失败）。
- `acceptExecResult` 里既有的 `user-stopped` 吊销分支保留（客户端在步间检查点抢先回传时仍然有效），两条路径幂等。

### D3 批准在恢复执行前必须重新成立

用户批准的是**当时那个动作**，不是一张长期通行证。approve 之后、签发之前，服务端重跑：

1. 分级判定与 L2 收紧终值（挂起期间用户可能刚收紧了该工具）；
2. 围栏校验（origin + pathPrefixes，按当前目标页）；
3. dom 步骤校验（动作闭集 + ref 出自**最近**快照——挂起期间页面若已重采，旧 ref 必然失配）；
4. 工具是否仍在本轮工具面内（pack 可能已被禁用）。

任一不过：不登记授权、不签发指令，回喂 `ok: false` 观测并如实告知用户（R6）。
新增 deny reason `approval-stale`。

**与 vercel/ai 的差异**：该样本还给批准项本身加了签名（绑定 approvalId + toolCallId + toolName + 实参摘要），
因为它的批准可以从客户端消息历史重建。zen 的 pending 在服务端内存、客户端只回 `{hitlId, decision}` 引用，
不存在「客户端重建批准」的攻击面，故**不引入批准签名**——锚点：HITL pending 持久化跨端恢复时（设计基准 §2 已登记）。

### D4 授权作用域绑定服务端可验证的指纹

任务级授权的键由 `(sessionId, task)` 改为 `(sessionId, packId, origin, task)`：
`packId` 与 `origin` 都是服务端自持的事实（来自装配结果与当前目标页），模型无法自述。
跨站/跨 pack 沿用同一 task 标题不再复用授权——这正是 adr-013 §6 登记的「沿用旧标题挂靠已授权任务」风险的收口。

`task` 本身仍是模型提供的字符串，**不做归一化**（不 trim、不小写化、不模糊匹配），避免引入新的模糊命中面。

## 后果

- **正面**：R7 在服务端有了结构落点；「停止」这一用户撤回动作真正生效；批准不再是长期通行证；
  授权作用域不再由模型自述决定。四条都从「靠约定/靠客户端」变成「服务端可判定 + 可审计」。
- **代价**：跨站任务会多出一张确认卡（这正是被闭合的洞，不是回归）；
  挂起期间页面变化会让批准失效并要求重新确认，用户可感知为「又问了一次」——
  以 `approval-stale` 的明确文案说明原因，而不是静默重弹。
- **兼容**：三处契约扩展全部是 U3 加法（可选字段 + 新端口方法 + 新 deny reason），旧调用点不传即维持基线行为。
- **未了结**（带锚点）：`readOnly`/`irreversible` 工具声明（adr-021 D3 锚点）；批准项签名（HITL pending 持久化时）；
  无人值守的 `defer` 档（把待批准项留给用户事后处理——需要 pack 契约与面板新表面，本轮不做）；
  人工确认等待上限的**默认值**——机制已落地（env `ZA_HITL_TIMEOUT_MS`，到期合成 reject 并以
  `tool-decision reason=hitl-timeout` 留证），但未设即维持无界等待，故默认部署下人工回合仍可能长挂。
  定默认值须有真实等待时长分布支撑（拍一个值会把正常思考时间误判成超时），
  锚点：首个长时无人看管部署上线、或面板出现"确认卡待办"表面时。
