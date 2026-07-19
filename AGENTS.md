# zen-agent-mvp

嵌入式**功能辅助智能体**平台（MVP）：在 ToB 宿主系统上叠加 agent，按用户当前所在功能（`featureId`）
动态装配规则/skills/工具集，提供 **功能讲解 + UI 引导 + API 调用协助**。一切复杂度须能自证：
**如何让 agent 更准确地辅助用户使用宿主系统**——答不上来不引入。

> 本文件是 Codex 自动加载的开发期入口。奠基期事实权威：`docs/reference/00-design-brief.md`（设计基准 SSOT）；
> 架构解释见 `docs/reference/01-architecture.md`，契约细节以各 `.schema.json` 为准。

## 不可违背的边界（红线摘要，全文见 .claude/rules/）

- **端口纪律**：模块间禁直接 import、组装唯一在 `apps/server`；端口只传 JSON 可序列化值。→ `ZA-C-WHERE-01/02`
- **决策永远服务端 fail-closed**：分级/HITL 判定不下放客户端；代执行指令一次性签名（nonce+ttl），结果过 schema 校验才回喂 agent。→ `ZA-C-WHERE-07`
- **装配对 agent 透明**（治理不可被对话内容改变）、**审计永远旁路**（record-only，故障不进控制流）。→ 设计基准 §3 边界铁律 + `ZA-C-WHERE-06`
- **secret 永不入仓/Context/日志**；密钥走 `.env` / `credentials.local.json`；`.za/events.jsonl` 落盘前脱敏。→ `ZA-C-SEC-*`
- **写期防线命中即拦、hook 自失效则放行**（自身异常不拖垮主对话，非绝对 fail-closed）。

## 治理分层（这是"agent 造 agent"项目，两层治理别混）

- **开发期**（约束 Codex/Terry 开发 zen-agent-mvp 本身）：红线本体复用 `.claude/rules/ZA-*.md`；Codex 通过本文件下方的强制加载协议读取。通用按类型 `ZA-COMMON-{META,WHEN,HOW,HOW-PROJECT,SEC}.md`；专属按系统边界 `ZA-WHERE`(架构不变量 U1-U7)/`ZA-AGENT`(运行期治理边界)/`ZA-EVAL`(功能配置评测)。编号 `ZA-C-<区>-NN`。
- **运行期**（约束产品内嵌 agent 辅助用户）：治理在 `assets/`——`system-prompt.md`(跨功能稳定基座) + `features/<id>/{feature.md, facts.md, tools.json}`(功能换出块：规则·守/事实/工具面) + `skills/<fn>/SKILL.md`(功能 skill·用)，由平台**装配引擎运行时**按 featureId 加载注入。编号 `ZA-SYS-*`(基座)/`ZA-FEAT-*`(功能)；规则(守)与 skill(用)分立。
- **别混（铁律）**：运行期治理 **MUST NOT 进开发会话**；开发红线**不内联**运行期内容、只指位置；`docs/` 按需读、非常驻。加载边界与编号的权威见 `ZA-C-AGENT-01/02`。

## Codex 规则加载协议（强制）

Codex 不会原生扫描 Claude Code 的 `.claude/rules/`。开始任何任务、读取实现或修改文件前：

1. **常驻规则必须完整读取**：`.claude/rules/ZA-COMMON-META.md`、`ZA-COMMON-WHEN.md`、`ZA-COMMON-HOW.md`、`ZA-COMMON-SEC.md`。
2. 任务涉及 `*.ts` / `*.mts` / `package.json` / `tsconfig*.json` / `pnpm-workspace.yaml` 时，完整读取 `ZA-COMMON-HOW-PROJECT.md`。
3. 任务涉及 `packages/**`、`apps/**` 或 `assets/**` 时，完整读取 `ZA-WHERE.md`。
4. 任务涉及 `assets/**` 或 assembly 装配实现时，完整读取 `ZA-AGENT.md`；涉及 `assets/**` 时还须完整读取 `ZA-EVAL.md`。
5. **禁止**把 `assets/system-prompt.md`、`assets/features/**`、`assets/skills/**` 当作开发期规则加载；只有当前任务需要修改/验证对应运行期制品时才读取。
6. 若规则文件之间或规则与用户要求冲突，停止并向用户指出具体条款，不得自行弱化红线。

规则读取是任务动作的前置条件，不得仅凭本索引摘要代替。规则源仍保持单份，避免 Claude Code 与 Codex 两套副本漂移。

## .claude/rules/ 索引（开发期红线，按通用类型 + 系统边界）

| 文件 | 类/系统 | 管什么 | 加载 |
|---|---|---|---|
| `ZA-COMMON-META.md` | 通用·META | 宗旨基准、业界最佳实践优先、执行层⟂人读层、尺寸守卫 | 常驻 |
| `ZA-COMMON-WHEN.md` | 通用·WHEN | deferral 有界+锚点、验证通过才称完成 | 常驻 |
| `ZA-COMMON-HOW.md` | 通用·HOW | 编码通用元准则（先思考/简洁/外科/目标驱动/不伪造/卡住即停/如实/注释纪律） | 常驻 |
| `ZA-COMMON-HOW-PROJECT.md` | 通用·HOW(TS) | 全 ESM/严格基线/catalog/测试串行/风格匹配 | 按需(*.ts) |
| `ZA-COMMON-SEC.md` | 通用·SEC | secret 不入仓、凭证注入不写值、凭证读禁区、错误不泄敏 | 常驻 |
| `ZA-WHERE.md` | 架构不变量 | U1-U7 平滑升级红线：端口 JSON / 禁横向 import / 通道闭集 / 快照不可变同构 / 五能力契约 / 审计 schema 独立 / 决策服务端+一次性签名 | 按需(packages/apps/assets) |
| `ZA-AGENT.md` | 运行期治理边界 | `assets/` 装配制品 MUST NOT 进开发会话、`ZA-SYS`/`ZA-FEAT` 编号约定 | 按需(assets/assembly) |
| `ZA-EVAL.md` | 功能配置评测 | 改 assets/ 必跑评测（讲解/引导/工具/HITL/拒答五维度）、≥3 跑判回归、示例与评测互斥、素材同仓 | 按需(assets) |

**强制级图例**：`*` 无自动拦截、必须自守、宁可停下问人；`~` 建议性、偏离须说明理由；条款旁 `【hook 强制】` 表示有脚本硬拦。

## Codex 执行层资产（hooks 写期防线 + skills）

**开发期 guard hooks**（`.codex/hooks/`，由 `.codex/hooks.json` 挂载；项目需处于 trusted 状态，并在首次运行时用 `/hooks` 审核信任）：

| hook | 触发 | 守哪条红线 |
|---|---|---|
| `za-secret-guard` | PreToolUse(Bash/apply_patch/Edit/Write/Read/Grep) | SEC-01/02/03 secret 明文、凭证赋值、凭证闭集读禁区 |
| `za-bash-guard` | PreToolUse(Bash) | HOW-05 禁 `--no-verify`/绕 pre-commit 门、commit 暂存扫描（secret / 无锚点 TODO=WHEN-01） |
| `za-verify-on-stop` | Stop | WHEN-02 未验证 TS 改动时要求继续验证（下一次 Stop 自动放行，防循环） |

**skills**（`.agents/skills/`）：Codex 可自动发现；当前发布流程见 `.agents/skills/release/SKILL.md`。Claude Code 对应副本仍在 `.claude/skills/`。

**工具链**：Node ≥22、pnpm workspace + catalog、TS 5.8 全 ESM 严格、vitest 串行
（全量验证：`pnpm -r build` + `pnpm -r --workspace-concurrency=1 test`；事实权威以 `README.md` 与各配置文件为准）。
