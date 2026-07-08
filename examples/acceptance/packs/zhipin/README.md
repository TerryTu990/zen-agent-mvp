# zhipin —— 框架全能力标准示例 · AI 求职匹配 Agent

> 本 pack 是 zen-agent 平台的**旗舰标准示例**：一份配置制品同时承担两个目标——
> （1）覆盖框架几乎全部能力面（skills / docs / 三执行通道 / auto·hitl·forbidden·every-call 分级 / 记录能力），
> （2）落地一个真正可用的 **AI 岗位求职匹配 agent**。
>
> 本文件面向**人读**（架构自述、随 pack 存档）。运行期治理制品（feature.md / facts.md / tools.json / SKILL.md）
> 的判定权威以各自文件与 `.schema.json` 为准；本文件只讲"为什么这么搭、整体长什么样"。

---

## 1. 目标

把 `examples/acceptance/packs/zhipin/` 从"3-feature dom 骨架"升级为**两件事合一**：

1. **框架能力面的旗舰示例**——把平台的扩展点尽量铺满在一个真实场景里：三执行通道（client-dom / client-http / server）、四种分级（auto / hitl per-task / hitl every-call / forbidden）、skills 方法层、docs 渐进披露、内建记录能力。看这一个 pack 即可理解"一份配置能表达多少治理与能力"。
2. **可用的 AI 求职匹配 agent**——以**求职者视角**，用**可解释的规则化匹配**筛出"更适合我、更易获回复"的岗位，对高置信岗位自动打招呼（点"立即沟通"），并按天记录投递、可回溯复盘。

**目标用户画像（本次求职，详见 `docs/profile.md`）**：

| 维度 | 内容 |
|---|---|
| 方向 | AI 相关（AI 工程化 / 落地 / 开发） |
| 地点 | 武汉 · 上海 · 苏州 · 杭州 |
| 薪资 | ≥ 35K |
| 优势 | 金融背景 + 甲乙方经验（银行 AI 加分）、长期使用并自研低代码平台、AI 工程化落地经验丰富 |
| 约束 | 英语弱、学历专科、年龄 40 |

匹配引擎正是围绕这份画像的**优势/约束**来设计硬淘汰与加权评分的。

---

## 2. 业界设计原则（本设计的依据）

本 pack 不自创匹配范式，沿用招聘/推荐系统与 HR-tech 产品的成熟做法：

- **两段式匹配（召回 → 精排）**：Hard filter 硬约束淘汰 + Soft scoring 加权评分——招聘/推荐系统的标准架构。
- **Rule-as-data + LLM 评估**：硬约束/加分项外置为**可维护规则集**（写在 skill），LLM 按规则打分。规则显式化 = 可解释、可迭代，而非黑盒硬编码引擎。
- **Explainable matching / Scorecard**：每个岗位输出多维评分卡 + 理由（对标 SeekOut / hiretual 等 HR-tech）。
- **回复概率预估**：不止评"符不符合"，还评"投了有没有戏"（企业规模 / 措辞硬度 / 年龄学历卡点）——对应求职产品的 apply-success 预估。
- **Human-in-the-loop + Progressive autonomy**：高置信自动投、边界人工复核——先建立信任再放开自动。
- **Progressive disclosure**：画像 / FAQ 用 docs 按需注入，不常驻占用上下文窗口。
- **Guardrails / least-privilege**：不虚构、危险动作永拒（forbidden），治理沿用平台架构不变量 U7（决策服务端 fail-closed）。
- **Activity log / agent memory**：投递按天落盘、可回溯复盘。

---

## 3. 整体架构

```
平台运行时（不改）      assembly · gateway · toolgate · llm-port · audit
平台扩展（记录能力）    内建工具 record_application + list_applications
                       → 落 .za/applications/<YYYY-MM-DD>.jsonl（record-only 旁路、fail-open）
基座（不改）            assets/system-prompt.md —— 跨功能稳定前缀

zhipin pack（配置制品）
├── README.md                     ★本文件：整份设计的架构自述（供人读、随 pack 存档）
├── pack.json                     围栏 + featureId 路由（+ tenant 注释说明）
├── docs/
│   ├── profile.md                用户求职画像（数据，经 pack_doc 按需读）
│   └── job-hunting-faq.md        求职 FAQ（docs 渐进披露示范）
├── skills/
│   ├── jd-match/SKILL.md         ★匹配规则引擎（硬淘汰 + 软评分 + 回复概率 + 学历弹性）
│   ├── greeting/SKILL.md         打招呼话术方法
│   └── application-log/SKILL.md  投递记录读写方法（何时调记录工具）
└── features/
    ├── resume/                   读简历 → 同步画像（auto 只读采集）
    ├── job-search/               搜索筛选 + 匹配 + 打招呼(greet) + 记录 + 只读查询(client-http)
    └── job-detail/               完整 JD 匹配评估 + 打招呼 + 记录 + 薪资参考(server)
```

**三层职责分离**（治理不可被对话内容改变）：

- **规则（守）** 写在各 feature 的 `feature.md`（编号 `ZA-FEAT-NN`）——什么可做、什么必拒、匹配与记录的红线。
- **方法（用）** 写在 `skills/<fn>/SKILL.md`——怎么做：步骤、话术、可照抄示例；**不写规则条款**（规则归 feature.md）。
- **事实** 写在各 feature 的 `facts.md`——真实 DOM / URL；未经真实登录态核验的一律 `⚠待核` 占位，不臆造。

平台**装配引擎**按当前页面命中的 `featureId` 运行时装配：稳定基座 + 该功能的规则/事实/工具面 + 相关 skill，一并注入 agent 上下文。装配对 agent 透明。

---

## 4. 匹配核心：规则引擎（重点）

规则集写入 `skills/jd-match/SKILL.md`（"用"面的方法/规则表），LLM 按此逐个评估 JD；画像取自 `docs/profile.md`；红线（守）在 `feature.md`。三段式：

### 4.1 硬淘汰（Hard filter，任一命中即弃，一句话说明原因）

| 编号 | 条件 |
|---|---|
| H1 | 英语要求高（工作语言 / 流利 / 硬性 CET-6 等） |
| H2 | 地点 ∉ {武汉, 上海, 苏州, 杭州}（要求其他城市坐班） |
| H3 | 薪资明确 < 35K |
| H4 | 明确年龄上限 < 40（"35 岁以下"等） |
| H5 | 明显非 AI 方向 |
| H6 | 学历硬卡本科及以上 **且** 措辞强硬 / 正式大厂无弹性（可被 E1 弹性降级） |

### 4.2 软评分（Scorecard 加权：匹配度 + 回复概率）

**加分项**（匹配度）：

- S1 金融 / 银行 + AI（银行 AI / 金融科技）→ 高加分
- S2 低代码 / 无代码 / aPaaS 需求 → 高加分
- S3 AI 工程化 / 落地 / 部署（大模型落地、RAG、Agent 工程化）→ 高加分
- S4 甲乙方 / 交付 / 项目经验 → 加分

**回复概率调节**：

- R1 知名大厂 + 学历/年龄卡严 → 回复概率 ↓（专科 40 在大厂门槛前劣势）
- R2 JD 措辞正式/强硬（"必须本科""硬性"）→ 回复概率 ↓
- R3 中小 / 成长型 + 弹性措辞 → 回复概率 ↑（专业强可补学历/年龄）

**学历弹性**（对应"专业特别符合时企业会降门槛"）：

- E1 若 S1–S3 强命中（专业高度契合）**且** 企业为中小/成长型 → H6 学历硬卡**降级为"边界待定"**（不直接弃）

### 4.3 输出与决策（Explainable + Progressive autonomy）

每个 JD → `{ 匹配度分, 回复概率档(高/中/低), 各维度理由, 决策 }`：

- **匹配度高 ∧ 回复概率 ≥ 中** → **自动打招呼**（greet，沿用无人值守）
- **匹配度中 / 回复概率低但有弹性（E1 / R3）** → **列入边界清单交用户定**
- **硬淘汰** → 弃，一句话说明原因

每次打招呼成功后调内建 `record_application` 落盘（company / position / jdDigest / score / replyOdds / reason / decision）。

---

## 5. 全通道工具设计（覆盖框架能力面）

一张表看全本 pack 铺开的执行通道与分级。工具 id 在 feature.md / facts.md / tools.json / eval / 测试之间**严格一致**。

| feature | 工具 id | 执行通道 | 分级 | 覆盖的能力点 |
|---|---|---|---|---|
| resume | `resume.page-operate` | client · dom | **auto** | 只读采集画像、免授权——演示 auto tier |
| resume | `resume.modify-resume` | client · dom | **forbidden** | 声明存在但永拒——**禁改简历**红线示范 |
| job-search | `job-search.page-operate` | client · dom | hitl（per-task 缺省） | 代填筛选 / 读列表 |
| job-search | `job-search.greet` | client · dom | hitl · **per-task** | 无人值守打招呼（首批授权后同任务自动放行） |
| job-search | `job-search.query-jobs` | **client · http** | auto | 只读查职位——http 代执行通道；urlTemplate 相对路径 `⚠待核` |
| job-detail | `job-detail.page-operate` | client · dom | hitl | 代操作 JD 页 |
| job-detail | `job-detail.greet` | client · dom | hitl · per-task | 打招呼 |
| job-detail | `job-detail.salary-benchmark` | **server** + credentialRef | auto | 行业薪资参考——server 直调 + 凭证运行时注入；绝对 URL `⚠待核` |
| job-detail | `job-detail.formal-apply` | client · dom | hitl · **every-call** | 正式投递**逐条确认**（对外不可撤回、不复用授权） |
| job-detail | `job-detail.auto-accept-offer` | client · dom | **forbidden** | 声明存在但永拒——**禁自动接 offer**红线示范 |
| 平台内建 | `record_application` / `list_applications` | 内建（gateway 提供） | record-only 旁路 | 投递写 / 读，落 `.za/applications/`（不写进 tools.json） |

**分级语义**（判定永远在服务端工具执行层 fail-closed，客户端零治理判定）：

- **auto**：直接执行（只读、无副作用面）。
- **hitl · per-task**：同任务首批确认后，后续同任务批次跨工具自动放行。
- **hitl · every-call**：对外不可撤回的动作，**次次单独挂起确认、不复用授权**（正式投递用它）。
- **forbidden**：声明存在但**永拒**——把危险动作显式登记进能力面，让"改简历 / 自动接 offer"这类越界请求撞在红线上、可被审计，而不是靠"没实现"隐性回避。

**打招呼语义**：打招呼 = 点某职位"立即沟通"按钮一次 click（系统自动发默认招呼语、对外不可撤回）。点击后通常跳转聊天页；此时用内建 `site_navigate` 回到职位列表页（沿用同一 task 标题、授权自动复用），重新 `page_snapshot` 后对下一个达标职位继续，直至达上限。

**说明性/未落地项**：

- **UI 引导（guide_highlight）** 与 **tenant 多租户**：按设计**仅注释说明**（在 feature.md / pack.json 里点到、不做实体场景）。
- **context-report 白名单快照**：框架未实现（上报被忽略）——本 pack **剔除**，并在 facts 里注明，不做假实现。

---

## 6. 记录能力（平台扩展）

投递记录是"agent memory / activity log"能力面，需要平台侧最小扩展（非纯配置）：

- **落点**：`.za/applications/<YYYY-MM-DD>.jsonl`（可写区、按天分文件），**不在 pack 内**——因为 pack 配置快照按架构不变量 U4 不可变，业务写入必须落可写区。
- **`record_application`**（gateway 注册的内建工具，非终结、record-only 旁路）：
  params = `{ company, position, jdDigest, score, replyOdds, reason, decision }`，追加写当天文件；**写失败不阻断主对话（fail-open）**；路径按日期格式化、防穿越；不写 secret。
- **`list_applications`**（params = `{ date? }`）：读某天/今天，汇总"投了哪些 + 理由"，供复盘。
- 何时调用写在 `skills/application-log/SKILL.md`：greet 成功后调 `record_application`；用户问"今天投了哪些"时调 `list_applications`。
- 两个内建工具由 gateway 直接提供，**不写进 tools.json**，但 feature.md / skill 可引用其名。
- 业务日志独立于取证审计流（符合 U6 审计 schema 独立）——**不改 audit**。

---

## 7. 待核 / 占位（诚实标注，不臆造）

本 pack 在无真实登录态时交付，凡未经核验的真实世界事实一律显式占位，等 e2e 阶段回填：

| 项 | 现状 | 回填时机 |
|---|---|---|
| 真实 zhipin URL / DOM 锚点 | `facts.md` 保留 `⚠待核` | e2e：真实登录态下采集 DOM/URL |
| `job-search.query-jobs` 真实职位接口 | urlTemplate 相对路径 `/api/...` 占位、标 `⚠待核` | 抓到真实只读接口后回填 |
| `job-detail.salary-benchmark` 第三方 API + 凭证 | 绝对 URL `https://...` 占位、凭证走 `credentialRef`（`ZA_CRED_*` 运行时注入，制品**不写真值**） | 接入真实薪资 API 后回填 |
| `docs/profile.md` 细节 | 放结构化画像骨架（含 §1 画像） | 用户后续补充真实细节 |

> 占位一律 `⚠待核`，凭证一律运行时注入不写值（平台零特权、不存用户凭证）——这本身就是"Guardrails / 不虚构"原则在制品层的体现。

---

## 8. 验证

- **平台侧（自动化）**：assembly 装配测试（featureId 路由 / 工具面含新工具 / skills · docs 注入 / forbidden 注入但拒 / server · http 工具定义合法）、gateway 记录工具单测（写读 `.za/applications` 往返、fail-open、路径防穿越）、`pnpm -r build`（严格 tsc）+ 命中包 vitest + lint:deps 全绿。
- **e2e（真实登录态下人工执行）**：① 采集 DOM/URL 填 facts；② 匹配规则实测（真实 JD 验证硬淘汰/软评分/学历弹性判定合理）；③ 打招呼循环（greet → 跳聊天页 → `site_navigate` 回列表续作）；④ 记录读写（record / list_applications 按天）；⑤ 全通道（http 查职位 / server 薪资 / every-call 正式投递 / forbidden 被拒）。
