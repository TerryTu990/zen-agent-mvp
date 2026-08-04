# 站点包契约与用户配置存储升级技术方案

> 状态：定稿 v1（2026-08-04）。类型：解释 + 参考（人读层）。
> 产出方式：11-agent workflow 编排——4 路现状盘点（contracts/assembly/server+extension/约束文档）
> + 3 路外部调研（包契约/分层配置/存储选型）→ 综合起草 → 三视角校验
> （产品形态 R1-R9 与设计稿、架构不变量 U1-U7、代码可落地性）；本稿已吸收全部 blocker/major 校验意见。
> 上游：`2026-08-04-generic-extension-productization.md`（P 线）、`2026-08-04-product-form-definition.md`
> （配置四层/R1-R9/D1-D6）、adr-007/013/019、`.claude/rules/ZA-WHERE.md`（U1-U7）。
> 范围：pack 契约 v2 / 装配加载演进 / L2 用户层契约 / 存储决策。全部走 U3 加法演进：
> 新增字段一律可选，现有 pack 与消息帧原样有效，不推倒重来。

## 0. ADR 拆分（先行事项）

本方案落地前先立两份 ADR，并同步修订红线（见 §2.1）：

- **adr-014 用户级配置层（L2）**：补上 adr-013:62/85 与 adr-015 预留的 ADR-014 编号——L2 即「用户记忆」的正式形态；adr-013 的记忆防线（数据非指令、可见可删、写入脱敏审计）逐条映射到 §3 机制，其中故障语义按 §3.4 拆分修正。该 ADR 同时了结产品形态文档待决 D1。
- **adr-020 pack 契约 v2 与存储演进**：§1 + §4 的决策记录。

## 1. 站点包契约 v2

目录布局**不变**（U4 同构铁律）：
`packs/<packId>/{pack.json, features/<id>/{feature.md, facts.md, tools.json}, skills/<fn>/SKILL.md, docs/, eval/}`。
**知识型 pack 合法**：`tools.json`、`capabilities`、锚点均可缺省——仅 feature.md + facts.md 的 pack
必须通过校验（产品通用性矩阵的生态冷启动约束），P2.5-a 验收含 knowledge-only fixture。

pack.json 字段表（新增字段全部可选；**每个新增字段必须挂装配端实施步或锚点，禁止「schema 接受但引擎无视」**）：

| 字段 | 状态 | 语义 | 装配端落点 |
|---|---|---|---|
| packId / version / summary / site{origin,locations} / tenant / generic / featureIdRules / features[] / automations[] | 现存 | 不动 | 已实现 |
| `site.exclude[]` | 新增 | 否定路径前缀（Tampermonkey `@exclude` 范式），命中即不匹配 | P2.5-a：resolvePack 排除判定 |
| `engines.contract` | 新增 | 平台契约 semver 范围（VS Code `engines` 范式）；不满足**拒载**（fail-closed，不降级猜测） | P2.5-a：载入期校验 |
| `capabilities.anchors` | 新增 | 引导锚点清单 `featureId → [{id, role, label, selectorHint}]`，取代 facts.md 内隐式登记；失配降级（R6），不作准入门槛 | 挂 D2（引导 capability 落地步） |
| `capabilities.skills[]` / `docs[]` | 新增 | skills/docs 闭单，补目录扫描缺口 | P2.5-a：loadSkills/loadDocs 对账校验 |
| `capabilities.preparation.workflows[]` | 新增 | **pack 声明其使用的 workflows ⊆ 服务端已实现闭集，载入期交叉校验**。注意：这不是把服务端语义上移——tool-definition 的 allOf 条件分形（schemas/tool-definition.schema.json:108/168/207）与服务端分支（gateway.ts、prepare-intent.ts、fulfillment）原样保留；真正泛化挂锚点「第二个履约站点 pack 接入时」 | P2.5-a：载入期子集校验 |
| `integrity` | 新增 | canonical 文件清单 sha256，U4 不可变的机械化验证 | P3.5（打包分发时启用） |

registry 登记项新增可选 `hash`（P3.5）与 `source: official|community|local`（P2.5-a；仅展示归属，
支撑设计稿 packs/injection 视图的来源徽章；签名/信任语义维持 adr-013:85 锚点「越出本仓分发时」）。

**分发形态**：MVP 保持 git 目录（adr-007）；P3.5 增打包形态——目录原样 zip + sha256，
registry 指针 = 版本 + hash，回滚 = 改指针（npm 不可变版本 / OCI digest 范式）。

capability 声明选型（备选记录）：① 平铺布尔（Obsidian 式）表达力不足；② 结构化对象（MCP capabilities
范式）——**选定**，可带子能力、ajv 闭集 fail-closed；③ 自由字符串不可校验，否决。

## 2. 装配加载演进

### 2.1 双源模型（U4 配套修订，与实现同一变更落地）

- **L1 = 版本化不可变快照**：同构铁律不变，S2 配置中心产出同构快照、消费端零改动。
- **L2 = subject 维度运行期覆盖层**：不是快照成员，经 `UserConfigStore` 端口（U1/U2 约束）逐回合读取，
  以 revision（内容 hash）标识；**显式排除在 U4 同构与不可变约束之外**，自带三约束：只收紧（R1）、
  可审计（revision 入 C5 事件）、可追溯（R4）。
- 配套修订 `ZA-C-WHERE-04` 与设计基准 §4 U4 原文（「旁门配置源」判定改为「快照布局之外且非
  UserConfigStore 端口的配置源」），修订与代码同一变更提交，避免红线与实现互相矛盾。

### 2.2 目标链路与 TOCTOU 封口

`resolveFeature`（URL→pack→featureId，assembly/src/index.ts:460-488）零改动。`compose` 增可选参数
`subject:{tenant, hostUserId}`；注入序：L0 基座 → sitesIndex → L1 feature/facts → **L2 个人规则/事实
（按当前 featureId 过滤，逐条带来源）** → skills → docsIndex；工具面 = L1 → L2 收紧合并。

**每回合 compose 对 L2 单次读取并定格 revision**：合并后的生效工具面（含每工具 riskTier 终值 +
revision hash）经端口入参传给 toolgate，本轮全部判定以定格结果为准；toolgate 不直接依赖
UserConfigStore（U2）。audit 的 assembly 事件与 tool 决策事件携带同一 revision——注入透明视图、
审计、执行判定三方互证（R4）。

`describeInjection` 每段/每工具输出 `origin: L0|L1|L2` 与条目 id；工具条目同时输出
`baseTier`（L1 原值）与 `effectiveTier` + 收紧来源——设计稿「自动执行 → 需确认 · 已收紧」箭头的
数据源。**视图组装边界**：注入构成视图的 L3 段来自 automation 状态接口拼装，不属 compose 注入。

L2 合并点选型（备选记录）：① 插件端拼 prompt——收紧判定下放客户端，违反 fail-closed 铁律，否决；
② gateway 拼接期——装配逻辑泄出 assembly、破坏单一产出函数同源，否决；③ assembly compose 内——**选定**。

## 3. L2 用户层契约（user-overlay.schema.json，随 adr-014 定稿）

### 3.1 schema 骨架

```jsonc
{ "schemaVersion": 1,
  "subject": { "tenant": "…", "hostUserId": "…" },
  "packs": {
    "*": { /* 全局作用域：跨站个人规则/偏好；无 restrictions（无对应工具面可收紧） */ },
    "<packId>": {
      "rules":  [{ "id", "text", "featureId?", "origin": "manual|teach", "sourceSessionId?", "createdAt" }],
      "facts":  [/* 同 rules 结构 */],
      "restrictions": {
        "riskTierRaise": { "<toolId>": "hitl|forbidden" },
        "disabledTools": [ "<toolId>" ]   // 语义=从工具面移除不展示；UI「禁用」列写 riskTierRaise:forbidden
      },
      "preferences": { "verbosity?": "concise|standard|detailed",
                       "automations": { "<id>": { "enabled", "minutes?" } } }
} } }
```

- 纯 JSON/文本（R2）；`additionalProperties:false`；每条带 origin + 作用域（R4）。
- **全局作用域 `"*"`**：承载跨站规则（「所有回复使用敬语」）与零配置站点的个人定制；注入序在
  L1 之后、pack 级 L2 之前。设计稿「全部站点」chip 对应此作用域。
- `featureId?` 缺省 = 整 pack 生效；compose 按当前 featureId 过滤——teach 卡「适用 闲鱼 · 回复买家」
  的作用域字段落点。
- 界面语言归 L0 用户侧开关（extension options 本地），不入 L2。
- 同一 toolId 在 riskTierRaise 与 disabledTools 双重声明 → schema 校验拒绝。

### 3.2 合并机械判定（R1）

- riskTier 合并 = `max(L1, L2)`，全序 `auto < hitl < forbidden`；L2 声明低于 L1 的值在**写入期即拒**。
- L2 **结构上不存在**「新增工具/改 adapter/改 execution」的表达能力——不放宽靠表达力剥夺
  （Claude Code permissions 的 deny 累积范式：下层只能贡献限制，无解除上层限制的操作）。
- 工具面按 toolId 逐项合并（Kustomize merge-key 范式），不整表替换。
- **频率维度同属 R1**：`minutes` 写入期校验 ≥ pack 预设周期且 ≥ 平台下限；节流上限不可被 L2 放宽。
- 越界引用（toolId 已不在 L1 工具集）**逐条失效** + 落审计事件 + 配置中心标红提示清理；
  其余条目照常生效——不因单条 stale 整体拒用（否则防漂移机制反而造成治理放宽）。
  仅整文件解析失败才走 §3.4 存储故障语义。

### 3.3 写入通道（R3）

- **teach 流**：对话 → 服务端生成草稿 → C3 **新增帧型 `config-draft` / `config-decision`**
  （加法演进；只复用插件端卡片 UI 呈现，不复用 hitl-request 帧语义——其 required 含 toolId+params，
  schemas/client-access-layer.schema.json:167——不混入 toolgate 裁决链路）→ 用户显式确认 →
  `PUT /v1/user-config`（JWT claims 定位 subject）→ schema + 收紧校验 → 落盘 + 审计。
- **面板结构化编辑**（overlay 页增删规则/矩阵切换）复用同一端点与校验，无需确认卡
  （用户本人直接操作即显式确认）。
- 审计：C5 新增事件类型 `user-config-write`，**记录写后完整状态**（按 SEC-01 脱敏后落盘）——
  revision hash 可经审计流重建任一历史版本内容，满足事故回放；零额外存储机制。
- 对话内容永不直写配置；「记忆是数据非指令」等 adr-013 记忆防线由 adr-014 逐条承接。

### 3.4 存储故障语义（按数据类别拆分——修正草案的整体 fail-open）

| 数据类别 | 读失败语义 | 理由 |
|---|---|---|
| rules / facts / preferences | **fail-open**：按纯 L1 装配，不阻断会话 | 记忆缺失只降体验，承 adr-013 防线 |
| restrictions | **fail-closed**：优先降级为最近一次成功读取的 revision（审计标注 stale）；无缓存可用则拒绝执行该 subject 受影响 pack 的工具 | 用户已收紧的权限绝不因存储故障回落宽松档（U7：故障不得导致治理放宽） |

### 3.5 导出

L2 导出（「配置归用户所有」卖点）挂锚点：P3.5 pack 导入导出上线时一并提供 overlay 导出。

## 4. 存储决策矩阵

| 落点 × 数据 | MVP（P2.5） | S2 配置中心 | P4 托管多租户 |
|---|---|---|---|
| 服务端 × pack | git fs `assets/packs/`（adr-007 已裁决） | 配置中心产出同构快照（hash+指针），消费端零改动即同构验收 | 同快照；内容体永不入 DB |
| 服务端 × 用户配置 | `.za/user-config/<tenant>/<hostUserId>.json` 单文件 JSON（仿 `.za/sessions` 先例；UserConfigStore 端口可换实现） | 同文件形态 | 命中触发条件 → SQLite/DB，换实现不换端口 |
| 插件 × pack | 无（装配在服务端） | —（锚点：P3.5 评估是否需要本地缓存及其消费方——当前插件端无任何读 pack 内容的代码路径，先自证再引入） | 同 |
| 插件 × 用户配置 | 仅偏好本地镜像（现有 `za.*` 键保留），事实源在服务端 | 同 | 同 |

**DB 引入触发条件**（命中任一才迁，否则属 META-01 投机复杂度）：① 在线多写者需事务；
② 按用户/租户条件查询定向（灰度装配）；③ 条目规模使整目录读入成瓶颈；④ 变更审计需独立于发布节奏。
迁移形态：先「元数据/指针入 DB、内容体仍为不可变文件」的混合模式。

L2 事实源选型（备选记录）：① 插件 chrome.storage——收紧参与 toolgate 判定必须服务端可得且
fail-closed，storage.sync 100KB 配额不可靠，否决；② SQLite 起步——单写者读多写少场景牺牲
人可读/git diff，无信号先付成本，否决；③ 服务端 JSON 文件——**选定**。

## 5. 实施分期（每步验收含 `pnpm -r build` + 串行 test 全绿不回归）

1. **P2.5-a 契约先行**（adr-007 纪律），contracts 一次性落齐：
   - `user-overlay.schema.json`（§3 全量，含 `"*"` 作用域与 verbosity）；
   - pack v2 可选字段 + **assembly 载入期语义**（exclude 判定、engines 拒载、skills/docs 闭单对账、
     preparation.workflows 子集校验）——拒载类全是加法，旧 pack 不受影响；
   - **C5**：type 枚举增 `user-config-write`、assemblyData 增 `userConfigRevision`
     （现 schema `additionalProperties:false` 会拒收，故必须在本步改，audit-event.schema.json:18/106-120）；
   - **C3**：新帧型 `config-draft`/`config-decision`；
   - **C6**：InjectionBlock 增 `origin`/`baseTier`/`effectiveTier`（packages/contracts/src/ports.ts:76-80）。
   - 验收：现有全部 packs（含新增 knowledge-only fixture）原样过校验；ajv strict 通过。
2. **P2.5-b 合并链路**：UserConfigStore 端口 + fs 实现（apps/server 唯一组装点）；compose 增 subject、
   收紧合并、revision 定格并经端口传 toolgate；describeInjection 三字段输出。
   验收单测：子集校验、max(riskTier)、频率下限、越界逐条失效、双用户隔离、
   rules 缺失 fail-open / restrictions 缺失 fail-closed 两分支。
3. **P2.5-c 写入通道**：teach 草稿帧 + `PUT /v1/user-config` + 面板编辑复用 + `user-config-write` 审计
   （含写后全量脱敏快照）。验收 E2E：草稿 → 确认 → 下轮注入含该规则、透明视图标 L2 与收紧箭头。
4. **P3.5 分发**：pack zip + sha256、registry hash 指针、L2 overlay 导出。验收：hash 失配拒载；回滚=改指针。
5. **S2/P4**：生产端替换（git → 配置中心）与用户配置存储外置评估；验收 = 消费端零改动的同构验证。

## 6. 水平扩展与存储演进（P4 部署预案）

单实例是编排器形态（每会话耗时在等 LLM 返回），第一瓶颈几乎必然是 LLM 配额与成本而非应用实例，
不提前拆（META-01）。用户量真正压垮单实例时按三级走，**只换存储引擎与部署拓扑，数据契约零改动**：

1. **垂直扩展**（现在 → 相当远）：单实例可承载数千并发 SSE 会话。
2. **单体水平复制**（P4 托管量级）：多实例 + 会话亲和路由；进程绑定状态逐项外置——
   user-config 换 UserConfigStore 的 DB 实现（触发条件①正式命中，换实现不换端口）、
   nonce/会话移共享存储、自动化调度器单 leader 或分布式锁、审计换中心 sink（U6 已解耦 schema 与落点）。
3. **S4 七系统拆分**（标准版）：端口 1:1 变 RPC（U1 保证签名语义不变），各系统独立伸缩
   （toolgate 无状态可横扩、llm-port 按配额池管理）。

对用户数据存储的影响边界：

| 数据 | 扩展后 | 契约影响 |
|---|---|---|
| pack 内容体 | 仍为不可变文件（共享卷/对象存储/CDN，hash 寻址天然可缓存） | 无 |
| registry/租户清单 | 指针表入 DB（触发条件①②命中） | 无（adr-020 已裁定指针入库、内容体永不入库） |
| user-config | 文件 → DB/共享存储 | schema/revision/故障语义不变，仅换 UserConfigStore 实现；revision 定格值随端口入参走，不依赖实例本地状态，多实例下语义照常成立 |
| 会话 / nonce | 外置共享存储 | 无（运行态，非契约面） |
| 审计 | 中心化 sink | 无（U6） |

进程绑定状态清单（水平复制的第一批实操项）：会话+SSE 亲和、nonce 共享校验、user-config 并发写、
调度器去重、审计汇聚；pack 内容只读无影响。

## 7. deferral 登记（WHEN-01）

| 项 | 锚点 |
|---|---|
| 用户自建触发器契约（平台通用模板实例化，设计稿自动化页「用户自建」来源） | adr-019 自动化泛化落地时立案 |
| preparation/workflow 服务端硬编码真泛化（tool-definition allOf 分形 + gateway/prepare-intent/fulfillment 分支） | 第二个履约站点 pack 接入时 |
| 引导锚点 capabilities.anchors 的装配端消费 | D2（引导 capability 落地） |
| pack 签名与来源信任 | adr-013:85「越出本仓分发时」 |
| 插件端 pack 缓存 | P3.5 评估（先自证消费方） |
| pack 组合/优先级（一站点多 pack） | P5 ADR 锚点，不提前 |
| 部署架构小节（会话亲和 + nonce 共享 + 调度器去重，§6 第 2 级实操清单）补入 roadmap | P4 托管启动时 |
| BYOK 密钥在托管形态的传递语义（设计稿承诺「仅存本机」 vs 服务端 llm-port 需用键；倾向：本机存储 + 随请求透传 + 服务端只驻内存不落盘） | P4/D4 裁决时 |
