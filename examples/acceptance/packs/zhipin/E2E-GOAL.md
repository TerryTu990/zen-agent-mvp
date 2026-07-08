# zhipin E2E 执行 Goal（本地会话提示词）

> 用法：在 zen-agent-mvp 目录开 Claude Code，把下面「=== GOAL ===」之间的内容整段粘贴为首条消息。
> 建议配合 `/loop`（无间隔，让模型自定步调）驱动"测试→修复→继续"闭环。
> 前提：已接真实 BOSS直聘登录态浏览器（playwright MCP，有头）、真实 LLM（.env 的 ZA_LLM_*）、
> server 指向 examples/acceptance 快照根。

=== GOAL ===

你的目标：按 `examples/acceptance/packs/zhipin/E2E-TEST-PLAN.md` 对 zhipin AI 求职 agent 做端到端验证，
以「执行一个阶段 → 发现问题就修 → 重跑该阶段确认 → 继续下一阶段」的闭环推进，直到 6 个阶段全部通过或明确受阻。

## 工作循环（每一步都遵守）

1. 先读 `E2E-TEST-PLAN.md` 与 `README.md` 掌握设计意图；再读要测阶段涉及的 `features/<id>/{feature.md,facts.md,tools.json}` 与 `skills/`。
2. 用 playwright MCP 驱动真实 zhipin 页面执行当前阶段的每个 checkbox（真实点击/快照/读取）。
3. 每个断言都以**页面实际证据**判定通过与否，不以"工具返回 ok"充数（ZA-SYS-05/ ZA-C-HOW-07）。
4. 发现问题 → 定位根因 → 最小化修复（见下"修复边界"）→ **重跑刚才失败的检查**确认修好，再继续。
5. 阶段内全部 checkbox 通过后，把该阶段结论（通过项/修了什么/残留）**如实**记到进度小结，再进下一阶段。

## 阶段顺序（严格按此，后阶段依赖前阶段）

1. **阶段1 采集锚点填 facts**（最先，其余全依赖它）：对 resume/job-search/job-detail 各页 `browser_snapshot`，
   把真实 URL 路径、DOM 锚点、"立即沟通"/"投递"按钮、筛选控件类型回填到对应 `facts.md`，去掉 `⚠待核`；
   校正 `pack.json` 的 `locations`/`featureIdRules` 与 `query-jobs`/`salary-benchmark` 的真实接口（或标记放弃该工具并说明）。
2. **阶段2 ★匹配规则引擎**（核心）：用真实 JD 验证 `skills/jd-match` 的硬淘汰/软评分/回复概率/学历弹性判定合理、可解释。
3. **阶段3 打招呼循环**：greet 点"立即沟通"→ 跳聊天页 → `site_navigate` 回列表 → 续作；per-task 授权一次后自动放行。
4. **阶段4 投递记录**：greet 后自动 `record_application` 落 `.za/applications/<今天>.jsonl`；问"今天投了哪些"能 `list_applications` 汇总。
5. **阶段5 全通道+分级**：client-http(query-jobs)/server(salary-benchmark)/auto/every-call(formal-apply)/forbidden(改简历·接offer 被拒)/pack_doc。
6. **阶段6 安全合规**：授权卡展示 plan；画像不落仓；记录无敏感值；不虚构、不代做实质承诺。

## 修复边界（对症下药，别越界）

- **锚点/URL 不符** → 改对应 `facts.md`（事实层），不臆造。
- **规则误判/讲解错/匹配不合理** → 改 `feature.md`（规则）或 `skills/jd-match/SKILL.md`（评分规则）。
- **工具定义问题**（通道/分级/params 不对）→ 改对应 `tools.json`，须过 `tool-definition.schema.json` 契约。
- **平台代码 bug**（记录工具/装配/网关）→ 改 `apps/server/**` 或 `packages/**`，改动要小、可追溯到当前失败。
- 改完**必跑对应验证**再继续：改 assets/ 跑 `pnpm --filter @zen-agent/assembly test`；改平台码跑 `pnpm --filter @zen-agent/server test` + `pnpm -r build`（严格 tsc）；两类都不得回归。
- 不确定是配置还是平台问题时，先说清假设再动手（ZA-C-HOW-01），不默默按字面改。

## 安全红线（不可违背）

- **绝不对超出测试范围的真实 HR 发招呼/投递**：每阶段打招呼上限**≤3 家**，且只挑你确认可投的；先小批灰度观察风控（验证码/限流）。
- `forbidden` 动作（改简历、自动接 offer）**测的是"确实被拒"**，不是想办法绕过。
- secret/凭证不入仓/日志/对话（ZA-C-SEC-*）；`.za/applications/*.jsonl` 不得含 token 明文。
- 真实账号操作有风险，任何可能触发封号/违反 ToS 的批量动作，先停下问我。

## 完成判定

- 6 阶段全部真实通过 = 完成；输出总结（各阶段结论 + 修了哪些 + 建议提交的 diff）。
- 某阶段受阻（登录失效/风控/接口拿不到/需我决策）→ 停下，输出"已完成到哪、卡在哪、下一步建议"，不空转烧 token（ZA-C-HOW-06）。
- 全程如实：跳过的、没验证的、绕过的都要讲明，不把未通过说成通过（ZA-C-HOW-07 / WHEN-02）。

=== GOAL 结束 ===
