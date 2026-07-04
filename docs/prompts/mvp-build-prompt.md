# MVP 建设提示词（goal + workflow，一次性完成 M1→M4）

> 用法：在本项目目录开新会话，整段粘贴下方提示词。
> 过程性资产：与 HANDOFF.md 同性质，MVP 完成后可归档；事实权威以 SSOT 与 schema 为准。

---

【Goal】
一次性完成 zen-agent-mvp 的 MVP 全部实现（roadmap M1→M4），使用 workflow 编排推进。
最终验收（全部客观可验，缺一不算完成）：
1. E2E 场景全绿（浏览器自动化驱动真实插件 + examples/host-demo + 确定性 mock LLM）：
   a) 讲解问答：打开 order-list 页提问 → URL→featureId 服务端判定→装配→流式回答含 facts.md 事实；
   b) featureId 切换：从 order-list 跳 order-detail 再提问 → 注入换出，回答基于新功能的规则与事实；
   c) 引导高亮：问"在哪里导出"→ guide-action 下行 → 目标元素被高亮；
   d) HITL 代执行闭环：请求触发 riskTier=hitl 工具 → 会话挂起+卡片 → 确认 → 一次性签名指令
      （nonce/ttl/signature）下发 → 页面环境执行 → 结果回传过 resultSchema 校验 → 回喂 → 最终回复；
      另验：拒绝分支、nonce 重放被拒、forbidden 工具被 fail-closed 拦截；
   e) 拒答边界：与宿主无关的问题按 ZA-SYS 基座规则拒答；
   f) 审计完整性：上述每场景后 .za/events.jsonl 含对应事件链（session/assembly/tool-decision/
      hitl-verdict/tool-execution），且已脱敏。
2. pnpm -r build、pnpm -r --workspace-concurrency=1 test、pnpm lint:deps 全绿。
3. 按 ZA-EVAL 的评测集（讲解/引导/工具/HITL/拒答五维度）≥3 跑通过。

【前置阅读（开工前必须按序读完）】
HANDOFF.md → docs/reference/00-design-brief.md（SSOT）→ docs/roadmap.md →
packages/contracts/schemas/*.schema.json（契约权威）→ .claude/rules/ZA-WHERE.md（U1-U7）。

【贯穿纪律（每个 workflow 的每个 stage 都受约束）】
- 契约驱动：schema 是唯一权威。任何模块动手前，先写"实现输出 ↔ schema 校验"的契约测试；
  C3 帧三处编码（schema / contracts TS / extension frames.ts）改动必须三处同步并有测试互验；
  端口签名（packages/contracts/src/ports.ts）不得更改，实现只替换 NOT_IMPLEMENTED 体。
- TDD：每个功能单元先写红测（单测/集成测）再实现，红→绿→重构；禁先实现后补测、
  禁改断言凑绿（ZA-C-HOW-05）；每期新增代码必须有对应失败过的测试。
- E2E：插件用 Playwright chromium --load-extension 真实加载 MV3 产物；LLM 用自建确定性
  mock 端点（OpenAI-completions 兼容脚本，按输入关键词返回脚本化 tool_call/文本，
  使 E2E 可重复）；真实端点只走 .env（ZA-SEC，永不入仓）。
- 遵守全部 ZA 红线与已挂载 hooks；deferral 必挂锚点；每期如实报告（含失败输出），
  卡住 ≥3 次停下复盘而非盲试。

【Workflow 编排】
按 M1→M2→M3→M4 顺序各跑一个 workflow，期间以门收口：上期验收全绿并 commit 后才进下期
（授权本提示词即授权分里程碑 commit + push）。每个 workflow 内部统一五段结构：
① 契约测试先行（该期涉及 schema/端口的红测）→ ② 模块实现（TDD；按文件所有权分工
并行，禁跨区写入：assembly/llm-port/toolgate/audit/server/extension 各归一个 agent）→
③ 集成接线（apps/server 组装点）→ ④ 该期 E2E → ⑤ 交叉校验（契约一致性 / U1-U7 落点 /
工程红绿）+ 修复。

- M1 讲解闭环：assembly（快照读取、featureIdRules 有序首中、compose 注入与
  describeInjection 同源）+ llm-port 首个 provider（含 mock 支持）+ server（JWT 验签、
  SSE 网关、装配换出=整段覆写禁 append）+ extension（context-report 上报、会话 UI 流式渲染）。
  开工前先落本期评测集（验收对话）再实现。验收 = E2E a/b/e + 单测集成全绿。
- M2 引导：guide-action 帧下发 + extension page-action（highlight|scroll-to 闭集，D9 禁
  DOM 自动化操作）。验收 = E2E c。
- M3 代执行+HITL：toolgate 三方法（decide 分级 fail-closed / issueExecInstruction 签名
  / acceptExecResult 核销+校验+observation 规整）+ extension delegated-execution 与
  HITL 卡片 + server 挂起恢复。验收 = E2E d（含重放/拒绝/forbidden 三反例）。
- M4 审计+评测门：audit jsonl sink（脱敏、旁路、故障不进控制流）+ 全链路事件断言 +
  评测 runner（五维度 ≥3 跑）。验收 = E2E f + 评测集通过 + Goal 全项复验。

【完成定义与收尾】
Goal 三项全部客观复验通过 → 更新 HANDOFF.md 为 MVP 完成态（含未竟事项与锚点清单）→
最终 commit + push。任何一项未过，如实标注未完成并给出阻塞点与建议，禁伪造完成。

---

## 设计说明（给使用者，不属于提示词本体）

- **门控代替一把梭**：一段提示词、但内部强制四个 workflow 串行，每期"验收绿 + commit"才放行下一期，避免后期建立在未验证的前期之上。
- **E2E 两个关键选型已定死**：Playwright `--load-extension` 真实加载 MV3 插件（否则插件永远只有单测覆盖）；确定性 mock LLM 端点（否则 E2E 不可重复、无法当门）。
- **三条纪律的硬锚点**：契约驱动 = schema 校验测试先行 + 端口签名不可改；TDD = 每期代码必须有失败过的测试（配合 za-bash-guard / za-verify-on-stop hooks）；E2E = 六场景枚举，其中三个反例场景（重放/拒绝/forbidden）是 HITL 安全模型真正被测到的地方。
