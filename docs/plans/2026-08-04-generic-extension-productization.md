# Zen Agent 通用插件产品化规划

> 状态：规划。前置事实：`codex/zen-commerce-agent` 已 fast-forward 合回 `main`（`d9d51ed`，extension 0.3.4，生产在跑）。
> 本文确立产品形态决策——**单一通用插件 + 站点包（site pack）**，并接手
> `2026-07-22-zen-commerce-agent.md` §1 推迟的命名/定位决策与本次合并遗留的去硬编码 deferral。
> 架构事实权威仍是 `reference/00-design-brief.md` 与 `reference/01-architecture.md`；本文只管产品形态与分期。

## 1. 产品定位决策

**一个产品，不是两个版本。** 终局目标（Terry 2026-08-04 定调）：**「浏览器 agent 的 Claude Code / AI 时代的
Tampermonkey」**——Claude in Chrome、ChatGPT Atlas、Gemini in Chrome 给的是不可改的通用 agent；Zen Agent
给的是可被用户塑形的 agent harness：每个站点、每个人，都能有自己的规则、知识、工具面和自动化钩子
（宗旨基准已随此更新，见 `../reference/00-design-brief.md` 头部勘误）。

Zen Agent 是通用「站点智能体」Chrome 插件平台：
讲解 + UI 引导 + 受控代执行，能力面由 site pack（`assets/packs/<id>/`）声明式提供。
闲鱼（`xianyu-seller` pack）不是独立产品，而是**首个深度配置的 pack**——它定义了 pack
机制需要支撑的配置深度上限（周期触发、服务端 prepare 工具、外部库存账本）。

推论（替代 2026-07-22 方案 §1 的临时定位）：

- 主品牌回归平台名（Zen Agent）；「Zen Commerce Agent」降级为**发行变体**（打包时选定 pack 集合 + 品牌皮肤），不再是仓库/产品身份。
- 判定基准：任何"闲鱼专属"诉求，先问能否表达为 pack 声明；不能表达的，先扩展 pack 契约（C1 工具定义等），最后才允许进核心代码——且必须带回本文 §3 P1 的验收基准复查。

## 2. 现状差距清单（合并后 `main` 的事实）

| # | 差距 | 事实 |
|---|---|---|
| A | 核心渗入闲鱼硬编码 | `apps/server/src/xianyu-{shipping,fulfillment}.ts` 被 `gateway.ts` 直接 import；`gateway.ts` 按 `featureId === 'xianyu-*'` 写死注入 prepare 工具；`apps/extension/src/xianyu-auto-scan.ts` 站点专属触发逻辑 |
| B | 产品身份漂移 | `apps/extension/manifest.json` name/description 为闲鱼垂直文案；根包名 `zen-commerce-agent` |
| C | 权限面过宽 | `host_permissions: <all_urls>` + 全站 content script，商店审核高风险面 |
| D | 服务端形态 | 插件必须配自托管 server（TLS + options 手填 URL），无开箱体验；无账号/多租户 |
| — | 无需处理 | `packages/fulfillment`、`packages/card-inventory` 经查零 xianyu 引用，是通用能力，保留原位 |

## 3. 产品分期（P 线）

P 线是产品形态线，与 roadmap 的 S 线（架构演进）正交：P1/P2 不依赖 S 线；
P3 部分依赖 S2（配置中心 = pack 分发的自然载体）；P4 与 S4（多租户）交织，可按需最小化提前。

### P1 内核归一（去硬编码）——本次合并 deferral 的了结处

范围：把差距 A 的闲鱼代码下沉为 pack 声明驱动。

- `gateway.ts` 的 `PREPARE_XIANYU_*` 工具注入 → 泛化为「pack `tools.json` 声明服务端 prepare 工具」的通用机制（进 C1 工具定义契约，schema 扩展走 U3 兼容路径）；`xianyu-{shipping,fulfillment}.ts` 的领域逻辑改由声明配置 + 通用执行器承载。
- `xianyu-auto-scan.ts` → 泛化 adr-018 的周期触发为 pack 声明（触发条件、目标 feature、节流参数进 pack 契约）。
- 验收基准：
  1. `apps/` 与 `packages/` 源码 grep 无 `xianyu`（测试 fixture 除外）；闲鱼全部能力仅由 `assets/packs/xianyu-seller/` 提供；
  2. 改造 `examples/host-demo` 为第二个消费方，验证"接入新 pack 零核心代码改动"；
  3. 全量 build/test 绿 + xianyu E2E（`run-xianyu.mjs`）回归通过 + `assets/` 改动跑 pack 评测（ZA-EVAL 纪律）。
- 触发锚点：P2 品牌发布前必须完成；即使 P2 延期，最迟**第二个真实站点 pack 接入时**强制了结。

### P2 产品身份与发行变体

范围：差距 B。P1 完成后执行（品牌回归前先保证内核是通用的，避免"名实不符"二次返工）。

- 平台名回归：extension manifest name/description、根包名、release 工具链产物命名；`@zen-agent/*` 包名本就未漂移，不动。
- 发行变体机制：`release/build-extension.sh` 按变体参数打包（内置 pack 集合 + 品牌文案），闲鱼版成为 `commerce` 变体持续出包，生产渠道不中断。
- 版本策略：插件沿用现有独立 semver（0.3.x 续走）；平台 workspace 包继续 0.1.0 私有不发布，商店产品版本以 manifest 为准。
- 验收基准：通用变体与 commerce 变体从同一 commit 各自出包安装可用；commerce 变体行为与 0.3.4 对齐（E2E 回归）。

### P3 商店合规与权限最小化

范围：差距 C + Chrome Web Store 上架合规。

- 权限收敛：`<all_urls>` → 按 pack 声明的站点域生成 `host_permissions`/`optional_host_permissions`，运行时 `chrome.scripting.registerContentScripts` 动态注册；generic 模式（任意站点）改为用户显式授权（activeTab / 运行时请求）。
- CWS 远程代码红线自查：pack 必须保持**纯数据**（prompt/markdown/JSON），装配与服务端下发内容不得含可执行 JS——这已是架构事实（装配注入的是 prompt/工具面），上架前补书面自查记录。
- 合规资产：隐私政策、数据收集声明（会话内容出境到 LLM 的披露）、商店素材。
- 验收基准：通用变体以最小权限通过 CWS 审核上架；闲鱼站点在权限收敛后 E2E 仍通过。

### P4 服务端产品化（开箱体验）

范围：差距 D。商店用户不可能人人自托管 server。

- 托管服务：官方 hosted server（复用现生产 `agent.flash-api.com` 链路），插件默认指向托管端，自托管降级为高级选项；账号/配额/多租户按 roadmap S4 的最小子集提前（仅到"能区分用户、能限量"为止，不提前做七系统拆分）。
- pack 分发：内置 pack（随插件发行）+ 服务端快照下发（纯数据，与 S2 配置中心同构演进）。
- 验收基准：新用户安装 → 登录/试用 → 在目标站点完成一次讲解与一次 HITL 代执行，全程零手工配置。

### P5 用户维度（个人塑形层）

范围：目标「每个站点、每个人」中的**每个人**——用户级配置叠加在站点 pack 之上。依赖 P4 用户体系。

- **user overlay**：用户级规则/知识/自动化叠加站点 pack；先设计 pack 组合与优先级（承 adr-013「pack 间依赖/组合」锚点）。
- **local pack 信任分层**：可分发 pack 维持声明式闭集（可审计、CWS 合规）；用户自写 local pack 允许高表达力——显式开关启用、受益与风险同主体（Tampermonkey/Chrome 开发者模式同款分层），副作用仍全量过服务端 toolgate（U7 不随信任层松动）。承 adr-019 锚点。
- **ADR-014 用户记忆**：记忆是数据不是指令、用户可见可删、写入脱敏与审计、防记忆投毒（承 adr-013 既有锚点）。
- 验收基准：同一站点两个用户各自叠加规则/自动化互不影响；用户 overlay 不能改变任何治理判定（装配透明铁律复查）。

## 4. deferral 登记

| 项 | 来源 | 触发锚点 | 状态 |
|---|---|---|---|
| gateway/extension 去 xianyu 硬编码 | 本次合并（方案 A） | P1；最迟第二个真实站点 pack 接入时 | 未了结 |
| 仓库目录/包 namespace 是否重命名 | 2026-07-22 方案 §1 | P2 品牌回归时一并裁决（当前倾向：仓库名可保留，产品名必须回归） | 未了结 |
| 账号/配额最小实现的架构边界 | 本文 P4 | P4 启动时对照 S4 不变量（U1-U7）出 ADR | 未了结 |
| 用户自有 local pack 信任分层（高表达力层） | adr-019 锚点 / 本文 P5 | P4 用户体系就位时设计 | 未了结 |
| user overlay 的 pack 组合与优先级 | adr-013 锚点 / 本文 P5 | P5 启动时出 ADR | 未了结 |
