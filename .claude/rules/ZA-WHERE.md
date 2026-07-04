---
paths:
  - "packages/**"
  - "apps/**"
  - "assets/**"
---

# ZA-WHERE — 架构不变量：平滑升级 U1-U7（开发期）

> 本文件按 paths 加载：操作 `packages/**` / `apps/**` / `assets/**` 时进上下文。
> 编号 `ZA-C-WHERE-<NN><级>` 与设计基准（docs/reference/00-design-brief.md）§4 的 U1-U7 一一对应；强制级语义见 `ZA-COMMON-META.md` 头。
> 这些不变量是 MVP（模块化单体）→ 标准版（七系统独立部署）平滑升级的前提——违反任何一条都会把未来拆分变成重写。

---

## ZA-C-WHERE-01*（U1）端口跨模块只传 JSON 可序列化值
**C6 四端口（AssemblyPort / ToolGatePort / LlmPort / AuditPort）的入参与返回值 MUST 全部 JSON 可序列化；MUST NOT 跨端口传函数、类实例、流句柄等进程内对象。**
- 拆服务时端口调用 1:1 替换为 RPC，签名与语义不变——升级改传输层，不改契约。
- 流式 carve-out：端口方法返回 `AsyncIterable` 且逐个产出的事件本体全部 JSON 可序列化时，视为流式 RPC（SSE）的合法进程内投影，不触发本条（LlmPort.chat 即此形态）。
- 判定：端口签名/实现出现函数、类实例、Stream、AbortSignal 等不可序列化值跨端口传递（上述流式 carve-out 除外）→ 触发，改为纯数据。

> 反例：LlmPort 返回带 `.cancel()` 方法的会话对象 → 拆分时无法过网络 → 违反 WHERE-01；
> 正解：返回纯数据 + 以 id 走独立取消调用。

---

## ZA-C-WHERE-02*（U2）模块间禁直接 import，组装唯一在 apps/server
**模块（包）之间 MUST NOT 互相 import 实现，只经 `@zen-agent/contracts` 类型 + 端口注入耦合；`apps/server` 是唯一同时 import 全部包的组装点。**
- 本条由依赖 lint 固化：根 `pnpm lint:deps`（`scripts/lint-deps.mjs`）命中即 exit 1；CI 就位时纳入门禁。
- 判定：某包 import 另一实现包（非 contracts）/ server 之外出现第二个组装点 → 触发，回退依赖。

> 反例：toolgate 直接 import assembly 读配置快照 → 横向耦合、拆分成分布式泥球 → 违反 WHERE-02；
> 正解：所需数据经端口入参传入。

---

## ZA-C-WHERE-03*（U3）工具 execution 通道闭集
**C1 工具定义的 `execution` MUST 取 `'client' | 'server'` 闭集；MVP 只实现 client 通道，`server` 枚举值 MUST 保留不删；toolgate 遇未实现通道 MUST fail-closed 拒绝而非降级。**
- 通道是工具定义里的配置维度，agent / 网关 / 客户端对通道无感知。
- 判定：类型收窄为仅 client / 流程写死客户端执行分支 / 未实现通道被静默降级执行 → 触发。

> 反例：把 `execution` 类型定义成字面量 `'client'`（"反正 server 没实现"）→ 标准版上服务端直调变全链路改造 → 违反 WHERE-03。

---

## ZA-C-WHERE-04*（U4）配置=版本化不可变快照，布局同构
**C4 快照一经产出 MUST 不可变（改配置=发新版本）；`assets/features/<id>/{feature.md, facts.md, tools.json}` + `assets/skills/<fn>/SKILL.md` + `manifest.json` 布局 MUST 与标准版配置中心发布产出物结构同构。**
- 升级=换生产端（git 文件 → 配置中心），消费端（assembly 装配引擎）零改动；灰度/回滚=切快照版本号。
- 判定：运行时就地改写快照文件 / 装配引擎读取快照布局之外的旁门配置源 → 触发。

> 反例：为"热修"让 server 运行中直接改 feature.md 且不升 manifest 版本 → 快照可变、回滚失效 → 违反 WHERE-04。

---

## ZA-C-WHERE-05*（U5）接入层契约五能力不随形态变
**C3 五能力（身份获取 / 上下文上报 / 会话 UI+HITL / 页面动作 / 代执行）与消息帧 MUST 对三形态（插件/嵌入 SDK/浏览器壳）一致；形态差异 MUST 封装在各形态实现内部，不外泄进契约。**
- 新形态只需通过同一套接入层契约验收，服务端零改动。
- 判定：契约/网关出现按客户端类型分支的字段或流程 → 触发，差异下沉回形态实现内。

> 反例：给消息帧加 `chromeExtensionOnly` 字段让网关特判插件 → 契约随形态分叉、三形态变三套后端 → 违反 WHERE-05。

---

## ZA-C-WHERE-06*（U6）审计事件 schema 独立于落点
**C5 事件结构 MUST 与 sink 解耦；MVP `.za/events.jsonl` 与标准版 DB MUST 消费同一 schema；落盘/入库前 MUST 完成脱敏。**
- 审计永远旁路 record-only：审计故障 MUST NOT 进控制流。
- 判定：事件结构绑死 jsonl 行格式 / 审计写失败阻断会话流程 / 未脱敏落盘 → 触发。

> 反例：audit 落盘异常向上抛导致 agent loop 中断 → 旁路进了控制流 → 违反 WHERE-06；
> 正解：审计失败仅本地记错，会话继续。

---

## ZA-C-WHERE-07*（U7）决策服务端 fail-closed + 代执行指令一次性签名
**分级矩阵 / HITL 判定 MUST 永远在服务端且 fail-closed（矩阵未命中、身份不明、通道未实现均拒绝）；代执行指令 MUST 一次性签名（nonce+ttl）；执行结果 MUST 经服务端 resultSchema 校验后才回喂 agent。**
- 客户端零治理判定：插件只按签名指令执行并回传，不解析工具语义；不采信客户端上报原文。
- 判定：客户端出现任何分级/HITL 预判 / 指令可重放（无 nonce/ttl）/ 客户端回传未过校验直接回喂 agent → 触发。

> 反例：插件侧"先判 riskTier 是 auto 就本地直接执行" → 不可信端做治理判定 → 违反 WHERE-07；
> 正解：一切判定走 toolgate，插件只收签名指令。
