# 契约总览（C1-C7）

> 设计来源：`docs/reference/00-design-brief.md` §5（契约清单）与 §4（升级不变量 U1-U8）。
> **事实权威**：C1-C5/C7 以 `packages/contracts/schemas/*.schema.json` 为准，C6 以 `packages/contracts/src/ports.ts` 为准；
> 本文只做导览与语义解释，与 schema 冲突时以 schema 为准。
> TS 类型（`packages/contracts/src/`）为 schema 的手写同构投影，codegen 引入锚点 = 契约首次进入高频变更期。

| 契约 | 权威文件 | 一句话职责 |
|---|---|---|
| C1 工具定义 | `schemas/tool-definition.schema.json` | agent 可调用能力的唯一登记形态（execution 通道 × adapter 三形 × riskTier × hitlMode） |
| C2 身份契约 | `schemas/identity-claims.schema.json` + `schemas/activation.schema.json` | 验签后流转的用户身份 claims 闭集（会话另持 per-origin 投影）+ 匿名激活请求/响应闭集 |
| C3 客户端接入层 | `schemas/client-access-layer.schema.json` | 五能力 + 上行 7 帧 / 下行 8 帧闭集（含 dom 观察半程帧与 L2 配置写入帧） |
| C4 配置快照 | `schemas/registry.schema.json` + `schemas/pack.schema.json`（legacy：`config-snapshot.schema.json`） | registry/pack 两级版本化不可变快照（L1） |
| C5 审计事件 | `schemas/audit-event.schema.json` | 全链路审计事件类型闭集 |
| C6 模块端口 | `src/ports.ts` | 五端口 TS 契约（Assembly/ToolGate/UserConfigStore/Llm/Audit） |
| C7 用户覆盖层 | `schemas/user-overlay.schema.json` | subject 维度的 L2 运行期覆盖（只收紧表达力） |

## C1 工具定义（tool-definition）

**职责**：定义一个 agent 可调用的宿主能力。快照内 `packs/<packId>/features/<id>/tools.json` 的数组元素即本契约实例。

**关键字段语义**：
- `id` / `featureIds[]`：工具标识（点分命名空间，如 `codeflow-token.create-token`；跨 pack 同名 toolId 载入即拒启）与挂载功能闭单——装配器按当前 featureId 过滤出白名单工具集，每轮换出。
- `description` / `params`：面向 LLM 的说明与入参 JSON Schema，装配期原样进 tool spec；执行前服务端按 `params` 校验实参。
- `execution`：通道闭集 `client | server`；**adapter 三形**按通道分形（schema if/then）：
  - `ClientAdapter`（http 代执行）：宿主请求模板（`{{param}}` 占位、服务端代入实参后签名下发，插件以用户 cookie 发请求）；
  - `DomAdapter`（`kind:'dom'` 可见页面代操作，adr-011）：`pathPrefixes` 页路径围栏；实参约定 `task`（任务级授权作用域标识，必填）+ `steps`（闭集动作批次，ref 须出自最近快照）+ `summary`/`plan`（授权卡呈现）；**`targetPage` 是平台保留入参**（adr-023 定向操作）——toolgate 载入期给 dom 工具 params 统一增广可选 `targetPage`，pack 制品不写它，任一 dom 工具自声明即载入期拒启；保留面仅此一名，其余参数名（含 `page`）pack 自由使用；
  - `ServerAdapter`（服务端直调，adr-010）：API 映射 + `credentialRef` 凭证引用名（真值运行时注入，禁入配置）。
- `riskTier`：操作分级矩阵落点，闭集 `auto | hitl | forbidden`；判定永远在服务端工具执行层，未知/缺失一律 deny。
- `hitlMode`（可选，仅 riskTier=hitl 有意义）：`per-task`（缺省）——同会话同任务首批确认后跨工具自动放行；`every-call`——对外不可撤回动作（发信/删除等）次次挂起单独确认、不复用授权。
- `resultSchema`：结果契约；回传 body 校验不过即 `invalid-result`、不回喂 agent。

**平台内建工具（不入 tools.json）**：`guide_highlight`（UI 引导）、`page_snapshot`（dom 观察半程；`includeText` 分支取页面正文，无独立正文工具）、`pack_doc`（站点文档按需读）、`site_navigate`（跨站导航，结构契约在 `tool-definition.ts` 的 `SITE_NAVIGATE_*`）、`open_url`（通用开页，`OPEN_URL_*`；注入门＝调用准入门：generic pack 已激活，或静默页冷启动——静默页无 http(s) origin，generic 不激活，故单开这一个通用开页入口）——由网关按装配条件注入（渐进披露），治理各有专路（snapshot/pack_doc 只读不经 toolgate；navigate 类专路裁决）。`page_snapshot` 与两个 navigate 内建工具同样接受可选 `targetPage`（定向到组内其他页，adr-023）。

**升级不变量关联**：U3（execution 闭集；双通道已实现，通道仍是配置维度）、U7（riskTier/dom 校验/围栏判定服务端 fail-closed；结果回传经 schema 校验才回喂）、U1。

**MVP 与标准版差异**：契约已是标准版形态；标准版差异只在执行器部署位置（toolgate 独立服务）。

## C2 身份契约（identity-claims）

**职责**：平台内流转的用户身份规范形态。网关验签短期 JWT 后投影出本闭集对象（`additionalProperties:false` 物理保证；原始 token 的 iat/aud/jti 等标准字段投影时丢弃）。签发形态由 `iss` 区分（当前在产=匿名激活；平台账号为投产前置条件），验签路径与 claims 结构不随形态变。

**关键字段语义**：
- `sub` / `tenant`：平台侧主体与租户（会话隔离键；MVP 单租户固定值，字段先行）。
- `roles[]`：宿主侧角色，仅供门禁粗粒度校验——细粒度权限永远由宿主 API 以用户身份自行判定，平台不复刻宿主权限模型。
- `hostUserId`：宿主用户标识，代执行/直调透传身份与审计 `userId` 取值源。
- `iss` / `exp`：签发方（白名单验签，名单外 fail-closed 拒绝）与短时效过期。

**匿名激活（adr-022，`activation.schema.json`）**：C2 身份契约族的加法扩展，当前唯一在产签发形态。客户端首次运行生成安装 id（122+ 位随机，仅本地存储），`POST /v1/activation` 换取 24h 短时效 token，用户零填写、无管理员签发环节。请求/响应各为一个闭集对象：请求仅 `installId`；响应仅 `{token, expiresAt, hostUserId}`。服务端纯函数派生 `hostUserId = 'anon-' + base64url(SHA-256(installId))`（`sub` 同值、`tenant='anon'`、`iss='zen-agent-anon'`），无映射表、无存储态；installId 是持有型凭证，其原值 MUST NOT 落盘/进日志/进 token 载荷或错误响应（SEC-01/04）。签发的 token 经既有验签路径投影为本契约，C2 结构零改动；`zen-agent-anon` 由服务端组装时无条件并入 iss 白名单。已知取舍：匿名激活无持有证明，安装 id 泄漏即可冒充；身份强度由平台账号登录提供。

**per-origin 身份（adr-013 跨站任务组）**：会话在平台 claims 之外，按 `claims.tenant` 匹配 pack.tenant 路由持有各 origin 的宿主身份投影（`claimsByOrigin`）。site pack 的 http/server 工具要求该 origin 的宿主 claims（缺失/过期 fail-closed 拒）；dom 工具在用户页面会话内执行、只要求平台 JWT。

**升级不变量关联**：U7（工具门禁身份校验的唯一输入）、U1。信任契约：平台零特权、不存宿主凭证，只验签与透传。

**MVP 与标准版差异**：签发形态可换（匿名激活 / 平台账号 / 企业 SSO），claims 结构即标准版契约；标准版身份联邦独立部署/复用企业 IAM，契约不变。

## C3 客户端接入层（client-access-layer）

**职责**：客户端与会话网关之间的全部交互形态——五能力接口 + 消息帧闭集。schema 校验任一单帧。

**关键字段语义**：
- 五能力闭集（`$defs/capability`）：`identity`（身份获取）/ `context-report`（上下文上报）/ `conversation-hitl`（会话 UI+HITL 卡片）/ `page-action`（页面动作）/ `delegated-execution`（代执行）。**adr-011/013/023 后五能力未变**（U5 守住）——dom 观察、跨站导航、任务组页面清单与定向落点都归入既有能力的帧扩展。
- 上行 7 帧（HTTP）：`context-report`（url 必填，featureId 判定权威在服务端）、`user-message`、`hitl-decision`（客户端只采集意愿、不做放行判定）、`exec-result`（携 nonce 回传，服务端核销+ttl+resultSchema 三重校验后才回喂）、`snapshot-report`（页面可交互元素快照，dom 观察半程回传；按不可信观察对待）、`group-pages`（任务组成员页全量清单 `{handle,url,title?,status}`，服务端每帧整体重建组页面状态表；adr-023 D1）、`config-decision`（对应下行 `config-draft` 的 `draftId` + `accept|reject`；accept 后服务端才执行写入链路，客户端只采集意愿、不做写入判定）。
- 下行 8 帧（SSE，D6 单向下行）：`text-delta`、`turn-complete`（服务端权威回合终止信号，客户端据此解除输入锁）、`tool-card`（纯展示，只下发脱敏摘要）、`hitl-request`（展示真实实参供裁决；dom 任务卡以 task/plan/摘要功能级呈现；`targetPage`/`targetUrl` 由服务端组装消毒后呈现副作用落点）、`exec-instruction`（**必含 nonce/ttl/signature**；request 为服务端已定值的最终请求——http 形态或 `DomExecRequest{kind:'dom',steps}` dom 批次形态）、`guide-action`（action 闭集仅 highlight/scroll-to）、`snapshot-request`（请页面回传快照，缺省为活跃页）、`config-draft`（L2 配置草稿卡，携 `{draftId, scope, change, summary}`——`change` 是拟写入的 overlay 片段原文，用户须看到真实将写入什么；`scope` 是 `change` 的机械投影）。
- **对话→配置的唯一通路（U8，adr-014 teach 流）**：`config-draft` + `config-decision` 构成显式确认写入通道——对话内容永不直写配置，服务端只产草稿，用户 accept 后才走 `PUT /v1/user-config` 落盘（落盘前仍过 user-overlay 组合校验与只收紧校验）。草稿卡只复用插件卡片 UI 呈现，不复用 `hitl-request` 帧语义与 toolgate 裁决链路。
- **定向落点（adr-023）**：`exec-instruction` / `guide-action` / `snapshot-request` 均含可选 `page`（服务端当前只在 `exec-instruction` / `snapshot-request` 上产出该字段；`guide-action.page` 是契约与客户端路由均已就位的预留位，服务端不产出带 `page` 的引导帧，引导恒落活跃页）——会话作用域**不透明**页面句柄（schema 只约束 1..64 长度，无 pattern；Chrome tabId 等形态标识 MUST NOT 进契约，U5）。缺省 = 现活跃页路由语义逐字节不变；有值时按句柄单播目标成员，成员不可达即不投递、MUST NOT 改投。句柄解析与准入（未命中状态表 / 越目标页围栏 / silent 页通道不满足）一律在下发前于服务端完成，拒绝即回喂 error observation，MUST NOT 回退活跃页。`exec-instruction.page` 一并进签名序列 `{sessionId,nonce,issuedAt,expiresAt,ttl,toolCallId,targetPage?,request}`（帧字段 `page` 的值在签名序列里以 `targetPage` 键承载）——篡改落点即验签失败。帧字段名 `page` 与工具入参侧的平台保留名 `targetPage` 分属两层命名面：帧字段不进 pack 声明面，故不随入参改名。

**升级不变量关联**：U5（五能力与帧闭集不随形态变——插件/SDK/浏览器壳同一契约）、U7（决策服务端；代执行指令一次性签名）、U8（config-draft/config-decision 是对话改配置的唯一合法通道）、U1。

**MVP 与标准版差异**：MVP 仅 Chrome 插件实现本契约；插件在 SSE 断线后自动重连，并以会话 `turn-state` 恢复可能漏收的回合完成状态。标准版三形态各自实现同一契约，集群 pub/sub 是传输层演进，不动帧结构。

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

**职责**：全链路 record-only 审计事件结构。类型闭集七种，覆盖 会话（`session-start/session-end`）、装配（`assembly`，与 describeInjection 同源）、工具决策（`tool-decision`）、HITL 裁决（`hitl-verdict`）、执行结局（`tool-execution`）、L2 用户配置写入（`user-config-write`，adr-014）。

**关键字段语义**：
- 公共信封：`eventId / type / ts / sessionId` 必填，`userId(=hostUserId) / tenant / packId / packVersion / featureId` 可选；`data` 按 type 分形（schema allOf if/then 强制）。
- `user-config-write` 的 `data`：`{subject{tenant,hostUserId}, revision, overlay, origin}`——`revision` 为写后 overlay 内容 hash、`overlay` 为写后全量覆盖层（脱敏后，结构权威在 C7）、`origin` 闭集 `teach`（对话草稿经 config-decision 确认写入）| `panel`（配置中心面板结构化编辑）。任一 revision 内容可经审计流重建，满足事故回放。
- L2 追溯字段：`assembly` 与 `tool-decision` 的 `data.userConfigRevision` = 本轮 compose 定格的 overlay revision，与 `user-config-write` 事件同值互证（缺省 = 本轮无 subject / degraded）。
- 自动回合归因（adr-019/021）：顶层可选 `automationRunId`（本事件所属自动 run，与 C3 `user-message.automationRunId` 同值）与 `automationId`（pack 声明的 automation id 或用户自建 watch id）；人工回合省略。
- 脱敏前置：工具实参/响应体/页面内容不入事件，只记 id、结局（`verdict`、`outcome` 闭集）与摘要（`rulesDigest`）；secret/凭证值任何字段禁入。
- 落点页标注（adr-023，additive）：顶层可选 `page{handle, origin?}`——`tool-decision` / `hitl-verdict` / `tool-execution` 三类事件填写（缺省调用记活跃页，定向调用记目标页；状态表无句柄时整体省略）。句柄不透明，消费方只作等值比对；旧事件不带该字段依旧合法。
- 旁路铁律：审计生产与落盘永远在控制流旁路，审计故障不影响会话与执行。

**升级不变量关联**：U6（schema 独立于落点：MVP `.za/events.jsonl` → 标准版观测审计服务 DB，只换 sink 不换 schema）、U7（决策与执行事件即门禁行为的可核查记录）、U4（`user-config-write` + `userConfigRevision` 是 L2 覆盖层「可审计/可追溯」两约束的落点）、U1。

**MVP 与标准版差异**：仅 sink 与查询面不同（jsonl 手工检索 → 独立服务 + DB + 质量指标看板），事件结构与类型闭集不变。

## C6 模块端口（ports）

**职责**：模块间唯一调用契约（TS 类型，`src/ports.ts`）。模块 = 包、组装唯一在 `apps/server`（U2）；全部端口方法出入参均为 JSON 可序列化值（U1），拆服务时端口 → RPC 不改契约。

**端口语义**（方法闭集以 `ports.ts` 为准，此处为语义导览）：
- `AssemblyPort`（②网关 ← ⑤配置中心）：`resolveFeature`（url → pack 激活 + featureId，返回含 packId/packVersion/snapshotVersion）、`compose`（每轮换出：基座 + 站点索引 + feature.md + facts.md + skills + 工具白名单 + docs 索引；可选入参 `origin` = 活跃页 origin，命中 L2 `siteDenylist` 即回落仅基座并标 `siteDenied`——不传即维持基线行为）、`describeInjection`（注入自省，与 compose 同源，喂审计 assembly 事件；`reason` 闭集 `pack`/`generic`/`base-only`/`pack-disabled`/`site-denied` 说清本轮装配面之所以如此，黑名单命中优先于 pack 关停）、`readPackDoc`（pack_doc 渐进披露正文，路径穿越 fail-closed）、`allTools`/`listSites`/`listToolOwnership`（启动期汇总：toolgate 判定闭集 / site 围栏 / 命名空间纪律）。
- `ToolGatePort`（③工具执行层）：`decide`（唯一决策点：分级矩阵 + 身份/实参/dom 步骤/围栏校验 + 任务级授权复用，fail-closed；入参含 packOrigin/claimsForOrigin/domContext，及 `groupPages` 组页面状态表快照——定向调用的目标解析基准，入参带 `targetPage` 而表内未命中一律拒、禁回退活跃页）、`grantHitl`（HITL 批准后登记 `(sessionId,task)` 授权）、`getExecVerificationKey`（只读 Ed25519 公钥）、`issueExecInstruction`（签发带绝对时限的一次性指令，前提 = decide 放行；同收 `groupPages`，签名前独立重解析定向目标，不依赖 decide 已通过的假设）、`acceptExecResult`（核销 nonce + 验 ttl + resultSchema 校验 → 规整 observation）、`executeServer`（server 通道直调：渲染 + credentialRef 凭证注入 + 结果校验）。
- `UserConfigStore`（⑤配置中心 L2 存储边界，adr-014）：`read`（返回 `{overlay|null, revision, stale?}`——`revision` 为内容 hash，空 overlay 亦有稳定值；`stale:true` = 本次读失败、返回上次成功结果，消费方须落审计标注）、`write`（前提 = overlay 已过 `validateUserOverlay` 组合校验与只收紧校验）。toolgate 不直接依赖本端口——compose 定格的结果经端口入参传递以封 TOCTOU（U2）；`restrictions`/`enabled` 读失败语义 fail-closed 由消费方承担（U7）。
- `LlmPort`（④LLM 接入层）：`chat` 返回 `AsyncIterable<LlmStreamEvent>`——流式 RPC 的进程内投影，逐事件 JSON 可序列化，仍满足 U1；done 事件携 `usage`（历史压缩触发依据）与 `errorKind`（invalid-tool-args 自愈信号）；provider 白名单与密钥托管在实现侧，不进契约。
- `AuditPort`（⑦观测审计）：`record` 为 record-only 旁路，实现不抛异常、失败仅本地日志。

**升级不变量关联**：U1（全部方法）、U2（跨模块只经本契约 + 端口注入）、U7（ToolGatePort 承载判定与一次性签名语义）。

**MVP 与标准版差异**：MVP 端口在模块化单体内进程内注入；标准版按 D4 先拆 LLM 接入层，端口签名不变、实现换成 RPC client。

## C7 用户覆盖层（user-overlay，adr-014）

**职责**：L2 用户级配置覆盖层——`subject=(tenant, hostUserId)` 维度的运行期覆盖，经 `UserConfigStore` 端口读写、`revision`（内容 hash）可追溯。与 C4 快照（L1）构成 U4 的双源：L2 **显式排除**在快照同构/不可变约束之外，另守只收紧 / 可审计 / 可追溯三约束。

**结构**（`{schemaVersion, subject, packs, watches?}`，全程 `additionalProperties:false`）：
- `packs` 是作用域表：键 `"*"` = 全局作用域（跨站规则/事实、`verbosity` 偏好与 `siteDenylist`，零配置站点的个人定制载体；结构上无 `enabled`/`restrictions`/`packConfig`——无对应工具面可收紧）；其余键 = packId，走 pack 级作用域。
- `siteDenylist`（用户级站点黑名单）只居全局作用域——它跨站点、不锚定任何 pack。条目文法两形态：`scheme://host[:port]` 精确 origin（比对时 www 与裸域互认，scheme/port 精确）、`scheme://*.host` 该域及其子域（scheme 精确，通配形态不比对端口）；`uniqueItems`，上限 200 条。**刻意不设 `*` 全通配**：那等价于关停整个产品，是危险且无意义的表达，文法层即拒。语义只收紧：命中 origin 上不装配任何站点包（含通用兜底包），回落仅基座——与 pack 级 `enabled:false` 共用同一条回落通路，两者以各自标注区分归因。**终判在服务端 compose**（U7）：客户端据同一份名单跳过激活只是隐私侧不上报，不构成治理生效；L2 读失败降级时读不到名单即不回落（存储故障不得让治理看起来已生效）。
- pack 级作用域：`enabled`（只允许 `const false`，即 pack 级关停；缺省 = 启用）、`rules`/`facts`（条目带 `origin` = `manual` 面板录入 / `teach` 对话草稿确认写入，`featureId` 缺省 = 整 pack 生效）、`restrictions`、`packConfig`、`preferences`。
- `restrictions` 是权限只收紧矩阵：`riskTierRaise` 值域闭集仅 `{hitl, forbidden}`（无 `auto`，结构上无放宽表达力）、`disabledTools` 从工具面移除不展示。
- `preferences`：`verbosity` 闭集 `concise|standard|detailed`；`automations` 键 = 该 pack 声明的 automation id（adr-019），`enabled:false` 关停、`minutes` 写入期校验 ≥ pack 预设周期且 ≥ 平台下限（频率同属收紧维度）。
- `watches`（adr-021）居顶层：用户自建周期触发器 = 「平台内建自动化模板 id + 参数」两成分（模板是 L0 代码闭集，用户不可定义模板），跨站点、不锚定 pack。只读模板发起的自动回合由服务端强制只读工具面（产品形态规则 R7 无人值守底线），故不构成能力扩张。

**只收紧铁律（产品形态规则 R1）**：结构上不存在新增工具 / 改 adapter / 改 execution / 放宽 riskTier 或节流的表达能力；`riskTier` 合并语义恒 `max(L1, L2)`，全序 `auto < hitl < forbidden`。用户级能力扩展的唯一通道 = 自建 pack（走 L1 载入校验）。

**组合校验器**：跨字段语义——同一 toolId 同时出现在 `riskTierRaise` 与 `disabledTools` 拒绝、`packConfig` 按该 pack 声明的 `configSchema`（adr-020）校验、watch 的 `templateId` 闭集与参数按模板 `paramsSchema` 校验——JSON Schema 表达不了，由 contracts 导出的 `validateUserOverlay` 承担；消费方 MUST 经该校验器，不得旁路只跑本 schema。

**写入通道**：见 C3 `config-draft`/`config-decision` 帧（对话 teach 流）与配置中心面板 `PUT /v1/user-config`（结构化编辑）；两条路径都在落盘前过组合校验与只收紧校验，并落 C5 `user-config-write` 事件。

**升级不变量关联**：U8（对话只产草稿、显式确认才入库；治理注入不被对话内容改变）、U7（`restrictions`/`enabled` 读失败 fail-closed——存储故障不得导致治理放宽）、U4（L2 源的三约束）、U1（对象 JSON 可序列化）。

**MVP 与标准版差异**：MVP 存储 = `ZA_USER_CONFIG_DIR` 下按 subject 二级分段的 JSON 文件（原子写：临时文件 + 同目录 rename；落点细节见 `03-configuration.md` §5）；标准版换配置中心 DB，端口与契约不变。
