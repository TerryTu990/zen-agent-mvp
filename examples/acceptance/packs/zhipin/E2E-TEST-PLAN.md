# zhipin AI 求职 Agent —— E2E 测试计划（由你在真实环境执行）

> 本文档列出接入真实 BOSS直聘登录态后需要人工执行的端到端验证。
> 自动化层（装配加载 / featureId 换装 / 工具面投影 / 记录工具读写 / 严格类型 / 依赖纪律）**已在仓库测试中全绿**，
> 见 `packages/assembly/test/zhipin-pack.test.ts`（18 项）与 `apps/server/test/applications.test.ts`（6 项）。
> 下面是这些自动化覆盖不到的部分——必须真实页面 + 真实 LLM + 真实 DOM 才能验证。

## 前置准备

- [ ] BOSS直聘求职者账号登录态（headless 过不了登录墙，用有头浏览器 + 已登录 profile）
- [ ] 接真实 LLM（`.env` 的 `ZA_LLM_*`），server 启动指向 `examples/acceptance` 快照根
- [ ] `.env` 配 `ZA_CRED_ZHIPIN_SALARY_KEY`（salary-benchmark 若要真跑）、`ZA_APPLICATIONS_DIR`（可选，缺省 `.za/applications`）
- [ ] ⚠ 安全：先用**小批量上限（如 3 家）**试跑，避免触发 BOSS直聘风控（验证码/限流/封号）

## 阶段 1：采集真实锚点，填实 facts（去掉 ⚠待核）

对每个 feature 页 `page_snapshot`，把真实值回填到对应 `facts.md`：
- [ ] **resume**：简历各分区（求职期望/工作经历/技能）的可读锚点、真实 URL 路径
- [ ] **job-search**：搜索框/筛选控件（原生 select 还是自定义下拉）、职位卡片字段、"立即沟通"按钮的文案/role
- [ ] **job-detail**：职责/任职要求/薪资/公司信息锚点、"立即沟通"与（若有）"投递简历"按钮
- [ ] 校正 `pack.json` 的 `site.locations` 与 `featureIdRules[].urlPattern` 为真实路径
- [ ] 校正 `job-search.query-jobs` 的真实职位查询接口（urlTemplate/参数/返回结构）
- [ ] 校正 `job-detail.salary-benchmark` 的真实第三方薪资接口（或确认放弃该工具）

## 阶段 2：★匹配规则引擎实测（核心）

用**真实 JD** 验证 `skills/jd-match` 的判定是否符合你的意图（每类找 2-3 个真实职位）：
- [ ] **硬淘汰正确**：英语要求高 / 非武汉上海苏杭 / 薪资<35K / "35岁以下" / 非AI方向 → 确实判"弃"并给对原因
- [ ] **加分命中**：银行AI、低代码/aPaaS、AI工程化落地、甲乙方经验的 JD → 确实拉高匹配度
- [ ] **回复概率合理**：知名大厂+学历年龄卡严 → 判"回复概率低"；中小成长型+弹性措辞 → 判"高"
- [ ] **学历弹性 E1**：专业高度契合(银行AI/低代码)的中小企业即使要求本科 → 判"边界待定"而非直接弃
- [ ] **决策分流**：高分且回复概率≥中→自动greet；边界→列清单给你；硬淘汰→弃
- [ ] **可解释性**：每个职位输出的 {匹配度/回复概率/各维度理由} 是否让你信服、可据此调规则

## 阶段 3：打招呼循环（无人值守自动）

- [ ] `greet` 点"立即沟通"成功（页面证据复核，非仅执行 ok）
- [ ] per-task 授权：**首批授权一次**后，后续达标职位**自动打招呼、不再逐条弹卡**
- [ ] 打招呼后跳聊天页 → `site_navigate` 回列表 → 换装 job-search → 下一个（自动循环）
- [ ] 达数量上限即停下汇报，不越限
- [ ] 用户点"停止" → 吊销全部授权、后续不再自动打招呼

## 阶段 4：投递记录按天读写

- [ ] 每次 greet 成功后自动调 `record_application`，写入 `.za/applications/<今天>.jsonl`
- [ ] 问 agent"今天投了哪些公司" → 调 `list_applications` 汇总回答（公司/岗位/理由/决策）
- [ ] 问某历史日期 → 读对应天文件；无记录的日期 → 答"当天无记录"
- [ ] 核对落盘内容含 company/position/jdDigest/score/replyOdds/reason/decision

## 阶段 5：全通道 + 分级验证

- [ ] **client-http**：`query-jobs` 以你的会话 cookie 拉取职位清单（只读、auto 免授权）
- [ ] **server**：`salary-benchmark` 服务端直调返回薪资参考（需配 `ZA_CRED_ZHIPIN_SALARY_KEY`）
- [ ] **auto**：`resume.page-operate` 读简历免授权直接执行
- [ ] **every-call**：`formal-apply` 正式投递每次单独弹确认（即使同任务已授权 greet）
- [ ] **forbidden**：要求"帮我改简历" → `resume.modify-resume` 被服务端拒（agent 说明不代改）；
      "帮我接受这个offer" → `auto-accept-offer` 被拒
- [ ] **docs/pack_doc**：agent 需要画像/FAQ 时用 pack_doc 读 `profile.md`/`job-hunting-faq.md`

## 阶段 6：安全 / 合规

- [ ] 首批授权卡展示完整 `plan`（匹配标准+自动范围+上限），你知情批准
- [ ] 风控灰度：3 家 → 观察验证码/限流 → 再放大到 30
- [ ] 画像不落仓、记录不含敏感值（检查 `.za/applications/*.jsonl` 无 token/密码）
- [ ] agent 不虚构经历、不代做接 offer/报薪资等实质承诺

## 记录问题

发现的 bug / 规则误判 / 锚点失配，回填到对应 `feature.md`（规则）或 `facts.md`（锚点）或 `skills/jd-match/SKILL.md`（评分规则），改完重跑 `packages/assembly/test` 保装配不回归。
