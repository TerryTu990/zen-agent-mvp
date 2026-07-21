# zen-agent-mvp 架构（双版本：MVP 模块化单体 ↔ 标准版七系统）

> 人读层参考文档。事实权威：契约细节见 `02-contracts.md` 与各 `.schema.json`、`ports.ts`；配置面见 `03-configuration.md`；部署见 `04-deployment.md`；本文负责解释结构、边界、流程与权衡。
> 决策"为什么"见 `../adr/`（adr-001..013），分期计划见 `../roadmap.md`。
> 本文已吸收 adr-010..013 演进（server/dom 通道、会话组、站点包、任务级授权、上下文治理）。

## 1. 目标与范围

### 1.1 目标

在 ToB 内部系统（宿主系统）上叠加一个嵌入式"功能辅助智能体"：按用户当前所在功能（`featureId`）动态装配规则 / skills / 工具集，提供三项能力——

1. **功能讲解**：这个页面 / 字段 / 流程是什么、怎么用；
2. **UI 引导**：高亮 / 滚动到目标元素（"该点这里"）；
3. **API 调用协助**：以用户身份代发宿主 API 请求，替用户完成操作。

宗旨基准（一切复杂度的自证问题）：**如何让 agent 更准确地辅助用户使用宿主系统**。答不上来的复杂度不引入。

### 1.2 范围

本文覆盖两个版本形态及其间的升级路径：

- **MVP**：Chrome 插件客户端 + 模块化单体服务端（一个 Node 进程），git 文件即配置，客户端代执行通道，单租户多用户。
- **标准版**：三形态客户端（插件 / 嵌入 SDK / 浏览器壳）+ 七系统独立部署，配置中心后台化，双执行通道，多租户、状态外置、水平扩展。

不在本文范围：各契约的字段级定义（→ `02-contracts.md`）、开发期治理红线（→ `.claude/rules/ZA-*.md`）、运行期治理制品（→ `assets/`）。

## 2. 背景与约束

### 2.1 背景

- 宿主系统多为 legacy / cookie 会话的企业内部系统，普遍**不可改造或改造成本高**——接入层必须自足（拿不到宿主配合时所有能力自给）。
- 机制层大量复用 zen-flux-mvp 已验证的模式：装配三元组、tool_call 门禁、HITL 卡片、事件旁路审计、provider 插拔、eval 纪律。**只复制模式与契约、不共享代码**（两产品演进方向不同，见 adr-005）。

### 2.2 约束与边界铁律

- **装配对 agent 透明**：治理（注入哪些规则/skills/工具白名单）不可被对话内容改变。
- **决策永远在服务端**：分级判定与 HITL 挂起在服务端 fail-closed；客户端零治理判定（见 adr-003）。
- **审计永远旁路**：record-only，审计故障不进控制流。
- **平滑升级不变量 U1-U7**（SSOT §4）：本文 §5 逐条展开；它们同时是开发期架构红线（`.claude/rules/`）。
- 工具链：Node ≥22、pnpm workspace + catalog、TS 5.8 全 ESM 严格、vitest 串行。

## 3. 总体架构

### 3.1 MVP：模块化单体

一个 Node 进程承载七系统中的 ②③④⑥⑦（②含⑥验签模块）；① 是 Chrome 插件；⑤ 退化为 git 文件布局。模块=包，组装唯一发生在 `apps/server`（U2）。

```
┌────────────────────────────────────────────────────────────────────┐
│ 浏览器：宿主系统页面（legacy，不可改造）——会话=标签组（adr-012/013）      │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ ① apps/extension（Chrome 插件 = 客户端接入层，实现 C3 五能力）    │  │
│  │    身份获取 │ 上下文上报 │ 会话 UI+HITL 卡片 │ 页面动作 │ 代执行   │  │
│  │    （dom 批次步进器：每步高亮可见；navigate 委托开页入组）          │  │
│  └──────────────┬──────────────────────────────▲────────────────┘  │
└─────────────────┼──────────────────────────────┼───────────────────┘
        HTTP 上行：                       SSE 下行：
        context-report / user-message    text-delta / tool-card /
        hitl-decision / exec-result      hitl-request / guide-action /
        snapshot-report                  exec-instruction(签名+nonce+ttl)
                  │                      snapshot-request
┌─────────────────▼──────────────────────────────┴───────────────────┐
│ apps/server（模块化单体：一个 Node 进程，唯一组装点）                    │
│                                                                    │
│  ② 会话网关（内部模块：gateway 回合循环 / auth 验签⑥ / sessions       │
│     会话持久化 / compress 历史压缩 / history 观测瘦身 / demo-token）    │
│     验 token → 会话生命周期 → 装配 → agent loop → SSE 下发            │
│     内建工具注入：guide_highlight / page_snapshot / pack_doc /        │
│     site_navigate（渐进披露，随装配条件注入，不入 pack tools.json）     │
│      │              │               │              │               │
│  ────┴── 端口注入（C6：AssemblyPort/ToolGatePort/LlmPort/AuditPort，  │
│          U1 只传 JSON 可序列化值；U2 模块间禁直接 import）──────        │
│      │              │               │              │               │
│  ┌───▼────────┐ ┌───▼─────────┐ ┌───▼──────────┐ ┌─▼────────────┐  │
│  │ assembly   │ │ ③ toolgate  │ │ ④ llm-port   │ │ ⑦ audit      │  │
│  │ 装配引擎    │ │ 分级判定+    │ │ provider     │ │ record-only  │  │
│  │ registry/  │ │ 任务级授权+  │ │ 白名单插拔    │ │ 事件旁路      │  │
│  │ pack 两级   │ │ 指令签发/回收│ │ (openai 兼容) │ │ (落盘前脱敏)  │  │
│  │ (⑤ 消费端)  │ │ +server 直调│ └──────────────┘ └─┬────────────┘  │
│  └───┬────────┘ └─────────────┘                    │               │
└──────┼─────────────────────────────────────────────┼───────────────┘
       │ 读取版本化快照（C4，registry/pack 两级）        │ 脱敏落盘（C5）
┌──────▼─────────────────────────┐        ┌──────────▼──────────────┐
│ ⑤ 快照根（git 文件即配置）        │        │ .za/events.jsonl        │
│  manifest.json（registry 登记）  │        │ （会话/装配/工具决策/     │
│  packs/<packId>/                │        │   执行/HITL 全链路事件）  │
│    pack.json（site 围栏+规则）    │        ├─────────────────────────┤
│    features/<id>/{feature.md,   │        │ .za/sessions/<id>.jsonl │
│      facts.md, tools.json}      │        │ （会话持久化，TTL 清理）   │
│    skills/<fn>/SKILL.md         │        └─────────────────────────┘
│    docs/*.md（渐进披露）          │
└────────────────────────────────┘
```

会话状态默认落盘 `.za/sessions/`（append-only 事件流 + 重启重放 + TTL 清理，fail-open），**接口按可外置设计**——这是 S4 状态外置的前提。

**执行通道现状（三态）**：`client`（HTTP 代执行——插件在页面环境以用户 cookie 发宿主请求）、`client+dom`（可见页面代操作——服务端签发闭集步骤批次，插件每步高亮步进）、`server`（服务端直调——`credentialRef` 运行时凭证注入，平台级只读 API）。三态均已实现，通道仍是工具定义的配置维度（U3 的"MVP 只实现 client"已被 adr-010/011 演进取代）。

### 3.2 标准版：七系统独立部署

```
     三形态客户端（① 接入层：同一 C3 契约，各自实现）
     ┌────────────┐  ┌────────────┐  ┌────────────┐
     │ Chrome 插件 │  │ 嵌入 SDK    │  │ 浏览器壳    │
     └──────┬─────┘  └──────┬─────┘  └──────┬─────┘
            └───────────────┼───────────────┘
              HTTP 上行 / SSE 下行（LB 亲和 + 断线重连）
                            │
   ┌────────────────────────▼────────────────────────┐
   │ ② 会话网关（无状态，水平扩展）                       │◄──── ⑥ 身份联邦
   │   验签 → 会话 → 装配 → agent loop → SSE 下发       │   （宿主/SSO 签发
   │   会话状态外置 Redis/DB │ SSE 集群 pub/sub          │    短期 JWT，
   └──┬───────────┬───────────────┬───────────────────┘    独立或复用 IAM）
      │ RPC(=C6   │               │
      │ 端口跨网)  │               │
 ┌────▼──────┐ ┌──▼──────────┐ ┌──▼───────────────┐
 │ ③ 工具执行 │ │ ④ LLM 接入   │ │ ⑤ 配置中心        │
 │ 双通道齐备：│ │ provider    │ │ 后台 UI + 版本化   │
 │ server 直调│ │ 插拔/密钥托管│ │ 快照发布 + 评测门  │
 │ + client   │ │ /配额/切换   │ │ + 灰度            │
 │ 代执行     │ └─────────────┘ └──────────────────┘
 └───────────┘
      ┆ 全部系统 → 事件旁路（不进控制流）
 ┌────▼─────────────────────────────────────────────┐
 │ ⑦ 观测审计（独立服务 + DB：审计事件 C5 同 schema，   │
 │   只换 sink；操作审计 + 质量指标）                   │
 └──────────────────────────────────────────────────┘
```

### 3.3 七系统职责边界

| # | 系统 | 职责（对内） | 边界（不做什么） | MVP 落点 | 标准版落点 |
|---|---|---|---|---|---|
| ① | 客户端接入层 | 身份获取、上下文上报（featureId+白名单快照）、会话 UI+HITL 卡片、页面动作（高亮）、代执行 | 零治理判定；不解析工具语义，只按签名指令执行并回传 | `apps/extension` | 三形态各自实现同一 C3 契约 |
| ② | 会话网关 | 验 token、会话生命周期、装配（featureId→基座+规则块+skills+工具白名单，每轮换出）、agent loop、SSE 下发 | 不做工具执行判定（委托③）；不持 LLM 密钥（委托④） | `apps/server` 内模块 | 独立服务，状态外置 |
| ③ | 工具执行层 | **唯一决策点**（分级矩阵+身份校验，fail-closed）+ 双通道执行器 + observation 规整回喂 | 不产生对话内容；不绕过分级矩阵 | `packages/toolgate`（仅 client 通道） | 独立服务，双通道 |
| ④ | LLM 接入层 | provider 白名单插拔、密钥托管、配额计量、故障切换 | 不感知业务语义与装配内容 | `packages/llm-port` | 独立服务 |
| ⑤ | 配置中心 | featureId 管理、四件配置（规则 md / skills / 工具定义 / 分级矩阵）、版本化快照发布 | 只产出快照，不参与运行时决策 | git 文件 + `assets/` 布局 | 独立后台系统 |
| ⑥ | 身份联邦 | 信任契约：短期 JWT 签发/验签/透传；平台零特权、不建账号 | 不存用户凭证；不代宿主鉴权 | 网关内验签模块 | 独立 / 复用企业 IAM |
| ⑦ | 观测审计 | record-only 旁路事件流（脱敏落盘）、操作审计、质量指标 | 永远旁路，故障不进控制流 | `packages/audit` → `.za/events.jsonl` | 独立服务 + DB |

## 4. 关键流程

三条时序覆盖三项产品能力的主干路径。全程 ⑦ audit 旁路记录，下文不再重复标注。

### 4.1 讲解问答（最短闭环）

```
用户 ─提问─► ①插件 ─user-message(HTTP)─► ②网关
②网关 ─验签(⑥)─► 会话定位 ─► 装配检查：featureId 未变 → 复用当前注入
②网关 ─组装上下文(基座 system-prompt + feature.md + facts.md + skills)─► ④llm-port ─► LLM
LLM ─token 流─► ④llm-port ─► ②网关 ─SSE text-delta─► ①插件 ─► 会话气泡渲染
```

要点：讲解不触发工具，质量完全由 ⑤ 的功能配置内容决定（adr-008：讲解质量是第一验证目标，eval 围绕它先行）。

### 4.2 featureId 切换 → 换装配

```
用户 ─页面跳转─► ①插件 侦测 URL 变化
①插件 ─context-report(url + 页面白名单快照 + 可选参考 featureId)(HTTP)─► ②网关
②网关 ─验签─► assembly.resolveFeature(url)：按 manifest.featureIdRules 权威判定 featureId
        （判定权威在服务端，客户端上报 featureId 仅供参考、不采信；
          无命中 → null，fail-safe 仅装配稳定基座）
②网关 ─► assembly.compose(featureId)：
        读取快照(C4) → 产出注入组合 = 稳定基座 + 换出块(feature.md/facts.md)
                        + skillsOverride + 工具白名单(tools.json)
②网关 ─替换会话当前注入（下一轮 LLM 调用生效；对 agent 透明，对话内容无法改变它）
②网关 ─SSE（可选 guide-action / 功能就位提示）─► ①插件
```

要点：featureId 判定与装配全在服务端（C3 contextReport / C4 manifest / C6 AssemblyPort 同一口径）；装配是"每轮换出"而非"会话初始化一次"——用户在宿主系统内游走时 agent 的规则面与工具面随功能同步收窄/切换；注入组合可自省（describeInjection 同源，复用 zen-flux 已验证模式）。

### 4.3 HITL API 代执行闭环（指令签发 → 页面执行 → 结果校验 → 回喂）

```
agent(LLM) ─tool_call(工具 id + params)─► ②网关 ─► ③toolgate【唯一决策点】
③toolgate 判定（fail-closed）：
   工具在当前白名单内? + 身份校验(C2 claims) + riskTier 查分级矩阵
   ├─ forbidden → 拒绝，规整 observation 回喂 agent（含拒绝原因）
   ├─ auto      → 直接进入签发（跳过挂起）
   └─ hitl      → 挂起 tool_call ─► ②网关 ─SSE hitl-request─► ①插件 弹卡片
用户 ─确认/拒绝─► ①插件 ─hitl-decision(HTTP)─► ②网关 ─► ③toolgate
   └─ 拒绝 → 释放挂起，规整 observation（用户拒绝）回喂 agent
③toolgate ─签发一次性执行指令（签名 + nonce + ttl，按 tools.json adapter 生成请求模板）
②网关 ─SSE exec-instruction─► ①插件
①插件 ─在页面环境以用户会话（cookie）向宿主 API 发请求─► 宿主系统
①插件 ─exec-result(HTTP)─► ②网关 ─► ③toolgate：
   验 nonce（一次性，防重放）+ 验 ttl + resultSchema 校验（C1）
   └─ 通过 → 规整 observation 回喂 agent ─► agent 继续/总结 ─SSE text-delta─► 用户
   └─ 不通过 → 以校验失败 observation 回喂，不采信客户端上报原文
```

要点（U7 的运行时形态）：判定与挂起全部在服务端；客户端拿到的只是"一次性、短时效、签名过"的指令，执行结果必须过服务端 schema 校验才进 agent 上下文。

**任务级 HITL 授权（adr-013，对 4.3 的演进）**：hitl 工具批准后，toolgate 以 `(sessionId, task)` 登记授权（滑动闲置 TTL，默认 15min）——同会话同任务标题的后续调用**跨工具共享**放行（含带 task 的 `site_navigate`），不再逐次弹卡。两个例外不并入复用：`hitlMode: 'every-call'` 工具（发信等对外不可撤回动作，次次单独确认，批准也不登记）与授权卡未呈现任务计划的 navigate 批准。用户点「停止」吊销本会话全部授权；授权卡展示 agent 声明的 `plan`（任务级大步骤），用户批准的即这份计划。dom 步骤校验永远先于授权复用——已授权任务的非法批次照样 deny（fail-closed 不被 grant 绕过）。

**有界自动履约（adr-016）**：可信连接器先通过进程内端口登记一次性履约意图，绑定账号、精确页面 URL/页面生命周期、商品、规范化订单、数量、消息/发送 ref、回执基线与固定正文；模型工具只传 opaque `intentId`。toolgate 匹配服务端策略并原子预占全局订单键，只构造 `fill → click`。服务端 Ed25519 私钥签名会话、绝对时限与最终请求，插件仅信任生产 HTTPS（本机开发例外）SSE 公钥，并在副作用前验签、验过期、持久化 nonce 去重。DOM 两步成功不等于送达：网关在原指令时限内强制请求发送后快照，回执仍绑定同一 URL/页面实例且数量恰增 1 才记 `completed`；其余均 `uncertain` 且不自动重试。输入值由插件不采集、网关再剥离，策略/正文不进模型或审计。

### 4.4 dom 可见页面代操作（adr-011：观察 → 操作 → 复核）

```
agent ─page_snapshot(内建观察工具)─► ②网关 ─SSE snapshot-request─► ①插件
①插件 ─扫页面可交互元素(含同源 iframe 下钻)─snapshot-report(HTTP)─► ②网关
②网关 存 domContext(ref 闭集+页路径+origin) ─快照作 observation 回喂─► agent
agent ─tool_call(dom 工具: task+plan+steps[闭集动作])─► ③toolgate
   validateDomSteps fail-closed：动作闭集 / ref 出自最近快照 / 围栏内
   riskTier=hitl → 任务级授权判定（见 4.3 演进段）→ 首批弹卡 / 同任务放行
③toolgate ─签发一次性 dom 指令─► ①插件 步进执行（每步高亮+滚动，可随时停止）
①插件 ─exec-result─► 服务端校验 → 回喂 ─► agent 重新 page_snapshot 复核页面证据
```

要点：agent 以页面实际变化（复核快照）判定业务成败，不以执行 ok 为准；`fill` 支持 input/textarea 与 contenteditable 富文本；用户「停止」即吊销授权且中止批次。

### 4.5 跨站任务组（adr-013：navigate → 回合内换装 → 任务续作）

```
agent ─site_navigate(url+task)─► ③toolgate 专路：目标须落在已安装 pack 围栏内
   带 task 且该任务已获授权 → 直接放行；否则单次 hitl 确认
①插件 background 在本组窗口开目标页并入组（会话延续，新页接入同一会话）
②网关 收到导航成功结果 → **回合内**按落点 URL 重新装配：
   规则/事实/工具面/系统注入整段覆写 + 站点边界标记入历史
agent 下一轮即持有新站上下文，直接续作任务（先 page_snapshot 观察新页）
```

要点：跨站是"一个会话、一个任务、多个站点"——featureId/pack 随落点换出，任务级授权跨站共享；per-origin 身份按 `claims.tenant` 匹配 pack.tenant 路由，site pack 的 http/server 工具要求该 origin 的宿主身份（fail-closed）。

### 4.6 会话上下文治理（adr-013 P0-P2）

- **P0 旧观测瘦身**：历史里仅最近一次 page_snapshot 留全文，更早的替换为带元素数的存根（观测是易失数据，不值长期占窗）。
- **P1 历史压缩**：token 用量（上游 usage 透传，缺省字符近似）达 `窗口 × 阈值` 时，较早回合压滚动摘要、最近 K 轮留原文；站点边界标记与任务级授权的 task 标题受保护不被摘要糊掉；摘要失败 fail-open 原样落盘。
- **P2 会话持久化**：`.za/sessions/<id>.jsonl` append-only 事件流，重启重放恢复；闲置 TTL 清理；存储故障 fail-open 转纯内存，不进控制流。
- **实参截断自愈**：模型产出的工具实参 JSON 非法/截断（`errorKind: invalid-tool-args`）时，网关不终结回合——回喂修正提示重试（上限 2 次），用户无感。

## 5. 升级路径（U1-U7 逐条展开）

本节为规范性契约段落，MUST / SHOULD 语义按 RFC 2119。每条不变量的结构：约束内容 → 它如何保证 MVP→标准版平滑升级 → 违反时的代价。

### U1 端口跨模块只传 JSON 可序列化值

- 约束：C6 四端口（AssemblyPort / ToolGatePort / LlmPort / AuditPort）的入参与返回值 MUST 全部 JSON 可序列化；MUST NOT 跨端口传函数、类实例、流句柄等进程内对象。
- 如何保平滑：S4 拆分时端口调用 1:1 替换为 RPC（HTTP/gRPC），签名与语义不变——升级改的是传输层，不是契约。
- 违反代价：任何一处传了进程内对象，拆分时该端口即需重新设计，波及双侧调用方。

### U2 模块间禁直接 import，组装唯一在 apps/server

- 约束：模块（包）之间 MUST NOT 互相 import 实现，只经 `@zen-agent/contracts` 类型 + 端口注入耦合；`apps/server` MUST 是唯一同时 import 全部包的组装点。此约束 MUST 由依赖 lint 固化（CI 门）。
- 如何保平滑：依赖图始终保持"星形组装"，任何包可单独抽出为服务而不牵动其他包；拆分顺序自由（adr-004：先拆 ④）。
- 违反代价：一条横向 import 即形成隐式耦合，拆分时变成跨服务的分布式泥球。

### U3 工具定义 execution 通道闭集

- 约束：C1 工具定义的 `execution` MUST 取 `'client' | 'server'` 闭集；toolgate 遇到未实现/未知通道 MUST fail-closed 拒绝而非降级。
- 现状：**双通道均已实现**（adr-010 提前落地 server 直调——本条不变量的价值已兑现：补 server 执行器时 agent/网关/客户端全部无感）。client 通道内又按 adapter 分形为 http 代执行与 dom 页面代操作（adr-011），分形在 adapter 维度、不扩 execution 闭集。
- 违反代价：把通道写死进类型或流程分支后，任何新执行形态都是全链路改造。

### U4 配置 = 版本化不可变快照，文件布局与配置中心产出物同构

- 约束：C4 快照一经产出 MUST 不可变（改配置=发新版本）；MVP 的 `assets/features/<id>/` 文件布局 MUST 与标准版配置中心的发布产出物结构同构。
- 如何保平滑：升级=换生产端（git 文件 → 配置中心后台+发布流水线），消费端（assembly 装配引擎）零改动；灰度与回滚天然获得（切快照版本号）。
- 违反代价：布局不同构则 S2 需要双写/迁移适配层，配置回归风险全落在装配引擎上。

### U5 客户端接入层契约五能力不随形态变

- 约束：C3 的五能力（身份获取 / 上下文上报 / 会话 UI+HITL / 页面动作 / 代执行）与消息帧 MUST 对三形态一致；形态差异 MUST 封装在各形态实现内部，不外泄进契约。
- 如何保平滑：S3 增加嵌入 SDK / 浏览器壳时，服务端一行不改；新形态只需通过同一套契约验收（同一组接入层契约测试 SHOULD 作为三形态共同验收门）。
- 违反代价：契约随形态分叉后，网关被迫按客户端类型分支，三形态变三套后端。

### U6 审计事件 schema 独立于落点

- 约束：C5 事件结构 MUST 与 sink 解耦；MVP jsonl 与标准版 DB MUST 消费同一 schema；落盘/入库前 MUST 完成脱敏。
- 如何保平滑：S4 审计独立成服务时只换 sink 实现；历史 jsonl 可直接回放导入，审计连续性不断。
- 违反代价：schema 绑死 jsonl 行格式后，换 DB 即历史不可迁、指标断代。

### U7 决策服务端 fail-closed + 代执行指令一次性签名

- 约束：分级矩阵 / HITL 判定 MUST 永远在服务端且 fail-closed（矩阵未命中、身份不明、通道未实现均拒绝）；代执行指令 MUST 一次性签名（nonce+ttl）；执行结果 MUST 经服务端 resultSchema 校验后才回喂 agent。
- adr-011/013 后的延伸面（同一不变量的新落点）：dom 批次步骤校验（动作闭集 / ref 出自最近快照 / 路径围栏）、site 围栏（http/server 请求 URL 与 navigate 目标的 origin+location 围栏）、per-origin 身份（site pack 工具要求该 origin 宿主 claims）、任务级授权复用永远在步骤校验**之后**（grant 不绕过 fail-closed）。
- 如何保平滑：安全模型从 MVP 第一天就是标准版形态——拆 ③ 为独立服务时，信任边界不移动、不需要重新安全评审整个链路。
- 违反代价：任何"客户端先判一下"的捷径都会在拆分时变成不可信边界上的治理漏洞（另见 adr-002 对该模型残余风险的权衡）。

## 6. 风险与权衡

| 风险/权衡 | 影响 | 缓解 |
|---|---|---|
| 客户端代执行的审计真实性弱一档：执行发生在不可信端，服务端只能校验回传结果，无法直接观测请求本身 | 审计证据链存在"客户端自报"环节 | 一次性签名指令收窄伪造面 + resultSchema 校验 + 全链路旁路事件；标准版以 server 直调为主通道（adr-002） |
| 宿主页面结构变化导致 featureId 推断（url→id 映射）失效 | 装配错位 → 讲解/工具面与页面不符 | manifest 版本化可快速修正；eval 集覆盖"featureId 命中"维度（M4） |
| 配置内容质量不可控（讲解错、引导偏、工具误触发） | 直接决定产品成败 | adr-008：eval 纪律先于规模化，四件配置全部进评测门（M4→S2） |
| 单体内端口纪律靠约定漂移 | U1/U2 被侵蚀后拆分成本骤增 | 依赖 lint 进 CI（U2 判定自动化）+ 开发期红线 `.claude/rules/` |
| Chrome 插件分发/权限受企业浏览器策略制约 | 部分客户环境装不上 | 企业策略分发（adr-001 已论证）；S3 提供嵌入 SDK / 浏览器壳兜底 |
| SSE 长连接在代理/网关环境被中断 | 下行消息丢失 | 断线重连 + 上行 HTTP 幂等；标准版 SSE 集群 pub/sub（adr-006） |
| MVP 会话状态本地存储与标准版外置的语义差 | 状态迁移时序/一致性问题 | 状态接口第一天按可外置设计（§3.1），S4 只换实现 |
| dom 任务边界由 agent 声明的 task 标题界定，理论可沿用旧标题挂靠已授权任务 | 授权作用域被稀释 | 每步可见 + 停止常在 + 审计留痕；不可撤回外发动作强制 `every-call`（adr-013） |

## 7. 模块边界与扩展点

### 7.1 模块边界（包 ↔ 契约 ↔ 职责）

| 模块 | 契约面 | 职责 | 明确不做 |
|---|---|---|---|
| `packages/contracts` | C1-C6 全部 schema + TS 类型 | 零依赖底座：schema、端口类型、内建工具结构契约 | 任何实现逻辑 |
| `packages/assembly` | C4 消费端（AssemblyPort） | 快照载入（registry/legacy 二形态）、pack 激活解析、注入组合、docs 渐进披露、site/工具归属枚举 | 运行时改写快照（U4）；治理判定 |
| `packages/toolgate` | C1/C2 消费端（ToolGatePort） | 唯一决策点（分级/身份/围栏/dom 校验/任务级授权）、一次性签名签发/核销、server 直调执行器 | 产生对话内容；持 LLM 密钥 |
| `packages/llm-port` | C6 LlmPort | openai 兼容流式对接、provider 白名单、密钥 env 托管、toolId 出网净化、实参非法诊断 | 感知业务语义与装配内容 |
| `packages/audit` | C5 生产端（AuditPort） | record-only 旁路落盘、落盘前脱敏 | 进入控制流（故障吞掉） |
| `apps/server` | 唯一组装点（U2） | 内部六模块：gateway（回合循环/内建工具/HITL 挂起恢复/自愈重试）、auth（验签）、sessions（持久化）、compress（P1 压缩）、history（P0 瘦身）、demo-token | 第二组装点；横向 import |
| `apps/extension` | C3 实现（五能力） | 会话组管理、dom 步进器、HITL 卡片、快照采集、身份透传 | 零治理判定（U7） |

### 7.2 扩展点清单（怎么扩、动哪里）

| 扩展意图 | 扩展点 | 动什么 | 不动什么 |
|---|---|---|---|
| **新增站点** | 快照根 registry | 新建 `packs/<packId>/`（pack.json + features/…），registry manifest 登记（→ `03-configuration.md` 完整示例） | 任何代码；其他 pack |
| **新增功能页** | pack 内 features | `features/<featureId>/` 三件套 + pack.json 的 featureIdRules/features | 装配引擎 |
| **新增工具** | tools.json | 按 C1 契约加数组元素；三种 adapter（http/dom/server）× riskTier × hitlMode 组合 | toolgate（闭集判定自动覆盖） |
| **新增 LLM provider** | llm-port 白名单 | `allowedProviders`（组装点接线）+ 实现侧对接；密钥走 env | 契约与网关 |
| **新增客户端形态** | C3 五能力契约 | 新 `apps/<形态>` 实现同一帧闭集 | 服务端零改动（U5） |
| **换审计落点** | AuditPort sink | `createAuditPort({sinkPath})` 或换实现（同 schema，U6） | 事件结构 |
| **凭证接入** | resolveCredential | 组装点注入 `ref → 真值` 解析（默认 `ZA_CRED_*` env） | 配置文件（真值禁入） |
| **状态外置** | NonceStore / SessionStore 接口 | 换 Redis/DB 实现（接口先行，S4 锚点） | 端口契约 |
| **内建工具** | gateway 注入点 | 网关侧新增 `*_TOOL_SPEC` 并接执行分支（渐进披露：按装配条件注入） | pack 配置面 |
