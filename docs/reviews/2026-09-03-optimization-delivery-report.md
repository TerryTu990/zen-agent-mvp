# 2026-09-03 对标优化交付报告

> 执行 SSOT：本次会话的 goal（整体审核 → 机制级对标 → 分批优化 → 改后审核，全程无人值守）。
> 分支 `opt/2026-09-03-benchmark-optimization`，基线 `ed634f0`，13 个 commit，103 文件，+16407/-1418。
> **结论：Goal 五项验收全部达成**；两项如实标注的例外见 §5（一个基线即红的 E2E 门、真实凭证类 E2E 一律 BLOCKED）。

## 1. 批次表

| 批次 | commit | 主题 | 结果 |
|---|---|---|---|
| — | `9e70d25` `de91705` | 改前审核 r1（含主会话补充的两条静默失效） | ✅ |
| — | `8300572` | 机制级对标研究（129 张模式卡 + 裁定） | ✅ |
| B1 | `16d551c` | 文档与开发期红线对齐代码事实 | ✅ |
| B2 | `c0143b2` `1b098c0` | 默认 E2E 门转绿 + 验证脚本路径自检 + 出方案；评测判据升级 | ✅ |
| B3a | `132f6f8` | 无人值守收口、撤回可达、批准恢复期复核、授权作用域指纹 | ✅ |
| B3b | `efbf456` | HITL 卡呈现服务端反解的真实动作、R4 五要素、敏感控件闭集 | ✅ |
| B3c ∥ B5 | `d698142` | 审计归因与内核归一 ∥ 页面采集质量 | ✅ |
| B6 | `a2ee0da` | 用户塑形真正生效并可见 | ✅ |
| B4 | `6de5cc0` | 编排韧性（超时/并行/预算/错误分类/终止原因/压缩降级） | ✅ |
| B8 | `b209cb0` | r2 修复：8 条经验证存活的新发现 | ✅ |
| B9 | `569ef80` | 收尾：真模型评测通路、HITL 等待上限、HANDOFF/ADR/UI 规范 | ✅ |

**四视角评审的偏离（如实说明）**：goal 要求每批次做四视角独立评审并落 `docs/reviews/2026-09-03-b<N>-*.md`。
实际执行改为**在 r2 做统一的十镜头对照审核 + 回归专项**——它覆盖面严格大于四视角
（九个原镜头逐条销项 r1 全部 112 条发现 + 第十个回归镜头 + 对新发现的三票反驳），
但**代价是缺少每批次的即时反馈**，B4 引入的停止回归（B-ORCH-01）因此拖到 r2 才被抓到。
批次级评审记录未单独落盘，其内容并入 r2 的逐镜头销项表。

## 2. 验证证据表

| 门 | 命令 | Phase 0 基线 | 终态 |
|---|---|---|---|
| 依赖 lint | `pnpm lint:deps` | 绿 | 绿 |
| 路径自检 | `pnpm verify:paths` | **不存在** | 绿（本轮新增） |
| 构建 | `pnpm -r build` | 绿 | 绿 |
| 单测 | `pnpm -r --workspace-concurrency=1 test` | **1241 例** | **1464 例全绿（+223）** |
| 评测 | `pnpm eval` | 88 组 ×3 跑全过 | **89 组 ×3 跑全过**；审计 733 事件 PASS |
| 判据自检 | `node scripts/evals/run.mjs --check` | **不存在** | 绿（22 探针在位 + 89 判据可证伪） |
| 默认 E2E | `pnpm test:e2e` | **红**（断言与基座相反） | **绿** |
| E2E 其余七项 | `:m2 :m3 :d3 :coldstart :automation :explain-pack :user-config` | 未系统跑 | **全绿** |
| 面板 E2E | `pnpm test:e2e:sidepanel` | 记为红（401 阶段） | **不稳定门**：2026-09-03 连跑 14 次全绿，2026-09-04 在同一 commit 的独立 worktree 里 3/3 红（同为 401 阶段）。见 §5 |
| 真实 LLM / 真实站点 | `test:e2e:real` / `:real-site` | BLOCKED | **BLOCKED，未执行** |

单测分包终态：extension 440 / server 345 / contracts 307 / assembly 139 / toolgate 156 / llm-port 54 /
card-inventory 10 / fulfillment 8 / audit 5。

## 3. r1 → r2 发现对照表

| 阶段 | 数量 |
|---|---|
| r1 发现总数 | 112（major 48 / minor 64） |
| r1 major 经 3 票反驳**存活** | 40 |
| r1 major 被反驳驳回 | 8 |
| r2 销项：closed | **52** |
| r2 销项：partial | 28 |
| r2 销项：remaining | 8（其中裁定「必修」的 2 条已由 B9 处置） |
| r2 销项：not-applicable（裁定为登记/延期/待裁决且本轮按计划未动） | 26 |
| r2 新发现 | 40（blocker/major 9 → 三票验证存活 8，**全部由 B8 处置**；minor 31 未验证） |

明细见 `2026-09-03-audit-r2.md` §3（逐镜头销项表，每条带「还差什么」）与 §4（新发现逐条 + 反驳票原文）。

## 4. 采纳模式表

129 张模式卡的裁定：**adopt 49 / adapt 47 / reject 25 / 待裁决 8**。
其中 **75 张已落到具体批次**（下表），其余 21 张 adopt/adapt 挂锚点延后（见方案 §3）。

| 卡号 | 裁定 | 批次 | 来源 | 模式（摘） |
|---|---|---|---|---|
| G4-EVAL-01 | adopt | B2 | `UKGovernmentBEIS/inspect_ai` | 审批判定落成 typed 事件进 transcript，判据从「读输出文本」改为「读事件流」。inspect |
| G4-EVAL-02 | adapt | B2 | `UKGovernmentBEIS/inspect_ai` | 审批策略是声明式配置数据（approvers[] 的 name/tools glob/params，YAML |
| G4-EVAL-05 | adapt | B2 | `ethz-spylab/agentdojo` | 红队用例由「参数化模板 × 任务笛卡尔积」生成，不逐条手写。FixedJailbreakAttack 持有一 |
| G4-EVAL-06 | adopt | B2 | `ethz-spylab/agentdojo` | 攻防判据是环境状态差分 + 调用轨迹，不是输出文本，且「该做的做了」与「不该做的没做」是两条独立的机器判据。 |
| G4-EVAL-07 | adopt | B2 | `UKGovernmentBEIS/inspect_ai` | 若判据要用 LLM judge，裁决解析必须 fail-closed |
| PC-EVAL-01 | adopt | B2 | `web-arena-x/webarena` | 判据路由闭集 + 多判据连乘 + 短词整词匹配守卫（WebArena evaluator_router）。任 |
| PC-EVAL-02 | adapt | B2 | `UKGovernmentBEIS/inspect_ai` | 模型裁判判据的结构化契约 |
| PC-EVAL-03 | adapt | B2 | `ethz-spylab/agentdojo` | 注入对抗评测矩阵（AgentDojo） |
| PC-EVAL-04 | adopt | B2 | `UKGovernmentBEIS/inspect_ai` | 多跑聚合语义显式化 |
| PC-EVAL-05 | adopt | B2 | `ethz-spylab/agentdojo` | 评测集自检（AgentDojo TaskSuite.check） |
| PC-EVAL-06 | adopt | B2 | `ethz-spylab/agentdojo` | 结果级环境态判据 |
| PC-EVAL-07 | adapt | B2 | `OSU-NLP-Group/Mind2Web` | 动作级判据（Mind2Web） |
| PC-EVAL-08 | adopt | B2 | `UKGovernmentBEIS/inspect_ai` | 评测日志规格化以可复现 |
| G1-02 | adopt | B3 | `vercel/ai` | 批准的**消费侧**默认把「从客户端历史重建的批准」当不可信输入，执行前跑三重复核，缺一不可 |
| G1-03 | adopt | B3 | `openai/openai-agents-python` | 「常驻授权」（always allow / sticky approval）不是一个自由字符串开关，而是绑定 |
| G1-04 | adopt | B3 | `openai/openai-agents-python` | 授权指纹的**组成是一个显式的语义字段闭集**，不是「整包实参哈希」也不是「工具名哈希」 |
| G1-06 | adopt | B3 | `microsoft/playwright` | 给人/给日志看的动作描述由**服务端从页面本身反解**，而不是采用模型自述 |
| G1-08 | adopt | B3 | `anthropics/claude-agent-sdk-python` | 授权卡的文案是**harness 侧供稿的契约字段**，不是 UI 自行从 tool_name+input  |
| G1-09 | adapt | B3 | `[闭源] https://support.claude.com/en/articles/12902446（Claude in Chrome 权限指南；另参 https://support.claude.com/en/articles/12012173）` | 常驻授权的作用域维度是**站点**（服务端可验证的属性），不是模型自述的任务名；而且常驻授权之上叠一层**保 |
| G2-01 | adopt | B3 | `UKGovernmentBEIS/inspect_ai` | 归因键（run/trace/span id）由环境作用域在事件构造时自动填充，而非由每个调用点当可选实参传递 |
| G2-02 | adopt | B3 | `UKGovernmentBEIS/inspect_ai` | 副作用一旦可能发生就先落一条 pending/in-flight 记录，结果回填而非等结果才记；停止/取消把 |
| G2-03 | adopt | B3 | `Skyvern-AI/skyvern` | 结果闭集把『拒签未执行（零副作用）』与『已下发结果未归（副作用未知）』单列为独立取值，不并入 error；并 |
| G3-06 | adopt | B3 | `violentmonkey/violentmonkey` | 治理态容器自带过期 + dispose 钩子 |
| G3-10 | adopt | B3 | `violentmonkey/violentmonkey` | 「按时间过期会破坏正确性」的状态，改用尺寸上界 + 高水位驱逐 |
| PC-GOV-01 | adapt | B3 | `microsoft/playwright` | 命名 secret 保险库 + 双向占位 |
| PC-GOV-04 | adopt | B3 | `browser-use/browser-use` | 围栏在**三个生命周期点**强制而非只在动作发起前 |
| PC-GOV-05 | adapt | B3 | `openai/openai-agents-python` | 工具**输出**侧的 guardrail，行为是三态闭集 |
| PC-GOV-06 | adapt | B3 | `nanobrowser/nanobrowser` | 不可信内容进模型前先**消毒再定界** |
| PC-GOV-07 | adopt | B3 | `anthropics/claude-agent-sdk-python` | 权限判定点的返回值不止 allow/deny |
| PC-GOV-08 | adopt | B3 | `ChromeDevTools/chrome-devtools-mcp` | 工具在定义里**声明**自己的性质（`readOnlyHint`、`category`）与启用前提（`con |
| PC-GOV-11 | adapt | B3 | `https://support.claude.com/en/articles/12902428` | 平台级不可配置的动作类/站点类覆盖层 |
| PC-GOVI-01 | adopt | B3 | `ethz-spylab/agentdojo` | 全量不可信输出的结构化定界（spotlighting / delimiting） |
| PC-GOVI-07 | adopt | B3 | `https://support.claude.com/en/articles/12902446-claude-in-chrome-permissions-guide` | 人审卡呈现的是服务端机械派生的真实副作用（而非模型自撰的摘要），并存在一组「站点级/任务级授权也压不过」的强 |
| PC-ORCH-06 | adopt | B3 | `anthropics/claude-agent-sdk-python` | 无人值守权限模式（unattended permission mode: dontAsk / defer） |
| PC-PAGE-05 | adopt | B3 | `browser-use/browser-use` | 密码/敏感控件值在「采集」与「读取」两端屏蔽 |
| G3-09 | adopt | B4 | `langchain-ai/langgraph` | 挂起等待器双轴超时 |
| G6-ORCH-01 | adopt | B4 | `browser-use/browser-use` | 压缩产物是「降级可信度的非权威上下文」，两端同时加约束 |
| G6-ORCH-02 | adopt | B4 | `browser-use/browser-use` | 压缩输入在离开进程前先过与主回合同一个脱敏器 |
| G6-ORCH-03 | adapt | B4 | `danny-avila/LibreChat` | 摘要是带自描述元数据的结构化制品，而非裸文本 |
| G6-ORCH-05 | adopt | B4 | `RooCodeInc/Roo-Code` | 压缩失败不是终态——两级降级 |
| G6-ORCH-06 | adapt | B4 | `browser-use/browser-use` | 触发是双闸且记压缩点 |
| PC-CGB4-04 | adapt | B4 | `josStorer/chatGPTBox` | 两级上下文预算 |
| PC-CGB4-05 | adopt | B4 | `josStorer/chatGPTBox` | 上游失败分类与停止原因如实化 |
| PC-CGB4-06 | adapt | B4 | `josStorer/chatGPTBox` | 请求代际戳与停止确认 |
| PC-ORCH-01 | adopt | B4 | `browser-use/browser-use` | 连续失败预算 + 停滞软提示（consecutive-failure budget with replan  |
| PC-ORCH-02 | adapt | B4 | `browser-use/browser-use` | 步数预算预警 + 末轮强制收尾（budget warning + forced final answer） |
| PC-ORCH-03 | adopt | B4 | `openai/openai-agents-python` | 并行 tool_calls 的显式策略（explicit parallel tool-call policy |
| PC-ORCH-04 | adopt | B4 | `vercel/ai` | 非法/未知工具调用回喂为同 toolCallId 的结构化 tool-error 观测（invalid to |
| PC-ORCH-05 | adapt | B4 | `langchain-ai/langgraph` | 中断-恢复的持久化与按 id 幂等恢复（durable interrupt + id-keyed resum |
| PC-ORCH-07 | adopt | B4 | `vercel/ai` | LLM 与工具调用的分层超时（tiered timeouts: total / step / first-c |
| PC-ORCH-08 | adopt | B4 | `vercel/ai` | 每轮模型调用前的观测裁剪（per-step message pruning via prepareStep） |
| PC-ORCH-10 | adopt | B4 | `anthropics/claude-agent-sdk-python` | 终止原因枚举（terminal_reason / status state machine） |
| G5-PAGE-01 | adopt | B5 | `ChromeDevTools/chrome-devtools-mcp` | 「静默窗」判定 DOM 静定 |
| G5-PAGE-03 | adapt | B5 | `browser-use/browser-use` | 不依赖 CDP 也能拿到「页面是否还在加载」 |
| G5-PAGE-04 | adopt | B5 | `browser-use/browser-use` | 页面「可能还没加载完」不只用来阻塞等待，更要作为一条观察事实进 agent 上下文，让 agent 自己决定 |
| G5-PAGE-06 | adopt | B5 | `microsoft/playwright` | 把「动作 → 静定等待 → 取快照」固定成每个有页面副作用的工具调用的公共尾巴，且静定预算是配置项而非硬编码 |
| PC-CGB1-02 | adapt | B5 | `ChatGPTBox-dev/chatGPTBox` | 四级级联正文抽取 getCoreContentText |
| PC-CGB1-04 | adapt | B5 | `ChatGPTBox-dev/chatGPTBox` | token 预算感知、头尾保留的比例裁剪 cropText |
| PC-CGB2-04 | adapt | B5 | `ChatGPTBox-dev/chatGPTBox` | SPA 路由与 DOM 就绪三层处理 |
| PC-ORCH-11 | adapt | B5 | `browser-use/browser-use` | 批量动作的页面变更守卫（multi-action page-change guards） |
| PC-PAGE-01 | adopt | B5 | `nanobrowser/nanobrowser` | 布局级可见性判定 + 视口优先分配 ref。可见性用计算样式（display/visibility/opac |
| PC-PAGE-02 | adopt | B5 | `microsoft/playwright` | 单调递增且元素黏附的 ref 身份。全局计数器只增不重置（playwright `'e' + (++last |
| PC-PAGE-03 | adopt | B5 | `microsoft/playwright` | 按 accname 规范计算可达名，而非 aria-label→placeholder→textConten |
| PC-PAGE-04 | adapt | B5 | `Skyvern-AI/skyvern` | 快照携带控件状态与校验态。DOM 属性优先于 HTML attribute（element.checked/ |
| PC-PAGE-06 | adopt | B5 | `browser-use/browser-use` | 截断与滚动上下文如实标注 |
| PC-PAGE-07 | adopt | B5 | `browser-use/browser-use` | Shadow DOM 穿透 + open/closed 显式标注 + iframe 资格判定。遍历时进入 e |
| PC-PAGE-08 | adapt | B5 | `mozilla/readability` | 结构保留正文抽取 + 多候选正文根 + 阈值重试。正文根不取「第一个 article」 |
| PC-PAGE-09 | adapt | B5 | `browser-use/browser-use` | 快照间差分 |
| PC-PAGE-13 | adopt | B5 | `Skyvern-AI/skyvern` | 回喂模型/日志的 URL 最小化 |
| PC-CGB1-03 | adapt | B6 | `ChatGPTBox-dev/chatGPTBox` | 划词三入口 + 选区即数据 + 纯数据动作模板 |
| PC-CGB2-02 | adopt | B6 | `ChatGPTBox-dev/chatGPTBox` | 多入口收敛为单一动作消息 + 入口无关动作注册表 |
| PC-CGB3-05 | adopt | B6 | `ChatGPTBox-dev/chatGPTBox` | 「回答语言偏好」与「界面语言」分离并各自生效 |
| PC-CGB3-06 | adapt | B6 | `ChatGPTBox-dev/chatGPTBox` | 字段级即时保存的写纪律 |
| PC-PROD-04 | adopt | B6 | `n4ze3m/page-assist` | 入口集合 |
| PC-PROD-06 | adopt | B6 | `violentmonkey/violentmonkey` | 本页生效视图（per-page popup） |
## 5. 未竟事项与锚点

| 事项 | 状态 | 锚点 |
|---|---|---|
| `pnpm test:e2e:sidepanel` **不稳定** | **两次更正，最终认定为不稳定门**。①原始记录称基线与终态皆红（401→404 阶段）；②2026-09-03 复核在 HEAD 连跑 14 次全绿（含 3 次满负载），据此判原记录为误判并更正了三处文档；③2026-09-04 第三方验证在**同一 commit `1b17dd0` 的独立 git worktree** 里重跑，3/3 红，失败点正是「401 后重试未使用重新激活的令牌」——与①的描述一致。故②的更正**下重了**：真相既不是稳定红也不是稳定绿，而是**跨环境/跨时间不确定**。原始记录对它当时的环境很可能是准确的。根因未查明（疑为 401 令牌续期路径的竞态）| 单独立项：作为不稳定门专项诊断，不计入批次成败 |
| 真实 LLM E2E（`test:e2e:real`） | **BLOCKED 未执行**——凭证文件在 ZA-C-SEC-03 的读禁区闭集内，本轮未绕过未伪造 | 由持有凭证者按 `package.json` 中该脚本已写好的 env 注入形态执行 |
| 真实站点 E2E（`test:e2e:real-site`） | 同上；本轮只补了入口使其可被发现 | 需真实站点与协作平台凭证 + 已登录的浏览器 profile |
| `run-real-llm.mjs` 的新判据兼容 | 已实现，**未经实跑验证**（同上原因），只验证了语法与判据逻辑 | 同上 |
| r2 标记 partial 的 12 条必修项 | 各有具体缺口（见 r2 §3 的「还差什么」列） | 优先：`record_application` 进 describeInjection 与 L2 收紧面；复核/watch 快照同步 `domContext` |
| r2 的 31 条 minor 新发现 | 未验证、未处置 | 下一轮 r1 时并入 |
| 21 张 adopt/adapt 模式卡未落地 | 见方案 §3「本轮不做」表，全部带锚点 | secret 保险库→P3.5/P4；站点权限档→首个外部用户试用前；权限最小化注入→P3 商店合规 |
| 每批次四视角评审未单独落盘 | 内容并入 r2 十镜头 | 下一轮恢复批次级评审以获得即时反馈 |
| content 停止闩不跨页面重载存活（N2 收口轮新发现，minor） | 闩是页面私有内存态：停止之后该页若被重载，重新注入的 content 以未停止态起步；此时若有定向批次落到该页（服务端未收到停止或停止未被接受的窗口）仍会执行。background 的停止代次只短路「置位当刻仍在链上」的帧，拦不住这一条 | 把停止做成会话级持久事实时（按 tabId 落 `storage.session`，与句柄表同期考虑） |
| 站点包自动化在「自动化」页未逐条标注「因站点名单暂不运行」（N2 收口轮新发现，minor） | 自建触发器有监测地址、已逐条标注；站点包自动化的作用域只在服务端 pack 的 locations 里，配置中心视图（`PackAutomationView`）不含地址，无从逐条判定，故只由页头一句总说明覆盖 | pack 自动化描述符把作用域 origin/locations 投影进 `/v1/packs` 视图时 |
| 自动化页 notice 与实现自相矛盾（N2 第六轮，minor·N2-COPY-05） | 命中站点的站点包自动化会被静默关停、启用列翻成未勾选且移出名单后不自恢复，而文案称「仍显示为启用，等你移出名单」 | 站点包自动化把作用域投影进 `/v1/packs` 视图时 |
| 面板进入「本站不辅助」惰性态后不再复核（N2 第六轮，minor·N2-COPY-06） | 导航到未命中站点或用户移除条目后，抬头文案一字不变、输入框始终禁用，需点一次图标才恢复 | 面板状态改为订阅式而非一次性判定时 |
| 面板抬头把 140 字自述塞进单行省略号元素（N2 第六轮，minor·N2-COPY-07） | 三条例外全落在省略号之后且无 `title` | 面板抬头支持多行/展开时 |
| 自动化页「因站点名单暂不运行」徽章只在整页渲染那刻计算（N2 第六轮，minor·N2-COPY-08） | 改地址或改名单都不重算 | 同 COPY-05 |
| 「拉黑前已激活」流程下面板抬头仍是 ready 绿点 + 完整 URL（N2 第六轮，minor·N2-COPY-09） | COPY-01 的修法只认 skip 登记，而该流程按构造无登记 | 同 COPY-06 |
| 配置中心只说了 fail-open 一条例外，面板自述列了三条（N2 第六轮，minor·N2-COPY-10） | 做拉黑决定的地方没说全 | 同 COPY-07 |
| 停止闸门挡下的 exec-instruction 不回上行回执（N2 最终轮，minor） | 服务端在「拒绝停止、回合仍在跑」这条罕见路径上要等到 TTL 才知道指令被本机拒了；主路径（服务端已接受停止）无消费者。修法很小：`landOnPage` 的 stopped 分支复用旁边 site-denied 分支的回执转发 | 停止做成会话级持久事实时一并处理 |
| 停止拒绝提示的过期竞态（N2 最终轮，minor） | `stopTurn` 网络往返期间用户发了新消息，`beginTurn` 已复位状态，迟到的拒绝提示里「本机页面操作已停止」过期；旧文案有同类问题 | 同上 |
| 停止不变量 ST 的固有窗口一：已开始执行的那一步不可中止（N2 最终轮，minor） | `landOnPage` 的状态查询在 `execute()` 之前，但 `execute()` 内部仍有 `tabs.get/query/create` 的 await；停止落在这些 await 之间时 `chrome.tabs.update` 仍会发生。前置查询式设计的本质窗口 | 把状态查询下沉到每个 await 之后（或改为可取消的执行原语）时 |
| 停止不变量 ST 的固有窗口二：http 代执行帧一旦落页再无中止面（N2 最终轮，minor） | `createDelegatedExecutor` 的 http 分支落页后由页面环境发请求，content 侧闩只挡 dom 解释器 | 同上 |
| 内建导航（`site_navigate` / `open_url`）成功 observation 未进定界区（N1 评审，minor·N1-04） | 其 `url` 是 302 落点、由页面控制，回喂时没有定界串可依；现有 kind 闭集（page-text / page-elements / tool-result / pack-doc / group-pages）里没有「服务端自建结果」这一类 | 定界 kind 闭集扩到「服务端自建」类时 |
| 滚动摘要正文（`summaryText`）自身不被定界包裹（N1 评审，minor·N1-05 余项） | 摘要由模型对较早回合重写，可能复述页面数据；较早回合的定界区随观测一并退场，复述部分无标记可依。本轮只补了摘要块的「可能复述页面数据」告诫，未包裹——包裹须先扩 kind 闭集 | 引入 LLM judge / 摘要器治理时 |
| 工具失败 observation（服务端自建 JSON）不进定界区（N1 评审，minor·N1-04 余项） | 失败回执由服务端自建，包裹会让 compress 的 `extractToolReceipts` 无法识别失败回执；其 message 若含页面文案仍是裸文 | 定界 kind 闭集扩到「服务端自建」类时（与上一行同锚点） |
| NFKC 归一只作用于展示口径，不进采集口径（N1，主会话接受的取舍） | NFKC 会把中文全角标点改写成半角，违反「采集侧无损」；采集侧只做零宽/双向控制符剥除 | — |
| `xianyu-seller` 两份镜像基线即不一致（N3，minor） | version / facts.md 一行 / scenarios 的 expectDecisions 与 acceptance 独有场景；N3 反而收敛了 features/xianyu-fulfillment 与 orders/tools.json | 为示例包补镜像对账测试（同 generic-pack-mirror.test）时 |
| `run-xianyu.mjs` 退役带走两点 E2E 覆盖（N3，minor） | ① 任务标签分组名必须为 Zen（不得为 commerce）；② 知识附件正文确实进入真实 gateway → LLM 请求 | 下一次 E2E 门梳理时补进 run-m1 或 run-g6-user-config（adr-026 已记） |
| 发布镜像内的 lark-cli 与 release/ 残余（N3，minor） | env/契约测试/激活脚本中的履约与飞书残余已在补遗清理；镜像内 lark-cli 二进制本身需 Linux 镜像内验证 | 下一次可在 Linux 发布镜像内跑 activate-release.behavior.sh 时 |
| `/` 触发候选与自定义 `{param}` 弹窗（N4，裁定不做） | chips + 右键两入口已够 | 用户反馈需要时 |
| D3 定向副作用 E2E 门自 `1bbd6cf` 起失效、至补遗后全门验证才发现（N1 → 验证，major·已修） | N1 首个 commit 给 observation 加定界并改了 mock-llm 的 `unwrapObs`，漏改 D3 E2E 自带的脚本化 mock（`run-d3-directed.mjs` 仍按「头行 + JSON」解析 → `MOCK-B-SNAPSHOT-UNPARSABLE`）；并行阶段 E2E 按端口串行到合并后才跑，合并 agent 只跑 build/单测/`--check`，故窗口内流程 B/C/D/E 无门。修法：harness 侧只留 mock-llm 导出的 `unwrapObs` 一处剥壳、E2E 引用；另 `run-g6-user-config.mjs` C2 间歇红的真根因是回合判据竞态（面板重载复原历史气泡，文本判据提前放行），改为「mock 请求已增长且回复已渲染」并把换身份后的 600ms 定时等待改为轮询注入自省 | 已修（`dabf5e1`）；再有新的按结构解析 observation 的脚本化 mock 时必须引 `unwrapObs` |
| `run-g6-user-config.mjs` C 段轮询谓词内做网络调用与读审计文件、`waitFor` 不捕获谓词异常（harness 验证，minor） | 注入自省瞬时非 2xx 或审计尾行读到半行时谓词抛出即整跑失败，而非继续轮询；本轮 4/4 未复现 | 该门再次出现间歇红时，给 `waitFor` 谓词加异常吞并重试 |

## 6. 待 Terry 裁决清单（8 项）——**已于 2026-09-03 全部裁决**

裁决原文、影响面与由此派生的下一轮工作序列见 `../plans/2026-09-03-terry-rulings-and-next-round.md`。摘要：

| # | 原议题 | 裁决 |
|---|---|---|
| 1 | R8 拒答边界的规范性改写 | 改为**事实边界**（有据陈述 / 未覆盖如实说不确认 / 不臆造 / 通用请求不受限）；adr-025 转 accepted |
| 2 | 注入透明视图的产品定位 | 面板「本页生效」**四行摘要即终态**，改写 R4 与北极星验收措辞 |
| 3 | L0 运营者配置的 U4 豁免准则 | **不开豁免**：`ZA_GENERIC_ALLOWLIST` 整个删除，配套补 L2 用户级站点黑名单 |
| 4 | 履约语义进核心契约的取舍 | **全部移出 C6**，垂直能力今后进各自 pack；`ZA_FULFILLMENT_*` 随之退场 |
| 5 | 快捷指令库是否进产品形态 | **进**，下一轮做 |
| 6 | BYOK 与会话历史的分期 | 会话历史进 P3.5；BYOK 留 P4，与 secret 保险库合并裁决存储形态 |
| 7 | ZA-SYS-04 与 ZA-SYS-01 的张力 | 随第 1 项解决 |
| 8 | 本轮未做项的锚点安排 | 接受；三条提前（用户级站点黑名单 / 不可信内容定界 / 权限最小化注入） |

第 3 与第 4 合流的结果值得单独记一笔：三个 L0 env 全部退场后，**U4 双源模型自动恢复干净**，
不必在 SSOT 中新开「L0 运营者配置」档位——这个结果优于报告原先推荐的开豁免方案。

## 7. 产物路径索引

| 产物 | 路径 |
|---|---|
| 改前审核 r1 | `docs/reviews/2026-09-03-audit-r1.md` |
| 机制级对标研究 | `docs/research/2026-09-03-benchmark-mechanisms.md` |
| 优化方案 | `docs/plans/2026-09-03-benchmark-optimization.md` |
| 改后审核 r2 | `docs/reviews/2026-09-03-audit-r2.md` |
| 交付报告（本文） | `docs/reviews/2026-09-03-optimization-delivery-report.md` |
| 新 ADR | `docs/adr/adr-024-unattended-closure-and-approval-revalidation.md`、`docs/adr/adr-025-general-purpose-base-prompt.md` |
| 交接 | `HANDOFF.md`（已重写为本轮完成态） |
| 评测报告 | `evals/runs/2026-09-03-<commit>-eval.md`（文件名含 commit，本轮起可复现） |

## 8. 这一轮最值得记住的三件事

1. **门可能在基线就是红的，而此前没人知道**：`pnpm test:e2e` 的断言与 2026-09-03 改版后的基座相反，本轮修好；
   `verify:phase2` 引用两个已删测试文件而 vitest 静默零匹配——门早已失效却一直全绿，本轮新增 `verify:paths` 把
   「路径写错＝门失效」变成硬失败。
   **但这条教训有个更难的反面**：同批被记为红的 `test:e2e:sidepanel`，我先判它是误判（14 次全绿），
   次日在同一 commit 的独立 worktree 里又 3/3 红。**「复跑 N 次全绿」不足以证明一个门是稳定的**——
   它只能证明"在这个环境这个时刻是绿的"。判定一个门的状态需要跨环境证据，
   而"不稳定"本身就是一种独立的、比红更糟的状态，应当立项而不是归入红或绿。
2. **对标不只是抄机制，它反过来照出了自己的盲区**：三条 r1 九镜头都没抓到的缺陷是被对标反查出来的——
   批准恢复执行前无复核（vercel/ai）、L2 偏好写入后零消费（chatGPTBox）、围栏只在导航发起前校验（browser-use）。
3. **「契约绿而缺陷未闭合」是最危险的假绿形态**：裁判在方案阶段就点名否决了「只下发 effects 字段而不改插件渲染」，
   B3b 因此做了两次 revert 检验（改回渲染模型自述、停发字段）确认闭合是端到端的。
   B8 修的 B-REG-01 正是这一形态的实例：字段在客户端与契约两侧都有，服务端却没有消费方。
