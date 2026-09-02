# 整体审核 · 对标优化 · 再审核 提示词（goal + workflow，无人值守）

> 用法：在本项目目录以 **Fable 5.1** 开新会话（`claude --model claude-fable-5-1`），整段粘贴下方「提示词本体」。
> 过程性资产，与 `mvp-build-prompt.md` 同性质；事实权威以 SSOT、各 `.schema.json` 与代码为准。

---

【Goal】
对 zen-agent-mvp 做一轮**整体审核 → 对标优化 → 再次审核**，全程无人值守，请使用 Workflow 工具编排推进（run workflows）。
对标以 https://github.com/ChatGPTBox-dev/chatGPTBox 为起点、不限于它：按能力轴收集多个业界已验证的同类项目，
吸收其在**页面数据获取、agent 任务编排、产品核心功能**上的架构与产品方案；只复制模式与契约、不共享代码（adr-005 精神）。
最终验收（全部客观可验，缺一不算完成）：
1. 审核报告两份：`docs/reviews/2026-09-03-audit-r1.md`（改前）与 `docs/reviews/2026-09-03-audit-r2.md`（改后）。
   r2 对 r1 每条 blocker/major 逐条标 closed / remaining(带锚点) / new；r2 终态无未处置 blocker/major。
2. 对标研究报告 `docs/research/2026-09-03-benchmark-mechanisms.md`：覆盖五条能力轴（页面数据获取 / agent 任务编排 /
   产品核心功能 / 治理与安全 / 评测），样本 ≥8 个项目，每轴 ≥2 张源码级证据的模式卡，每张卡有 adopt / adapt / reject 裁定与理由。
3. 优化方案 `docs/plans/2026-09-03-benchmark-optimization.md`：每个采纳项可追溯到 r1 发现编号或模式卡编号，并回答宗旨两问之一；
   架构级变更配 ADR（`docs/adr/adr-024+`）。
4. 实施全部 commit 到分支 `opt/2026-09-03-benchmark-optimization`；终态门：`pnpm lint:deps` + `pnpm -r build` +
   `pnpm -r --workspace-concurrency=1 test` + 命中的 E2E 子集（mock LLM）全绿；涉 `assets/` 改动另过 `pnpm eval` ≥3 跑；
   测试用例数不低于 Phase 0 基线。
5. `HANDOFF.md` 更新为本轮完成态；交付报告 `docs/reviews/2026-09-03-optimization-delivery-report.md`。

【角色与模型分工】
- 主会话（Fable 5.1，本会话）对整个交付负责：审核裁定、架构方案、每批次实施细则（成功标准 / 文件所有权 / 测试矩阵）、
  验收、合并与提交。裁定类工作不下放。
- 实现类 agent 一律 `agent(prompt, { model: 'opus', ... })`（Opus 5）；研究 / 审核 / 评审 / 裁判 / 综合类 agent 省略 `model`
  （继承 Fable）。纯机械阶段（清单盘点、格式整理）可 `effort: 'low'`；验证 / 裁判阶段用默认或更高。
- 每个阶段一次 Workflow 调用，主会话读完结果再决定下一阶段；不写跨阶段的巨型脚本。并行改文件的实现 agent 用
  `isolation: 'worktree'` + 明确文件所有权，禁跨区写入；合并与提交只由主会话做。

【前置阅读（开工前按序读完）】
CLAUDE.md → HANDOFF.md → docs/reference/00-design-brief.md（SSOT v2）→ docs/reference/01-architecture.md →
docs/plans/2026-08-04-product-form-definition.md（R1-R9）→ docs/research/2026-08-04-browser-agent-competitive-landscape.md
（已有定位调研，本轮不重复做定位、只做机制级对标）→ docs/plans/2026-08-04-l0-l3-orchestrated-implementation.md
（上一轮编排方法，本轮沿用其批次模板与独立评审）→ docs/reviews/2026-08-05-l0-l3-delivery-report.md →
.claude/rules/ZA-WHERE.md（U1-U8）→ packages/contracts/schemas/*.schema.json。

【贯穿纪律】
- 全部 ZA 红线与已挂载 hooks 对主会话和每个子 agent 生效；两层治理别混（运行期 `assets/` 制品只在修改/验证它时读取）。
- 契约驱动 + TDD：schema 是唯一权威，契约变更只做 U3 加法；每个实现单元先写红测再实现；禁改断言凑绿（HOW-05）。
- 外科手术式改动：每一行 diff 能追溯到方案批次中的某一项（r1 发现编号或模式卡编号）；禁顺手重构与未被要求的功能。
- 对标是吸收模式不是搬代码：采纳项须说明「在 zen-agent 里落在哪个端口/模块、与 U1-U8 是否冲突、为何比现状更准确或更自由」。
  确需借用代码片段时核对 license 兼容并注明来源。
- 涉 `assets/` 改动必跑评测 ≥3 跑；确定性 mock LLM 的关键词探针与基座措辞耦合，改基座措辞须同步维护探针，禁靠改探针把红评测改绿。
- deferral 必挂锚点；同一路径卡住 ≥3 次停下复盘并记录，不盲试；报告如实附命令与输出。

【Workflow 编排】

Phase 0 基线（主会话内联，不必开 workflow）
在 main 上新建分支 `opt/2026-09-03-benchmark-optimization`；跑 `pnpm lint:deps && pnpm -r build &&
pnpm -r --workspace-concurrency=1 test && pnpm eval`，记录用例数、评测通过率、耗时到 scratchpad 作为基线。
基线红且一个修复批次内修不好 → 终止并出报告，不带病开工。

Phase A 整体审核 r1（workflow：多镜头审核 → 对抗验证 → 汇总）
九个只读审核镜头并行，每镜头产出统一 schema 的发现：
`{ id, lens, severity: blocker|major|minor, point, evidence: file:line[], why_it_matters, suggestion,
  traces_to: 'U1'..'U8' | 'R1'..'R9' | 'ZA-C-*' | 'none' }`
镜头闭集：
① 架构不变量与端口纪律（U1-U8、contracts/ports、lint:deps 盲区）；
② 页面数据获取（extension 的 page-snapshot / page-text / context-report / auto-scan / dom-steps：采集面、体量与截断、
   可见性判定、iframe/shadow DOM、SPA 变化侦测、隐私最小化）；
③ agent 任务编排（server gateway 多轮 loop、tool_call 回喂、挂起恢复、多 tab 任务组、超时/重试/取消、上下文压缩与历史）；
④ 治理链路（toolgate 分级/签名/nonce/核销/resultSchema、HITL 卡片、审计事件链完整性）；
⑤ 装配与制品（assembly compose/describeInjection、pack v2 载入、L2 只收紧合并、`assets/` 基座质量）；
⑥ 产品核心功能与 UX（sidepanel / options / 配置中心 / onboarding，对照 R1-R9 与 docs/design）；
⑦ 测试与评测有效性（单测是否覆盖真实风险点、评测场景对六维度的覆盖、mock 探针脆弱性、E2E 可复现性）；
⑧ 文档漂移（README / HANDOFF / reference / ADR 与代码事实不符处）；
⑨ 安全与隐私（SEC-01..04、页面数据外发最小化、错误泄敏、prompt injection 面）。
每条 blocker/major 交 3 个独立反驳者（默认判 refuted，≥2 票存活才保留）；minor 不验证、只汇总。
主会话汇总成 r1 报告：按镜头分节、附存活/被驳统计、给出「本轮必修 / 可延期(带锚点) / 不采纳」初判。

Phase B 对标研究（workflow：源码级深读 + 多角度扫描 → 完整性批判 → 定向补扫，loop-until-dry，≤3 轮）
- 样本以源码为证据：开源项目 `git clone --depth 1` 到 scratchpad 本地阅读；闭源产品只从官方文档/更新日志取产品模式，
  标注「不可核源码」。
- 第 1 轮固定：chatGPTBox 按四个切面各一 agent 深读（页面内容抽取与站点适配器机制；触发/挂载与站点匹配机制；
  产品功能面与设置模型；会话、多模型接入与上下文管理）。同轮按五条能力轴各一 agent 做多角度扫描，起始候选如下
  （须核实、可增删；每轴至少补 1 个自行发现的样本，以 star 数/维护活跃度/被引用作为成熟度信号）：
  · 页面数据获取：Browser Use（DOM 树序列化与可交互元素索引）、Stagehand（observe/extract、schema 化抽取）、
    Playwright MCP 与 Chrome DevTools MCP（无障碍树快照 + ref 交互）、Mozilla Readability / Defuddle（正文抽取）、Nanobrowser；
  · agent 任务编排：Browser Use（planner、action registry、step 预算、结构化输出）、Nanobrowser（Planner/Navigator/Validator）、
    Stagehand（动作缓存）、Skyvern（workflow 编排）、LangGraph / OpenAI Agents SDK（HITL interrupt 与 checkpoint）、
    Claude Agent SDK / Claude Code（skills、hooks、权限模式，作 harness 参照）；
  · 产品核心功能：chatGPTBox（划词工具、站点正则、常驻侧栏、自定义 prompt）、HARPA / Sider / Monica / MaxAI（闭源，只取产品模式）、
    Open WebUI / LibreChat（BYOK、prompt 管理）、Tampermonkey（@match 与脚本分享模型）、Claude for Chrome（站点权限与授权档）；
  · 治理与安全：Claude for Chrome 授权档、Browser Use 敏感数据遮罩与域名白名单、Playwright MCP allowed-origins、
    Chrome MV3 权限模型、OWASP LLM Top 10 中面向浏览器 agent 的 prompt injection 条目；
  · 评测：WebVoyager / Mind2Web / WebArena / BrowserGym 的任务与判据设计、Browser Use 评测 harness、promptfoo / Inspect 的评测模式。
- 模式卡 schema：`{ id, axis, pattern, source: {repo|url, path, commit|date}, evidence(引用 ≤20 行或文档原文), maturity_signal,
  zen_current(file:line 现状), applicability: high|medium|low, conflicts_with: ['U1'..'U8','ZA-C-*'],
  proposal(落在哪个端口/模块、加法路径), license_note }`。
- 每轮末一个完整性批判 agent 回答「哪条轴/哪类机制没扫到、哪张卡证据不足」，其结论生成下一轮定向补扫；
  连续 2 轮无 applicability ≥ medium 的新卡即收敛。每轮 `log()` 覆盖与放弃的样本，禁静默截断。
- 主会话对每张卡裁定 adopt / adapt / reject 并写理由，落研究报告；对既有 landscape 文档只做增量引用，不重写定位。

Phase C 方案裁定（workflow：独立提案 → 裁判组 → 主会话综合）
3 个独立提案 agent 各从一个角度（治理优先 / 用户价值优先 / 工程健康优先）基于 r1 发现 + adopt/adapt 卡产出优化提案；
3 个裁判按五项打分（宗旨两问、U1-U8 与 R1-R9 合规、风险与回滚、验证成本、价值/成本）；主会话从胜者综合并嫁接次优提案的
可取项，写成方案文档。方案按批次组织（建议 ≤6 批），每批次写清：目标、关闭的 r1 编号与模式卡编号、范围与文件所有权、
可验成功标准、测试矩阵（正常/异常/边界）、涉 assets 则评测子集、风险与回滚、是否需 ADR。
裁定红线：答不上宗旨两问的不采纳；任何松动 U1-U8 / R7 无人值守底线 / pack 纯数据（AGENT-03）的不采纳；
单一调用点的「通用」抽象不采纳；对标项若只是改名换皮而语义未变，判 reject。

Phase D 分批实施（每批次一次 workflow，沿用 l0-l3 方案 §2 五阶段模板）
① 契约与用例（并行两路，继承 Fable）：schema / 校验器 / 正反 fixtures；测试矩阵先写先红。
② 实现（`model: 'opus'`，按文件所有权并行 + worktree 隔离）：在用例红的前提下实现；实现 MUST 消费 schema 校验器；
   每个 agent 的 prompt 由主会话写清成功标准、边界与禁区。
③ 四视角独立只读评审（fresh context，继承 Fable，统一 verdict schema `{severity, point, suggestion, evidence}`）：
   产品视角（R1-R9、设计稿）/ 架构视角（U1-U8、契约文档）/ 规则视角（CLAUDE.md + .claude/rules 全集）/
   对标视角（对照模式卡：是否吸收到位、是否照搬不适配、是否引入被裁 reject 的东西）。
④ 修复回归：修全部 blocker/major → lint:deps + build + 串行 test → 同视角复核（SendMessage 续会话）；
   ≤3 轮不收敛则停下记录、进入下一批。
⑤ 批次验收：成功标准逐条核对 + 涉 assets 跑评测 ≥3 跑 + 命中 E2E 子集 → commit（中文 conventional 风格，与仓库既有
   message 一致）→ push 同名远程分支。
批次间门控：上批 commit 后才开下批；批次评审记录落 `docs/reviews/2026-09-03-b<N>-<slug>.md`。

Phase E 再次审核 r2（workflow：同九镜头 + 回归镜头 → 对抗验证 → 对照汇总）
每镜头输入 = r1 同镜头发现清单 + 本轮 diff 范围（基线 commit..HEAD），逐条标 closed / remaining / new，并追加第十镜头
「回归」（专找本轮改动引入的行为回退与测试削弱）。new 的 blocker/major 走同样 3 票反驳验证。
若存在未处置 blocker/major：最多追加 1 个修复批次（走 Phase D 模板）并出 r2 补充节；仍不干净则如实记录 + 锚点，禁伪造 closed。

Phase F 收尾（主会话内联）
更新 HANDOFF.md（完成态、验证现状、未竟事项与锚点）；只修正本轮改动导致的 README / reference / ADR 事实漂移；
跑终态门；写交付报告；最终 commit + push 分支。

【无人值守边界】
- git：允许建分支、按批次 commit、push 到 `origin` 同名分支；MUST NOT 合并或 rebase main、force-push、打 tag、
  执行 release skill 或任何部署。
- 凭证：MUST NOT 读取凭证闭集或以解释器拼接绕过；需要真实 LLM / 真实站点凭证的 E2E（`test:e2e:real`、
  `run-g6-real-site.mjs`）一律标 BLOCKED 并写明解除命令，不执行、不伪造。
- 范围：`examples/site-packs/` 只在测试依赖需要时动；不新增 pack；不改产品定位与 SSOT §1；SSOT 需修订的事实只列入
  交付报告「待 Terry 裁决」。
- 规模：单个 workflow 默认 ≤15 agent，超出须在 `log()` 说明理由；研究 3 轮不收敛即按现有覆盖收口并记录缺口。
- 停机：出现需要人裁决的红线冲突（规则互斥、SSOT 与代码冲突、对标项必须松动治理才能落地）→ 该项挂起进「待裁决」清单，
  其余批次继续；整体阻塞（基线红且修不好 / 工作区损坏）→ 停止并出报告。

【完成定义与最终报告】
Goal 五项全部客观复验通过才称完成；任何一项未过，如实标注未完成、阻塞点与建议。交付报告固定结构：
① 批次表（commit、结果、四视角处置）；② 验证证据表（命令 + 结果 + 用例数基线→终态）；③ r1→r2 发现对照表
（closed / remaining / new 计数与明细）；④ 采纳模式表（卡编号、来源、落点文件、验证方式）；⑤ 未竟事项与锚点；
⑥ 待 Terry 裁决清单；⑦ 产物路径索引。

---

## 设计说明（给使用者，不属于提示词本体）

- **六阶段而非一把梭**：审核 r1 与对标研究都在动手前完成，方案裁定把「发现」与「模式卡」压成可追溯的批次，
  再审核 r2 用同一套镜头对照 r1 逐条销项——这样「再次审核」有对照基线，而不是又一份独立报告。
- **模型分工落在 workflow 选项上**：`agent(..., { model: 'opus' })` 只给实现阶段；审核/研究/评审/裁判省略 `model`
  即继承主会话的 Fable。裁定权（adopt/reject、方案综合、验收、提交）全部留在主会话。
- **对标研究的三个硬要求**：源码级证据（clone 到 scratchpad 读，不凭印象）、模式卡带 `zen_current` 与 `conflicts_with`
  （强迫回答「落在哪、与 U1-U8 冲不冲突」）、loop-until-dry + 完整性批判（不是给一份候选清单就算扫过）。
- **无人值守的安全阀**：只在独立分支上提交、不碰 main、不发布；凭证闭集与真实站点 E2E 一律 BLOCKED 而非绕过；
  红线冲突挂起进「待裁决」而不是自行弱化。
- **规模上限**：本会话默认 workflow ≤15 agent；如需放宽，在 /config 调「Dynamic workflow size」后再开会话。
