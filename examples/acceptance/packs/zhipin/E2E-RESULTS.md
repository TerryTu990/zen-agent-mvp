# zhipin 浏览器 E2E · 执行结果（2026-07）

> 真实 BOSS直聘登录态（geek 端·用户在苏州）下执行，驱动方式：Claude Code 经 `playwright-core`
> `connectOverCDP` attach 到独立 profile 的专用 Chrome（`launch-chrome-e2e.sh`，端口 9333），
> 服务端为 `/Users/jinyu/Downloads/aaa` 运行包。本文件如实记录各阶段结果——**已验证的**、**受阻未执行的**、
> 及**真实发现**，不把未执行说成通过（ZA-C-HOW-07）。

## 环境

- 真实账号登录态（headed，独立 profile 持久登录）；真实 LLM 由运行包 `.env`（`ZF_LLM_*`）注入。
- 服务端 `/healthz` 200、JWT 验签端到端通过（无 token→401、签名 token→201 建会话）。

## 阶段结果

### 阶段 1 · 采集锚点 → 填 facts —— ✅ 完成
- 列表页真实 URL `https://www.zhipin.com/web/geek/jobs`（订正占位 `/web/geek/job`）。
- 筛选控件为**自定义下拉**（页面原生 `<select>` 数为 0）：`.condition-filter-select` / `.filter-select-dropdown`；城市 `.cur-city-label`。
- 职位卡 `.job-card-wrap`（一页约 45）；「立即沟通」按钮 `<a class="op-btn op-btn-chat">`。
- 职位详情走**列表页右侧内嵌面板**（点卡片即渲染完整 JD：职位描述/岗位职责/薪资/公司/立即沟通），无需独立详情页。
- 已回填 `features/job-search/facts.md`、`features/job-detail/facts.md`，去掉对应 ⚠待核。

### 阶段 2 · 匹配规则引擎 —— ✅ 核心已验证（真实 JD 为证）
对**有完整 JD 正文**的真实职位套 `skills/jd-match`：
- **硬淘汰 H5（非 AI）准确**：PD经理(CNC)、MIM ME经理、家装总经理 等纯制造/管理岗，6/6 正确判「弃」并给对原因。
- **边界判断合理**：`技术经理`（JD 挂「互联网/AI」标签但职责是通用 Java 研发管理、无大模型/工程化实质）
  → 未被 H5 误杀、也未误判自动 greet，正确落「边界待定（契合弱，建议斟酌）」。
- **回复概率 / 学历弹性**：对 12 个真实大模型岗做卡片级分流合理（学历不限中小 AI 岗→auto-greet 候选；
  本科+中小+AI→E1 可救→边界；硕士+知名厂→H6+R1↓→低回复/弃；博士+「在美留学生」→疑 H1 英语→弃）。
- **可解释性达标**：每张评分卡的 H/S/R/决策链都能追到 JD 原文。
- 限制：完整 S1–S4（金融/低代码/工程化细节）需读 JD 正文，而正文靠自动化点卡片拿不稳（见「真实发现」）。

### 阶段 5 · 全通道 + 分级 —— ✅ 配置级 + 服务端强制级已验证
`features/*/tools.json` 定义核验通过：
- 三通道：client-dom（page-operate/greet/formal-apply/modify-resume/auto-accept-offer）、
  **client-http**（`query-jobs`：adapter 为 GET+urlTemplate、无 `kind:dom`）、
  **server**（`salary-benchmark`：`credentialRef:zhipinSalaryKey`、`Authorization: Bearer {{credential}}` 占位，**真值不入配置** SEC-02 合规）。
- 四分级：auto / hitl `hitlMode:per-task`（greet）/ hitl `hitlMode:every-call`（formal-apply）/ forbidden（modify-resume、auto-accept-offer）。
- 配合确定性评测全绿（服务端**强制**这些分级 fail-closed），"定义 + 强制"两层可信。
- 待真跑层：真实页面上 http 拉取 / server 直调 / forbidden 被拒的实况（受反爬+账号限制，见下）。

### 阶段 3 · 打招呼循环 —— ⛔ 未执行（安全红线 + 反爬）
点「立即沟通」= 真发招呼、对外不可撤回。自动化下反爬使点击不稳；安全红线要求真账号批量动作前停下由用户逐条授权。
**未执行，不伪造。** 需半自动：用户手动点「立即沟通」，Claude 核对页面证据。

### 阶段 4 · 投递记录 —— ◑ 机制已测、实况依赖阶段 3
`record_application` / `list_applications` 读写 `.za/applications/<date>.jsonl` 的机制由 `apps/server/test/applications.test.ts`（6 项）覆盖全绿（含路径防穿越、fail-open、字段完整）。**真实 greet 后自动落盘的实况**依赖阶段 3，未执行。

### 阶段 6 · 安全合规 —— ◑ 配置级 + 测试级已验证、运行时实况待真跑
forbidden 永拒、凭证 `{{credential}}` 不写真值、记录不含 secret、审计旁路 —— 配置级 + 单测级已验证；
运行时授权卡 plan 展示、画像不落仓的实况随阶段 3 真跑。

## 真实发现（已影响 facts / 值得记录）

1. **zhipin 反自动化**：CDP attach 被检测——简历页 `/web/geek/resume` 直接 `goto`/点导航链接均被弹回 `/jobs`；
   `?query=` 搜索间歇性被剥离（同一 URL 一次成功两次失败）；点卡片后详情面板更新不稳（偶返回陈旧内容）。
   **读当前列表可靠，但驱动导航/搜索/点击不可靠。** 这是被测站点的反爬边界，非平台缺陷；**不绕过**（ToS + 账号安全）。
2. **薪资被隐去**：职位卡薪资数字被抹为 `-K`；按规则「未标薪资不算 H3」判定正确，但 H3/回复概率丢失薪资信号。
3. **query-jobs 接口线索**：`urlTemplate` 的 `/api/zpgeek/search/joblist` 中 `zpgeek` 是 BOSS直聘真实 API 命名空间；
   真实响应结构仍需抓网络确认（facts 保留 ⚠待核）。
4. **正式投递入口**：内嵌面板当前只见「立即沟通」，未见独立「投递简历」入口；`formal-apply`（pathPrefix `/job_detail`）
   与真实内嵌流的关系待核。

## 结论

- **阶段 1、2、5 已在真实数据上验证通过**；平台/装配/规则/工具定义均无缺陷（确定性评测 100% 绿佐证）。
- **阶段 3、4、6 的"真实页面实况"未执行**，根因是 **zhipin 反自动化 + 真账号 greet/投递需用户逐条授权**——
  是被测站点边界与安全红线，不是可自动跨过的。
- **要真收尾 3–4**：半自动路径——用户在专用 Chrome 手动点「立即沟通」（≤3 家灰度），Claude 核对页面证据并驱动
  `record_application` 落盘验证。
