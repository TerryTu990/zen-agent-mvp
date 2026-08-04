---
paths:
  - "assets/**"
  - "packages/assembly/**"
  - "packages/contracts/**"
---

# ZA-AGENT — 运行期治理边界（开发期）

> 本文件按 paths 加载：操作 `assets/**`（运行期装配制品）或 `packages/assembly/**`（装配引擎）时进上下文。
> 编号 `ZA-C-AGENT-<NN><级>`，强制级语义见 `ZA-COMMON-META.md` 头。
> 这是"agent 造 agent"项目：开发期治理（`.claude/`）与运行期治理（`assets/`）是两层，别混。

---

## ZA-C-AGENT-01*  运行期 agent 治理位置 + 开发期加载边界
**运行期 agent 治理是 `assets/system-prompt.md`（跨站点稳定基座）+ `assets/manifest.json`（registry）+ `assets/packs/<packId>/{pack.json, features/<id>/{feature.md, facts.md, tools.json}, skills/<fn>/SKILL.md}`（站点包），为其 SSOT，由平台装配引擎运行时按 packId/featureId 加载注入、MUST NOT 进开发会话；开发期只加载 `.claude/`；`docs/` 按需读、非常驻。**
- system-prompt 必为跨站点稳定基座（prompt 缓存前缀，不随 pack/featureId 变）；站点内容走每轮可换出块。
- 开发红线引用运行期治理/docs：只指位置、不内联其内容、不使其常驻；同一治理只一处描述（单一源），他处指引。
- 判定：开发红线内联运行期提示词 / 把 `assets/`·`docs/` 当常驻上下文 / 同一治理多处重复 → 触发，收敛单处 + 指位置。

> 反例：把 `assets/system-prompt.md` 内容粘进某条 ZA 红线 → 运行期治理混入开发期且重复 → 违反 AGENT-01。

---

## ZA-C-AGENT-02*  运行期 agent 规则编号约定（dev 所有）
**运行期 agent 规则一律 `ZA-SYS-NN`（跨站点基座规则，居 `system-prompt.md`）/ `ZA-FEAT-NN`（功能规则，居 `features/<id>/feature.md`）；规则(守)与 skill(用)分立，SKILL.md 正文不承载规则。编号约定 dev 维护（单一源在此），运行期制品只用不另定义。**
- 适用范围：本仓（官方）制品；社区/自建 pack 不受编号约定约束，载入校验（schema/纯数据）一律相同。
- 判定：agent 规则无 `ZA-SYS`/`ZA-FEAT` 编号 / 制品里另起编号体系 / 规则塞进 SKILL.md 正文 → 触发，按本约定归正。

> 反例：feature.md 用自定义 `R1/R2` 编号、或把"敏感操作必过 HITL"写进某 SKILL.md 当能力 →
> 编号体系漂移 / 守用混编 → 违反 AGENT-02。

---

## ZA-C-AGENT-03*  pack 制品纯数据
**pack 制品（`assets/packs/**` 及一切将被装配/下发的内容）MUST 纯数据——prompt/markdown/JSON；MUST NOT 含可执行代码（js/脚本文件、内联 `<script>`/事件处理器、远程代码引用）。**
- 页面执行逻辑（高亮/代执行）永远在插件核心代码；pack 只做声明（如 capabilities.anchors 声明锚点，不写操作脚本）。
- 判定：pack 目录出现 .js/.mjs / markdown 内嵌可执行片段 / adapter 模板引外部脚本 → 触发，移除或改声明式表达。

> 反例：在 pack 里放一段 JS「帮忙」做页面高亮 → 可执行代码入制品，破坏 CWS 远程代码合规与第三方 pack 可审计前提（adr-020）→ 违反 AGENT-03。

---

## ZA-C-AGENT-04*  用户层契约只收紧
**用户层契约（user-overlay，adr-014）MUST 保持「只收紧」表达力：MUST NOT 引入工具定义 / execution / adapter / 放宽 riskTier 或节流的任何字段；riskTier 合并语义恒为 `max(L1, L2)`。**
- 用户级能力扩展的唯一通道是自建 pack（走 L1 载入校验）；给 L2 加「方便字段」前先回答它是否构成放宽面。
- 判定：user-overlay schema 或合并逻辑出现放宽路径 → 触发，回退并复核 adr-014。

> 反例：为省事给 overlay 加 `customTools` 字段让用户直接挂接口 → 用户对话层可扩张工具面、绕过全部治理 → 违反 AGENT-04。
