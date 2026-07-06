# 契约总览（C1-C6）

> 设计来源：`docs/reference/00-design-brief.md` §5（契约清单）与 §4（升级不变量 U1-U7）。
> **事实权威**：C1-C5 以 `packages/contracts/schemas/*.schema.json` 为准，C6 以 `packages/contracts/src/ports.ts` 为准；
> 本文只做导览与语义解释，与 schema 冲突时以 schema 为准。
> TS 类型（`packages/contracts/src/`）为 schema 的手写同构投影，codegen 引入锚点 = 契约首次进入高频变更期。

| 契约 | 权威文件 | 一句话职责 |
|---|---|---|
| C1 工具定义 | `schemas/tool-definition.schema.json` | agent 可调用能力的唯一登记形态（execution 通道 × adapter 三形 × riskTier × hitlMode） |
| C2 身份契约 | `schemas/identity-claims.schema.json` | 验签后流转的用户身份 claims 闭集（会话另持 per-origin 投影） |
| C3 客户端接入层 | `schemas/client-access-layer.schema.json` | 五能力 + 上行/下行消息帧闭集（含 dom 观察半程帧） |
| C4 配置快照 | `schemas/registry.schema.json` + `schemas/pack.schema.json`（legacy：`config-snapshot.schema.json`） | registry/pack 两级版本化不可变快照 |
| C5 审计事件 | `schemas/audit-event.schema.json` | 全链路审计事件类型闭集 |
| C6 模块端口 | `src/ports.ts` | 四端口 TS 契约（Assembly/ToolGate/Llm/Audit） |

## C1 工具定义（tool-definition）

**职责**：定义一个 agent 可调用的宿主能力。快照内 `packs/<packId>/features/<id>/tools.json` 的数组元素即本契约实例。

**关键字段语义**：
- `id` / `featureIds[]`：工具标识（点分命名空间，如 `codeflow-token.create-token`；跨 pack 同名 toolId 载入即拒启）与挂载功能闭单——装配器按当前 featureId 过滤出白名单工具集，每轮换出。
- `description` / `params`：面向 LLM 的说明与入参 JSON Schema，装配期原样进 tool spec；执行前服务端按 `params` 校验实参。
- `execution`：通道闭集 `client | server`；**adapter 三形**按通道分形（schema if/then）：
  - `ClientAdapter`（http 代执行）：宿主请求模板（`{{param}}` 占位、服务端代入实参后签名下发，插件以用户 cookie 发请求）；
  - `DomAdapter`（`kind:'dom'` 可见页面代操作，adr-011）：`pathPrefixes` 页路径围栏；实参约定 `task`（任务级授权作用域标识，必填）+ `steps`（闭集动作批次，ref 须出自最近快照）+ `summary`/`plan`（授权卡呈现）；
  - `ServerAdapter`（服务端直调，adr-010）：API 映射 + `credentialRef` 凭证引用名（真值运行时注入，禁入配置）。
- `riskTier`：操作分级矩阵落点，闭集 `auto | hitl | forbidden`；判定永远在服务端工具执行层，未知/缺失一律 deny。
- `hitlMode`（可选，仅 riskTier=hitl 有意义）：`per-task`（缺省）——同会话同任务首批确认后跨工具自动放行；`every-call`——对外不可撤回动作（发信/删除等）次次挂起单独确认、不复用授权。
- `resultSchema`：结果契约；回传 body 校验不过即 `invalid-result`、不回喂 agent。

**平台内建工具（不入 tools.json）**：`guide_highlight`（UI 引导）、`page_snapshot`（dom 观察半程）、`pack_doc`（站点文档按需读）、`site_navigate`（跨站导航，结构契约在 `tool-definition.ts` 的 `SITE_NAVIGATE_*`）——由网关按装配条件注入（渐进披露），治理各有专路（snapshot/pack_doc 只读不经 toolgate；navigate 专路裁决）。

**升级不变量关联**：U3（execution 闭集；双通道已实现，通道仍是配置维度）、U7（riskTier/dom 校验/围栏判定服务端 fail-closed；结果回传经 schema 校验才回喂）、U1。

**MVP 与标准版差异**：契约已是标准版形态；标准版差异只在执行器部署位置（toolgate 独立服务）。

## C2 身份契约（identity-claims）

**职责**：平台内流转的用户身份规范形态。网关验签宿主/SSO 签发的短期 JWT 后投影出本闭集对象（`additionalProperties:false` 物理保证；原始 token 的 iat/aud/jti 等标准字段投影时丢弃）。

**关键字段语义**：
- `sub` / `tenant`：平台侧主体与租户（会话隔离键；MVP 单租户固定值，字段先行）。
- `roles[]`：宿主侧角色，仅供门禁粗粒度校验——细粒度权限永远由宿主 API 以用户身份自行判定，平台不复刻宿主权限模型。
- `hostUserId`：宿主用户标识，代执行/直调透传身份与审计 `userId` 取值源。
- `iss` / `exp`：签发方（白名单验签，名单外 fail-closed 拒绝）与短时效过期。

**per-origin 身份（adr-013 跨站任务组）**：会话在平台 claims 之外，按 `claims.tenant` 匹配 pack.tenant 路由持有各 origin 的宿主身份投影（`claimsByOrigin`）。site pack 的 http/server 工具要求该 origin 的宿主 claims（缺失/过期 fail-closed 拒）；dom 工具在用户页面会话内执行、只要求平台 JWT。

**升级不变量关联**：U7（工具门禁身份校验的唯一输入）、U1。信任契约：平台零特权、不建账号，只验签与透传。

**MVP 与标准版差异**：MVP 对接企业 SSO 或简化 token，但 claims 结构即按标准版契约；标准版身份联邦独立部署/复用企业 IAM，契约不变。

## C3 客户端接入层（client-access-layer）

**职责**：客户端与会话网关之间的全部交互形态——五能力接口 + 消息帧闭集。schema 校验任一单帧。

**关键字段语义**：
- 五能力闭集（`$defs/capability`）：`identity`（身份获取）/ `context-report`（上下文上报）/ `conversation-hitl`（会话 UI+HITL 卡片）/ `page-action`（页面动作）/ `delegated-execution`（代执行）。**adr-011/013 后五能力未变**（U5 守住）——dom 观察与跨站导航都归入既有能力的帧扩展。
- 上行 5 帧（HTTP）：`context-report`（url 必填，featureId 判定权威在服务端）、`user-message`、`hitl-decision`（客户端只采集意愿、不做放行判定）、`exec-result`（携 nonce 回传，服务端核销+ttl+resultSchema 三重校验后才回喂）、`snapshot-report`（页面可交互元素快照，dom 观察半程回传；按不可信观察对待）。
- 下行 6 帧（SSE，D6 单向下行）：`text-delta`、`tool-card`（纯展示，只下发脱敏摘要）、`hitl-request`（展示真实实参供裁决；dom 任务卡以 task/plan/摘要功能级呈现）、`exec-instruction`（**必含 nonce/ttl/signature**；request 为服务端已定值的最终请求——http 形态或 `DomExecRequest{kind:'dom',steps}` dom 批次形态）、`guide-action`（action 闭集仅 highlight/scroll-to）、`snapshot-request`（请活跃页回传快照）。

**升级不变量关联**：U5（五能力与帧闭集不随形态变——插件/SDK/浏览器壳同一契约）、U7（决策服务端；代执行指令一次性签名）、U1。

**MVP 与标准版差异**：MVP 仅 Chrome 插件实现本契约；标准版三形态各自实现同一契约。SSE 断线重连与集群 pub/sub 是传输层演进，不动帧结构。

## C4 配置快照（registry + pack 两级，adr-013）

**职责**：定义快照根的两级结构与文件布局。完整目录树、字段表与新增站点示例见 `03-configuration.md`（配置参考）。

**两级结构**：
- **registry 根**（`registry.schema.json`）：`manifest.json{version, packs:[{packId,version}]}` 登记表 + `packs/<packId>/` 逐 pack 目录。登记项与 pack.json 的 packId/version 必须一致，否则 fail-closed 拒载。
- **pack 清单**（`pack.schema.json`）：`pack.json{packId, version, summary?, site{origin, locations?}, tenant?, featureIdRules[], features[]?}`——site 是激活围栏（origin 精确 + location 前缀最长胜出）；tenant 是 per-origin 身份路由键；featureIdRules 仅在 pack 激活后参与 url→featureId 判定。
- **pack 内布局**：`features/<id>/{feature.md, facts.md, tools.json}` + `skills/<fn>/SKILL.md`（可选）+ `docs/*.md`（可选，frontmatter title/summary 生成索引、`pack_doc` 按需读正文）+ `eval/scenarios.json`（可选，装配器不加载、评测脚本用）。
- **legacy 形态**（`config-snapshot.schema.json`）：根 manifest 无 packs 数组时按单 pack 处理（缺省 packId=`default`、无 site 围栏），旧快照零迁移可用。

**关键语义**：
- `version`：semver，registry 整体版本；装配结果与审计事件回写该版本，可追溯。
- 激活解析：origin 精确匹配 → 最长 location 前缀胜出 → pack 内 featureIdRules 首个命中；全程无命中则仅装配稳定基座（fail-safe）。
- 载入校验全 fail-closed：契约不过 / 登记不一致 / 功能目录缺件 / 同 origin location 重复 / 规则指向包外功能，任一即拒载（启动期 fail-fast）。

**升级不变量关联**：U4（版本化不可变快照；git 文件布局与标准版配置中心产出物同构——升级只换生产端，消费端/装配器不换）、U1。

**MVP 与标准版差异**：MVP 生产端 = git 内手工维护的快照根目录（D7 配置先文件后 UI）；标准版生产端 = 配置中心后台（版本化发布 + 评测门 + 灰度），产出物结构不变。

## C5 审计事件（audit-event）

**职责**：全链路 record-only 审计事件结构。类型闭集六种，覆盖 会话（`session-start/session-end`）、装配（`assembly`，与 describeInjection 同源）、工具决策（`tool-decision`）、HITL 裁决（`hitl-verdict`）、执行结局（`tool-execution`）。

**关键字段语义**：
- 公共信封：`eventId / type / ts / sessionId` 必填，`userId(=hostUserId) / tenant / featureId` 可选；`data` 按 type 分形（schema allOf if/then 强制）。
- 脱敏前置：工具实参/响应体/页面内容不入事件，只记 id、结局（`verdict`、`outcome` 闭集）与摘要（`rulesDigest`）；secret/凭证值任何字段禁入。
- 旁路铁律：审计生产与落盘永远在控制流旁路，审计故障不影响会话与执行。

**升级不变量关联**：U6（schema 独立于落点：MVP `.za/events.jsonl` → 标准版观测审计服务 DB，只换 sink 不换 schema）、U7（决策与执行事件即门禁行为的可核查记录）、U1。

**MVP 与标准版差异**：仅 sink 与查询面不同（jsonl 手工检索 → 独立服务 + DB + 质量指标看板），事件结构与类型闭集不变。

## C6 模块端口（ports）

**职责**：模块间唯一调用契约（TS 类型，`src/ports.ts`）。模块 = 包、组装唯一在 `apps/server`（U2）；四端口方法出入参全部 JSON 可序列化（U1），拆服务时端口 → RPC 不改契约。

**端口语义**（方法闭集以 `ports.ts` 为准，此处为语义导览）：
- `AssemblyPort`（②网关 ← ⑤配置中心）：`resolveFeature`（url → pack 激活 + featureId，返回含 packId/packVersion/snapshotVersion）、`compose`（每轮换出：基座 + 站点索引 + feature.md + facts.md + skills + 工具白名单 + docs 索引）、`describeInjection`（注入自省，与 compose 同源，喂审计 assembly 事件）、`readPackDoc`（pack_doc 渐进披露正文，路径穿越 fail-closed）、`allTools`/`listSites`/`listToolOwnership`（启动期汇总：toolgate 判定闭集 / site 围栏 / 命名空间纪律）。
- `ToolGatePort`（③工具执行层）：`decide`（唯一决策点：分级矩阵 + 身份/实参/dom 步骤/围栏校验 + 任务级授权复用，fail-closed；入参含 packOrigin/claimsForOrigin/domContext）、`grantHitl`（HITL 批准后登记 `(sessionId,task)` 授权）、`issueExecInstruction`（签发一次性签名指令，前提 = decide 放行）、`acceptExecResult`（核销 nonce + 验 ttl + resultSchema 校验 → 规整 observation；user-stopped 吊销本会话授权）、`executeServer`（server 通道直调：渲染 + credentialRef 凭证注入 + 结果校验）。
- `LlmPort`（④LLM 接入层）：`chat` 返回 `AsyncIterable<LlmStreamEvent>`——流式 RPC 的进程内投影，逐事件 JSON 可序列化，仍满足 U1；done 事件携 `usage`（历史压缩触发依据）与 `errorKind`（invalid-tool-args 自愈信号）；provider 白名单与密钥托管在实现侧，不进契约。
- `AuditPort`（⑦观测审计）：`record` 为 record-only 旁路，实现不抛异常、失败仅本地日志。

**升级不变量关联**：U1（全部方法）、U2（跨模块只经本契约 + 端口注入）、U7（ToolGatePort 承载判定与一次性签名语义）。

**MVP 与标准版差异**：MVP 四端口在模块化单体内进程内注入；标准版按 D4 先拆 LLM 接入层，端口签名不变、实现换成 RPC client。
