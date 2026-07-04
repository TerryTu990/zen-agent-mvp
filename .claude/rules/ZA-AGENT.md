---
paths:
  - "assets/**"
  - "packages/assembly/**"
---

# ZA-AGENT — 运行期治理边界（开发期）

> 本文件按 paths 加载：操作 `assets/**`（运行期装配制品）或 `packages/assembly/**`（装配引擎）时进上下文。
> 编号 `ZA-C-AGENT-<NN><级>`，强制级语义见 `ZA-COMMON-META.md` 头。
> 这是"agent 造 agent"项目：开发期治理（`.claude/`）与运行期治理（`assets/`）是两层，别混。

---

## ZA-C-AGENT-01*  运行期 agent 治理位置 + 开发期加载边界
**运行期 agent 治理是 `assets/system-prompt.md`（跨功能稳定基座）+ `assets/features/<id>/{feature.md, facts.md, tools.json}`（功能换出块：规则/事实/工具面）+ `assets/skills/<fn>/SKILL.md`（功能 skill），为其 SSOT，由平台装配引擎运行时按 featureId 加载注入、MUST NOT 进开发会话；开发期只加载 `.claude/`；`docs/` 按需读、非常驻。**
- system-prompt 必为跨功能稳定基座（prompt 缓存前缀，不随 featureId 变）；功能内容走每轮可换出块。
- 开发红线引用运行期治理/docs：只指位置、不内联其内容、不使其常驻；同一治理只一处描述（单一源），他处指引。
- 判定：开发红线内联运行期提示词 / 把 `assets/`·`docs/` 当常驻上下文 / 同一治理多处重复 → 触发，收敛单处 + 指位置。

> 反例：把 `assets/system-prompt.md` 内容粘进某条 ZA 红线 → 运行期治理混入开发期且重复 → 违反 AGENT-01。

---

## ZA-C-AGENT-02*  运行期 agent 规则编号约定（dev 所有）
**运行期 agent 规则一律 `ZA-SYS-NN`（跨功能基座规则，居 `system-prompt.md`）/ `ZA-FEAT-NN`（功能规则，居 `features/<id>/feature.md`）；规则(守)与 skill(用)分立，SKILL.md 正文不承载规则。编号约定 dev 维护（单一源在此），运行期制品只用不另定义。**
- 判定：agent 规则无 `ZA-SYS`/`ZA-FEAT` 编号 / 制品里另起编号体系 / 规则塞进 SKILL.md 正文 → 触发，按本约定归正。

> 反例：feature.md 用自定义 `R1/R2` 编号、或把"敏感操作必过 HITL"写进某 SKILL.md 当能力 →
> 编号体系漂移 / 守用混编 → 违反 AGENT-02。
