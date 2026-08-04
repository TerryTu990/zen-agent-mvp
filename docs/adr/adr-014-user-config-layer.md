# adr-014: 用户级配置层（L2 个人定制与用户记忆）

## 状态

提议（2026-08-04，随 `plans/2026-08-04-site-pack-and-user-config-tech-plan.md` 定稿；
了结 adr-013「跨会话用户记忆挂锚点 ADR-014」与产品形态文档待决 D1。编号补 adr-013/adr-015 预留位）

## 背景

产品形态定义确立配置四层 L0-L3，其中 L2（个人定制）是「用户可塑形」第一次被普通用户触达的层，
但契约完全缺位。定稿设计稿（overlay/teach/injection/automation 卡）已固化 L2 的交互承诺：个人规则、
权限只收紧矩阵、teach 沉淀确认、注入来源可追溯、pack 启停。adr-013 为用户记忆预留了防线要求
（记忆是数据不是指令、可见可删、写入脱敏审计、防记忆投毒）。

身份现状：C2 `identity-claims` 要求 `{sub, tenant, roles, hostUserId, iss, exp}`；服务端 HS256 验签 +
iss 白名单（auth.ts）；存在自签激活 token 路径（demo-token.ts，当前生产实际形态）。

个人差异经分析分三层：**提示层**（想法/偏好，文本规则可表达）、**参数层**（同一工具的用户级参数值）、
**能力层**（用户需要 pack 之外的工具）。本 ADR 只让 L2 承载前两层；能力层显式归 pack 层（自建 pack）。

## 决策

### 1. subject 与身份：渐进绑定

L2 归属键 `subject = (tenant, hostUserId)`，取自每次请求的 C2 claims；`iss` 区分三种签发形态，
C2 契约零改动（hostUserId 语义泛化为「签发方名下的稳定用户标识」）：

| 形态 | 签发方 | hostUserId |
|---|---|---|
| ToB 嵌入 | 宿主系统 | 宿主用户 ID |
| 自托管/通用插件默认 | 服务端自签激活（现 demo-token 路径演进） | **匿名安装身份**：插件首次运行生成密钥对，公钥指纹为标识（防伪造，可签名请求；否决裸 UUID） |
| P4 托管 | 平台身份服务 | 平台账号 ID |

- **渐进绑定**：匿名身份起步、零注册摩擦；用户需要跨设备同步/托管配额/付费任一时升级绑定账号，
  绑定时做一次性 subject 迁移（匿名 overlay 归并入账号 subject）；匿名态的 overlay 导出文件即离线迁移载体。
- **注册机制**：P2.5-P3.5 不建；P4 托管时建最小账号——OAuth-only（Google/GitHub）+ 可选 email magic
  link，不做密码体系（零特权原则延续：不存密码哈希）。提供方选择挂 P4/D4。
- **红线**：平台账号 ≠ 宿主站点账号，永不绑定、不互推；宿主身份仍只经用户页面会话（SEC-02）。

### 2. L2 契约：`user-overlay.schema.json`

```jsonc
{ "schemaVersion": 1,
  "subject": { "tenant": "…", "hostUserId": "…" },
  "packs": {
    "*": { /* 全局作用域：跨站规则/偏好；无 restrictions/packConfig（无对应工具面） */ },
    "<packId>": {
      "enabled?": false,                    // pack 级关停；只允许 false，缺省=启用（R1 只收紧）
      "rules":  [{ "id", "text", "featureId?", "origin": "manual|teach", "sourceSessionId?", "createdAt" }],
      "facts":  [/* 同 rules 结构 */],
      "restrictions": {
        "riskTierRaise": { "<toolId>": "hitl|forbidden" },   // UI「禁用」列 = forbidden
        "disabledTools": [ "<toolId>" ]                      // 语义 = 从工具面移除不展示
      },
      "packConfig": { /* 键值；写入期按该 pack 声明的 configSchema（adr-020）校验，schema 不存在或值越界即拒 */ },
      "preferences": { "verbosity?": "concise|standard|detailed",
                       "automations": { "<id>": { "enabled", "minutes?" } } }
} } }
```

- 纯 JSON/文本（R2）；`additionalProperties:false`；每条带 origin + 作用域（R4）。
- `"*"` 全局作用域承载跨站规则与零配置站点的个人定制；注入序在 L1 之后、pack 级 L2 之前。
- `featureId?` 缺省 = 整 pack 生效；compose 按当前 featureId 过滤（teach 卡「适用 闲鱼 · 回复买家」的落点）。
- 同一 toolId 在 riskTierRaise 与 disabledTools 双重声明 → schema 校验拒绝。界面语言归 L0（extension
  options 本地），不入 L2。
- **表达力剥夺**：L2 结构上不存在「新增工具 / 改 adapter / 改 execution」的表达能力；用户级能力扩展的
  唯一通道是自建 pack（走 L1 载入校验与 riskTier 声明）。

### 3. 合并机械判定（R1）

- riskTier 合并 = `max(L1, L2)`，全序 `auto < hitl < forbidden`；L2 低于 L1 的声明**写入期即拒**。
- 工具面按 toolId 逐项合并（merge-key 范式），不整表替换。
- 频率同属收紧维度：`minutes` 写入期校验 ≥ pack 预设周期且 ≥ 平台下限；节流上限不可被 L2 放宽。
- 越界引用（toolId 已不在 L1 工具集）**逐条失效** + 审计事件 + 配置中心标红提示清理，其余条目照常
  生效；仅整文件解析失败走 §6 存储故障语义。

### 4. 装配与判定链路

- 合并唯一发生在 assembly `compose` 内（被否：插件端拼装=治理下放客户端；gateway 拼接=装配逻辑外泄）。
- `compose` 增可选参数 `subject`（U1 JSON 可序列化）；**每回合对 L2 单次读取并定格 revision（内容
  hash）**；合并后的生效工具面（含每工具 riskTier 终值 + revision）经端口入参传给 toolgate，本轮全部
  判定以定格结果为准，toolgate 不直接依赖 UserConfigStore（U2，封 TOCTOU）。
- `describeInjection` 每段/每工具输出 `origin: L0|L1|L2` 与条目 id；工具条目同时输出 `baseTier` 与
  `effectiveTier` + 收紧来源（设计稿收紧箭头的数据源）。注入构成视图的 L3 段由 automation 状态接口
  拼装，不属 compose 注入。
- audit 的 assembly 事件与 tool 决策事件携带同一 `userConfigRevision`——透明视图/审计/判定三方互证（R4）。

### 5. 写入通道（R3）

- **teach 流**：对话 → 服务端产草稿 → C3 **新增帧型 `config-draft` / `config-decision`**（加法演进；
  只复用插件卡片 UI，不复用 hitl-request 帧语义与 toolgate 裁决链路）→ 用户显式确认 →
  `PUT /v1/user-config`（JWT claims 定位 subject）→ schema + 收紧校验 → 落盘 + 审计。
- **面板结构化编辑**复用同一端点与校验，无需确认卡（本人直接操作即显式确认）。
- **审计**：C5 新增事件类型 `user-config-write`，记录**写后完整状态**（SEC-01 脱敏后落盘）——任一
  revision 内容可经审计流重建，满足事故回放；对话内容永不直写配置。

### 6. 存储与故障语义

- 事实源：服务端 `.za/user-config/<tenant>/<hostUserId>.json` 单文件 JSON（仿 `.za/sessions` 先例）；
  `UserConfigStore` 端口化，换实现不换端口。DB 引入触发条件沿技术方案 §4（命中任一才迁）。
- 插件端仅偏好本地镜像（现有 `za.*` 键保留），非事实源。L2 导出挂锚点：P3.5 与 pack 导入导出一并提供。
- **故障语义按数据类别拆分**（修正 adr-013 锚点原文的整体 fail-open）：

| 数据类别 | 读失败语义 |
|---|---|
| rules / facts / preferences / packConfig | fail-open：按纯 L1 装配，不阻断会话 |
| restrictions / enabled | **fail-closed**：优先降级为最近一次成功读取的 revision（审计标注 stale）；无缓存则拒绝执行该 subject 受影响 pack 的工具——存储故障不得导致治理放宽（U7） |

### 7. 配套红线修订（与实现同一变更落地）

修订 `ZA-C-WHERE-04` 与设计基准 §4 U4 为**双源模型**：L1 = 版本化不可变快照（同构铁律不变）；
L2 = subject 维度运行期覆盖层，经 UserConfigStore 端口读取、revision 可追溯，显式排除在 U4 同构与
不可变约束之外，自带只收紧/可审计/可追溯三约束。「旁门配置源」判定改为「快照布局之外且非
UserConfigStore 端口的配置源」。

### 8. adr-013 记忆防线承接

| adr-013 要求 | 本 ADR 机制 |
|---|---|
| 记忆是数据不是指令 | L2 注入为标注来源的数据段；治理注入每轮全量重建、结构上不受 L2 影响 |
| 用户可见可删 | 注入透明视图（origin=L2 逐条）+ 配置中心增删改 |
| 写入脱敏与审计 | user-config-write 事件全量脱敏快照 |
| 防记忆投毒 | R3 确认写入：对话只产草稿，显式确认才入库 |
| 存储故障 fail-open | 按 §6 拆分：记忆类 fail-open 维持；restrictions 修正为 fail-closed |

## 理由

- 三层差异模型把「不同用户不同用法」分流到正确层：提示层 L2 rules、参数层 packConfig（pack 声明
  空间、用户取值）、能力层自建 pack——共享 pack 模型不被个人差异推翻，治理面不被用户扩张。
- 业界参照：VS Code settings（扩展声明配置 schema、用户提供值；匿名 machineId + 可选账号开同步）、
  Claude Code permissions（deny 累积：下层只能贡献限制）、Kustomize merge-key（逐项合并）、
  Obsidian（本地优先 + 可选账号）——渐进绑定与只收紧均为已验证范式。
- 完整产品视角：schema 一次覆盖到 P4 需求（tenant 维度、全局作用域、packConfig、enabled），
  P2.5 只做实现切片、不做契约返工。

## 被否方案

- 插件端合并/存 L2（chrome.storage）：收紧参与 toolgate 判定必须服务端可得且 fail-closed；storage.sync
  100KB 配额不可靠。
- gateway 拼接期合并：装配逻辑泄出 assembly，破坏单一产出函数的 compose/describe 同源。
- SQLite 起步：单写者读多写少，牺牲人可读/git diff，无触发信号先付成本（META-01）。
- L2 整体 fail-open：存储故障导致用户已收紧的权限回落宽松档，撞 U7。
- L2 承载工具定义：用户对话层可扩张工具面即绕过全部治理。
- 裸 UUID 匿名身份：不可防伪造、不可签名请求。

## 后果

- 正面：定稿设计稿的全部 L2 交互（规则列表/收紧矩阵/teach 卡/透明视图收紧箭头/pack 启停）获得
  契约支撑；R1/R3/R4 从产品规则变为机械可校验；账号体系推迟到 P4 仍不返工。
- 负面：assembly 引入运行期依赖（UserConfigStore），红线原文需配套修订；审计事件含全量快照，
  体积增大（可承受：单用户 overlay 预期 KB 级）；restrictions fail-closed 分支引入「stale revision
  缓存」实现复杂度。
- 实施映射：P2.5-a（本 schema + C3 帧型 + C5 事件/字段 + C6 InjectionBlock 三字段）→ P2.5-b
  （端口/合并/定格）→ P2.5-c（写入通道）；验收基准见技术方案 §5。
- deferral：subject 迁移接口的具体形态（P4 账号绑定实施时）；L2 导出（P3.5）；OAuth 提供方（P4/D4）。
