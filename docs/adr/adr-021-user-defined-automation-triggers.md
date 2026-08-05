# adr-021: 用户自建自动化触发器（平台模板闭集 + 参数层 watches + 只读强制）

## 状态

提议（2026-08-05，随 G5「L3 自动化泛化」批次立案；了结 adr-019 遗留的「用户自建触发器无契约」缺口，
并了结产品形态定义 D3 的只读侧判定）

## 背景

adr-019 把周期自动化从插件硬编码收进 **pack 声明**（`pack.json automations[]` + 描述符下发），
但整条链路仍以「站点包作者预先声明」为前提：

- 零配置站点（无 pack）上，用户没有任何自动化通道——与产品形态 **R9 通用性曲线**「读类自动化
  （页面监测/提取/汇报）零配置任意站点可用」的承诺不符；设计稿 `settings/automation.html` 已把
  「任意站点 · 无需站点包 / 平台通用模板 / 用户自建 / 只读」画成第二分组。
- L2 用户层（adr-014）当前对自动化只有 `preferences.automations`（对 **pack 已声明** 的自动化做
  开关与周期收紧），没有「用户新建一个触发器」的表达力。
- **R7 无人值守底线**（自动化 MUST NOT 自动执行不可撤销写操作）目前由 adr-018 的一单预算 + HITL 收口
  在闲鱼场景承担；产品形态 D3 明确「R7 判定实现」的锚点是「自动化泛化（adr-019 落地）时」——
  触发器一旦对任意 URL 开放，底线不能再依赖「模型不会去点写按钮」的自觉。

关键假设（实施前提）：v1 只解决**读类**自动化；写类自动化仍须以已声明工具面为前提（R9 后半句），
本 ADR 不为其开新通道。用户自建触发器的量级是个位数（个人使用），不做调度平台。

## 决策

### 1. 平台内建自动化模板闭集（L0 平台代码）

`@zen-agent/contracts` 导出 `PLATFORM_AUTOMATION_TEMPLATES` —— **代码闭集，不是 pack 声明、不是用户数据**，
用户与 pack 均不可定义模板，只能引用：

```ts
interface PlatformAutomationTemplate {
  id: AutomationTemplateId;   // v1 闭集 = 'page-watch'
  title: string;              // 配置中心/报告卡展示名
  description: string;
  readOnly: true;             // 字面量类型（见下）
  paramsSchema: JsonObject;   // 实例参数结构权威
}
```

- **v1 唯一成员 `page-watch`**：对用户指定 URL 周期只读快照 → 与上轮比对 → 变化时产报告。
- **参数闭集**：`{ url（可解析绝对 URL，协议 ∈ {http,https}）, minutes（整数，≥ 平台下限 5、≤ 60）,
  focus?（≤200 字关注点）}`。`paramsSchema` 是参数的唯一结构权威，写入期由组合校验器编译执行
  （复用 `compileConfigSchema`），不存在「schema 声明而引擎无视」的字段。
- **`readOnly` 用字面量 `true` 而非 `boolean`**：可写模板无法被静默引入——出现可写模板须先扩类型、
  显式实现放行分支并重审 R7，缺省 fail-closed。

### 2. 用户自建触发器 = user-overlay 顶层 `watches`（参数层）

```jsonc
"watches": [{ "id": "price-watch", "templateId": "page-watch",
              "url": "https://…", "minutes": 30, "enabled": true, "focus": "价格与库存" }]
```

- 居**顶层**而非 `packs.<packId>` 下：watch 跨站点、不锚定任何 pack（零配置站点正是其主场景）。
- 上限 5 条（schema `maxItems`，属规模类判定）；`id` 文法与 C3 `user-message.automationId` 一致
  （自动回合以该 id 发起）。
- **写入通道复用既有 `PUT /v1/user-config`**（双校验链 + `expectedRevision` 乐观并发），不开新端点、
  不旁路：
  - `validateUserOverlay`（无 L1 依赖）：`templateId` 落在平台闭集内、`url` 可解析且协议闭集、
    参数投影过模板 `paramsSchema`（**minutes 平台下限即在其中**）、`id` 全表唯一；
  - `validateOverlayAgainstL1`（需 L1 基线）：watch `id` 与任一 pack 声明的 automation id **撞名即拒**
    ——两者共用 `automationId` 命名空间，撞名会使自动回合归属不可判定，进而使只读强制可被绕过。

### 3. R7 无人值守底线机械化（服务端结构强制）

`readOnly` 模板发起的自动回合，**服务端**（唯一决策点，U7）强制：

- 该轮不下发任何工具定义（`llm.chat` 不传 tools）；页面要素由服务端 snapshot-request 直接获取，pack 工具面不进入该轮——**结构上无写能力**，
  不依赖模型自觉；
- 任何代执行指令签发一律拒（越界请求以 `verdict=deny` 落审计，带 `unattendedReadOnly` 归因）；
- HITL 在无人值守 run 中**等价拒绝**：无人在场可确认，挂起等待只会让 run 悬空——直接拒绝并如实写进
  报告（R6），需要人确认的事项由用户在人工会话中处理。

`automationId` 由客户端上行，但**只收紧不授权**：服务端解析到只读模板的 watch 即收窄该轮工具面；
解析不到则按普通回合处理（工具面来源与判定链路与人工回合完全相同）——故该字段不构成放宽面。

### 4. 报告收口（R6）与客户端调度

- watch run 产出结构化报告（变化摘要 + 依据的快照要素），经完成帧 tool-card 呈现并进面板历史；
  **无变化不打扰面板**，只落审计（设计稿运行历史「无变化」行的数据源）。
- extension：watch 实例经 `GET /v1/user-config` 拉取，与 pack automation 描述符**合并调度**——复用既有
  alarm / 组级单飞锁 / SW 恢复机制，按实例 id 通用化；watch 工作页判定 = URL origin + path 前缀
  （pack automation 是 origin + workRoutes，同一判定形状）；拉取失败 **fail-closed 不调度**。
- 配置入口复用配置中心自动化页（G4 已落）的分组结构，不另起一套。

### 5. C3/C5 加法

- **C3 零新增字段**：watch run 复用 `user-message` 的 `automationRunId` + `automationId`；仅把
  `automationId` 的语义扩为「pack automation id **或** 用户 watch id」（文法本就一致）。
- **C5 加法**：事件基类加可选 `automationRunId` / `automationId`（无人值守 run 的审计归因）；
  `tool-decision` data 加可选 `unattendedReadOnly: true`（只读强制的判定归因，是「无人值守不执行写操作」
  的机械可检证据，E2E-F 断言点）。schema 与 TS 投影同步（U6）。
- 全部为可选字段新增：旧 overlay / 旧事件 / 旧帧原样有效（U3 加法路径）；`contractVersion` 不变
  （pack 面无新字段，`engines.contract` 比对基准不受影响）。

### 6. AGENT-04 合规论证（用户层只收紧）

`watches` 为何不是能力扩张、不构成治理放宽：

1. **模板是平台闭集代码**：用户提供的只有参数，模板本身不可被用户或 pack 定义或修改（对比自建 pack ——
   那才是能力层通道，且走 L1 载入校验）。
2. **落在 adr-014 三层模型的「参数层」**：L2 承载提示层 + 参数层，能力层显式归 pack 层；watch 是
   「同一平台能力的用户级参数值」，与 `packConfig` 同性质。
3. **不引入工具定义 / execution / adapter**：schema 对 watch 项 `additionalProperties:false`，
   字段闭集内没有任何可挂接口、可改执行通道的表达力。
4. **不放宽任何 riskTier 与节流**：watch 不含 riskTier 字段；`minutes` 有平台下限且写入期机械校验，
   频率只能比下限更慢。
5. **工具面结构上无写能力**：readOnly 模板发起的 run 由服务端收窄为只读内建集——即便用户把 URL 指向
   一个装有深配置 pack 的站点，该轮也拿不到该 pack 的写工具。

故 watch 的净效果是「在既有只读能力上增加一个受限的调度参数」，判定链路、工具面来源、分级矩阵全部未变。

## 理由

- 判定基准（META-01）：本设计直接兑现 R9 曲线的「读类自动化零配置任意站点可用」，同时把 R7 从「靠自觉」
  变成结构强制——两问皆答得上。
- **闭集 + 参数** 是业界成熟范式：Zapier/IFTTT 的 trigger 模板（用户配参不写代码）、Chrome
  `declarativeNetRequest`（声明式闭集替代任意脚本）、Home Assistant 蓝图（blueprint = 模板 + 输入）。
  与 adr-019 的「原语闭集、不开表达式后门」是同一条设计线（META-02 优先业界模式）。
- 只读强制的落点选服务端而非提示词：与 U7「客户端零治理判定 + 服务端 fail-closed」一致，且使
  E2E-F 可以用审计事件做机械断言，而不是判读模型行为。

## 被否方案

- **用户自由脚本/表达式触发器**（用户写条件表达式或 JS 判定变化）：可执行代码进配置违反 R2 全层纯数据与
  AGENT-03，触碰 CWS 远程代码红线，且治理面不可审计——与 adr-019 否决 DSL 同一理由。
- **L2 直接声明触发器的工具面**（watch 自带 tools/execution）：这正是 AGENT-04 的红线场景——用户层可扩张
  工具面即绕过全部治理；能力扩张的唯一通道仍是自建 pack。
- **客户端自调度 + 客户端判定只读**（服务端不参与）：治理下放不可信端，违反 U7；「无人值守不写」由客户端
  自证等于没有底线。
- **把用户触发器建模为一个隐形自建 pack**：pack 是 L1 版本化不可变快照源（U4），高频增删触发器会把用户
  运行期偏好写进 L1，污染双源模型；且 pack 门槛（围栏/工具面/载入校验）远高于「填一个 URL」。
- **模板声明进 pack（由 pack 提供通用模板）**：模板要在**无 pack** 的站点可用，挂在 pack 上自相矛盾；
  且模板承载 R7 只读强制这一治理语义，不能落在可分发的第三方制品里（U8 装配治理对制品/对话免疫）。

## 关键前提（继承 adr-019/adr-009，决定 R9 兑现度）

平台**不会自动新建页面**：周期唤醒只复用「用户已打开且已加入 zen 会话组」的目标页。因此
「任意 URL 只读监测」的实际语义是「按周期读取你已打开并入组的目标页」——目标页未打开时本轮
跳过（watch 不因此自我关停，与 pack 自动化「用户已离开工作流即停」的语义有意区分）。
模板 description 与配置中心 hint 均按此口径措辞，不宣称「打开页面」。

## 后果

- 正：零配置站点首次拥有自动化能力（R9 曲线兑现）；R7 底线可机械检证（`unattendedReadOnly` + deny 事件）；
  watch 增删复用既有写入通道与审计（`user-config-write` 记录写后全量 overlay，天然覆盖 watches）。
- 负：**比对基线是进程内状态**——服务端重启/发布后首轮只重建基线不报告，跨重启发生的变化不会补报；
  多实例部署下各实例各持基线，可能重复报告或漏报（锚点：托管形态多实例上线时迁至共享存储）。
  基线有 LRU 上界，超限逐出最旧项（同样表现为该实例下轮重新建基线）。
- 负：**变化检测的观测面**限于快照可见要素（可交互元素、表格单元格、dl 项、页面提示文本与标题），
  不含普通段落正文——纯文本型变化（如 span 内的价格数字）当前检不出（锚点：正文文本级比对随
  「首个需要正文比对的模板」立项）。
- 负：模板闭集是新契约面，新增模板须走契约 minor 迭代（刻意成本，换审计性）；watch 与 pack automation
  共用 `automationId` 命名空间，可判定性靠写入期撞名拒绝维持；watch 上限 5 条对重度用户偏紧。
- 实施分批：**①** 契约（本批：contracts 模板闭集 + overlay watches + 校验 + C5 加法）；
  **②** 服务端只读强制 + 报告收口；**③** extension 调度合并 + 配置中心 watch 增删 UI；
  **④** E2E-F 验收（任意 URL 周期只读运行、变化时报告、无人值守写操作被拒）。
- 锚点：
  - 首个 `readOnly: false` 模板出现时 → 须先扩 `PlatformAutomationTemplate.readOnly` 类型、显式实现放行
    分支并重审 R7（**产品形态 D3 的剩余部分——「何为不可撤销写」的 irreversible 标记判定——在此了结**；
    在此之前，只读模板由结构强制承担 R7，pack 写类自动化由 adr-018 的一单预算 + HITL 收口承担）。
  - watch 条数上限（5）与周期上下限调整 → 托管配额体系落地时（adr-014 §1 P4 账号批次）。
  - watch 的跨设备同步与导出 → 随 L2 导出能力（adr-014 §6，P3.5 pack 导入导出批次）。
  - 模板参数超出「URL + 周期 + 关注点」（如需登录态页监测、多页对比）→ 走契约 minor 扩模板闭集或扩参数，
    **不开表达式后门**（承 adr-019 同款红线）。
