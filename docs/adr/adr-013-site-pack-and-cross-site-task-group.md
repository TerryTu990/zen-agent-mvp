# adr-013: 站点包（site pack）= 可分发子 agent + 跨站点任务组升级路径 + 会话上下文管理

## 状态

提议（2026-07-05 初稿；同日 v2 按评审意见修订 location 匹配/迁移/实改面/参照；v3 并入会话上下文管理 P0-P2；v4 任务组由挂锚点改为正式排期；07-06 v5 定死批次④验收案例（codeflow × mail.126.com）并补外发独立确认/iframe spike；v6 会话模型改显式发起（点图标建组、同源多组独立、取代 adr-012 组键=origin）并修正敏感值数据流的治理分层归属；v7 补 pack docs/ 渐进披露（pack_doc 内建工具）、P1 压缩配置（窗口+阈值 0.6）、P2 定 1 小时 TTL 最轻量形态；v8 批次④验收行的"令牌全程引用传递"系 v5 残留、修正为 §5 v6 口径（MVP 经模型上下文+审计脱敏），并细化 dom 工具身份口径（无 claims 注入面、只要求平台 JWT），待 Terry 复审）

## 背景

现快照是单宿主假定：`manifest.json` 的 `featureIdRules` 只按 URL 正则匹配、无 origin 维度；skills 快照全局注入（所有 SKILL.md 进每轮上下文）；featureId/toolId 是全局命名空间。要接入第二个站点（如 https://codeflow.asia/ ）即暴露三个缺口：① 配置无法以站点为单位打包分发与独立版本化；② A 站 skills/规则会注入 B 站会话（跨站干扰）；③ 存在一个业务跨多个系统操作的真实场景，而 adr-012 组键=origin 使切 origin 即换会话，任务上下文断裂；④ 会话上下文无治理：快照观测（≤150 元素 JSON）全量滞留历史逐轮累积、历史无压缩无持久化——服务重启丢任务、长业务必溢出（三轮浏览器 E2E 实证）。宗旨自证：站点包让注入面精确对齐用户所在系统（准确性），任务组让跨系统业务不断链，上下文管理让长任务不溢出、不误导、不因重启从头再来。

## 决策

### 1. pack 目录形态（站点 = 分发单元，布局同构于现快照子树，U4）

```
packs/<packId>/
├── pack.json            # {packId, version(semver), site:{origin, locations?}, featureIdRules, features[]}
├── features/<id>/{feature.md, facts.md, tools.json}
├── skills/<fn>/SKILL.md
├── docs/                # 站点操作文档/说明书（大体量参考资料，按需读取不全量注入）
└── eval/                # 该站点评测素材同包（ZA-EVAL 素材同仓：pack 分发到哪，评测跟到哪）
```

- 激活键 = `site.origin`（精确匹配）+ `site.locations`（路径前缀数组，缺省 `["/"]` 即整站）：同 origin 多 pack 按**最长前缀胜出**——nginx location 前缀语义的最小子集，不取正则/修饰符/通配符域名（锚点：真实宿主出现该需求时评估）。同 origin 前缀重复 → 载入期 fail-closed 拒载。`featureIdRules` 降为 pack 内规则，仅在 pack 激活后参与匹配。
- skills 从快照全局收敛为 **pack 作用域**：只随所属 pack 激活注入。
- featureId/toolId 命名空间 = `<packId>` 限定（审计与端口以 `{packId, featureId}` 二元组定位），跨 pack 不冲突。
- `system-prompt.md` 仍是平台级跨站稳定基座（prompt 缓存前缀），不进 pack。
- `docs/` 渐进披露（skills=可执行流程·小而全量注入；docs=参考资料·大而按需取，参照 Claude Code skill 资源文件模式）：pack 激活时仅注入文档索引（每篇 frontmatter 标题+一句摘要）；agent 经平台内建 `pack_doc` 工具按需读取正文——服务端执行、只可读当前激活 pack 的 docs/（fail-closed）、单次读取截断上限。全文检索/RAG 挂锚点：单 pack 文档量超出索引可用性时评估。

### 2. 安装与发现

全局 registry（现根 manifest.json 升级）：`{version, packs:[{packId, version}]}`。安装 = pack 目录入 `packs/` + registry 登记（MVP 即 git 操作；标准版=配置中心按 pack 发布）。装配引擎启动全量载入并逐 pack fail-closed 校验（拒载语义沿用现 loadSnapshot）。

### 3. 激活与隔离

- `resolveFeature(url)` 升为两级：origin 精确匹配 + 最长 location 前缀 → 唯一 pack；pack 内 featureIdRules → featureId。无 pack 命中 → 仅装稳定基座（现 fail-safe 语义不变）。判定权威在服务端，对话内容不可改变（装配透明）。
- **换出即卸载**：逐回合全量重组（system 注入整段重建 + 工具白名单重投影）已天然保证切站点后上一 pack 的规则/skills/工具不再出现——无需显式"卸载"动作。还缺的四件才是本 ADR 的实改面：skills 收敛 pack 作用域（现为全局注入）；命名空间限定；审计事件补 `{packId, packVersion}`；评测 runner 按 pack 发现 `eval/`（现写死单配置目录，不改则 §4"改 pack 必跑评测"落空）。
- 对话历史残留：会话=显式组（§5），组内切站点或 location 切 pack 时共享历史属预期（任务连续性正是目的），回合注入边界标记（"以下对话发生在 X 系统"）防历史误导；组外页面不挂面板、不共享任何历史。

### 4. 版本与失效

pack 独立 semver；发布后不可变，改配置=发新版本（U4）；会话进行中升级 → 下一回合重组自然生效，回滚=registry 改回旧版本号。卸载=registry 去登记，该站点回落"仅基座"。改 pack 必跑该 pack 的 eval/（ZA-EVAL）。存量迁移：未 pack 化的现有快照按缺省 `packId=default` 载入，工具/审计引用不破坏——新旧并存，全部迁完后移除缺省。

### 5. 显式会话组（取代 adr-012 组键=origin；任务组=组本身）

会话 = 用户显式创建的标签组实例（参照 claude-in-chrome：一对话一标签组），跨站任务不再是特殊升级——组天然可容纳多站点页面。

- **显式发起**：打开网页不注入面板、不建会话；用户点击插件图标 → 当前 tab 挂面板 + 新建会话 + 包进新 zen 标签组。同 origin 多组各自独立（3 个 codeflow tab 各点图标 = 3 个互不相干的会话）。
- **组的扩张**：agent 经签发 navigate 指令新开页自动入组（navigate 自 ②-b 锚点在批次④启用，受 pack 围栏约束）；用户手动拖 tab 入组 → 挂面板、接入同一会话。关组=关会话。
- **机制复用**：一组一会话、单桥单 SSE、活跃页路由、user-echo 镜像（adr-012 全部保留）；仅组员资格从"同 origin 自动并入"改为"显式创建+显式加入"。装配每回合按活跃成员页 URL 激活对应 pack。
- **装配随活跃页换 pack**：每回合按活跃页 URL 激活对应 pack——逐回合重组天然支持，装配引擎零新机制；组内切站时注入边界标记（"以下对话发生在 X 站点"）防历史误导。
- **多宿主身份**：C2 claims 契约不变（单对象），会话状态从单 claims 升为 per-origin 映射；toolgate 按目标工具所属 pack 的 origin 取 claims，http/server 工具缺失/过期即 fail-closed 拒绝并驱动该站点身份获取（U7）。dom 工具在用户自己的页面会话内执行、无 claims 注入面，只要求平台 JWT 有效、不要求该 origin 宿主 claims（纯 dom 站点无需宿主身份签发体系）。
- **工具围栏随站点生效**：签发校验补 origin 维度——目标 URL 的 origin+path 必须落在签发工具所属 pack 的 `site` 围栏内（dom `pathPrefixes` 由 pack.site.origin 补齐为绝对围栏；http adapter 相对模板同理锚定）。exec-instruction 仍只发活跃页，目标 origin ≠ 活跃页 origin 时不签发。
- **敏感值数据流**：运行期 agent 不受开发期红线约束（治理分层），用户明确指示的敏感值流转（如把自己的令牌写进邮件）是合法产品数据流，MVP 允许其经过模型上下文；审计落盘仍按 C5 对已知敏感值脱敏。引用传递机制（占位符 + toolgate 执行层代真值，敏感值不进模型上下文）挂锚点：接入合规敏感宿主时启用。
- **对外发送类动作独立确认**：邮件/消息发送等不可撤回外发步骤以独立 hitl 工具建模，不并入 page-operate 的任务级放行；授权卡计划中明示"发送前单独确认"。

### 6. 会话上下文管理（P0-P2，pack 与任务组可用的地基）

- **P0 旧观测瘦身**：LLM 调用前，历史中仅保留最近一次 page_snapshot 观测全文，更早的快照观测替换为一行存根（`[快照已过期：N 元素，refs 失效]`）——旧 ref 本随重采集失效，属废数据，留存只烧 token 并诱导误引用。替换只发生在用户回合边界，回合内保持追加以护 prompt 缓存前缀。
- **P1 历史压缩**：触发配置随 LLM 连接参数——`ZA_LLM_CONTEXT_WINDOW`（最大上下文窗口，如 200000/1000000）+ `ZA_LLM_COMPRESS_THRESHOLD`（默认 0.6），估算 token（优先 provider 返回的 usage 实数，缺省按字符近似）达窗口×阈值即压缩：较早回合压为滚动摘要（业务目标/已完成步骤/关键结论），最近 K 轮保留原文；任务级授权的 task 标题与计划作为结构化状态保留在摘要器之外（授权语义不得被摘要糊掉）；治理注入每轮全量重建、结构上不参与摘要；§3/§5 的站点边界标记在摘要中保留。**任务组（§5）实施前 P1 必须就位。**
- **P2 会话持久化**（最轻量形态）：会话历史+压缩状态落盘（`.za/sessions/<id>.jsonl` 形态），服务重启可恢复；仅保留 1 小时（闲置 TTL，env 可调），到期清理，不做归档与历史查询；与审计流严格分离（审计是 record-only 旁路，会话存储是运行态）；存储故障不拖死会话（fail-open，沿审计旁路语义）。
- 跨会话记忆不进本 ADR：站点操作知识的长期载体是 pack 的 facts（版本化+评测把关，见 §1/分期）；用户级记忆（偏好/业务上下文）挂锚点 **ADR-014**——须先设计"记忆是数据不是指令、用户可见可删、写入脱敏与审计、存储故障 fail-open"的防线，防对话内容经记忆持久化改变后续会话行为（记忆投毒）。

## 理由

- pack 布局 = 现快照子树 + pack.json，registry 是"快照的快照"——消费端（assembly）仍读同构布局，标准版配置中心的发布产出物即 pack（U4 升级=换生产端不换消费端）。
- 隔离不靠新增"卸载机制"，靠已有的逐回合全量重组 + adr-012 会话按 origin 分组——结构性成立，只补 skills 作用域这一处真实缺口。
- 任务组方案把新增面收敛到两点（per-origin claims 映射、围栏带 origin），SSE/路由/装配全部复用既有机制；契约不分叉（U5：任务组封装在插件形态内，服务端只见会话与 URL）。
- 业界参照：按 URL 激活的可分发行为包 = Chrome 扩展 `matches` / Tampermonkey `@match` / VS Code `activationEvents` / Home Assistant 集成目录；最长前缀匹配 = nginx location 前缀语义；包分发与登记 = Claude Code 插件（plugin.json + marketplace）；跨站任务组 = claude-in-chrome 一对话一跨域标签组；per-origin 身份 = Playwright browser context 按 origin 持登录态。
- 上下文管理参照：旧观测清理 = Anthropic context editing（官方特性，自动清过期 tool results）/ OpenHands·SWE-agent 观测省略；滚动摘要 = Claude Code auto-compaction / LangGraph summarization / MemGPT 分页记忆；会话持久化 = LangGraph checkpointer / OpenAI Assistants thread。本项目"治理每轮全量重建"使压缩天然只作用于对话、永远压不到规则——比通用框架做压缩更干净。

## 被否方案

- **多站点仍一张全局 featureIdRules 表**（不引入 pack）：正则可写全 URL 匹配多站，但 skills 全局注入的干扰无解、无分发单元、评测素材无归属——三个缺口一个不解。
- **跨站点任务组=会话联邦**（各 origin 独立会话 + 任务组实体跨会话共享任务备忘）：不动组键与 SSE，但引入跨会话状态同步与多 agent loop 一致性这一新复杂面，且用户对话分散多处——复杂度答不上宗旨基准。
- **保留"打开即触发、同 origin 自动并组"再叠任务组概念**：用户被迫感知两层分组且同域多开互相干扰；显式发起模型用同一个"点图标"手势覆盖单站与跨站，无额外概念负担（v6 采纳）。
- **一域名一包硬限定**：规避同会话跨 pack 历史残留最简单，但真实宿主常在一个域名下部署多套系统（/crm、/erp），会把这类宿主挡在 pack 机制外；最长前缀匹配 + 边界标记以极小复杂度换全覆盖。
- **会话组键升 origin+location**（同域多 pack 各开会话）：历史彻底隔离，但插件须感知 pack 边界（装配知识外泄客户端），且 SPA 站内换路径会把一次对话拦腰截断。

## 后果

- 正：站点配置成为可独立分发/版本化/评测的自治单元（"子 agent"）；跨站干扰被结构性排除；跨系统业务可在一个会话内完成。
- 负：装配载入从一级变两级（registry→pack），审计与 eval 需带 packId 维度；任务组把"多宿主身份获取"提前暴露（每个站点各需一次身份获取，插件 UX 需引导）。
- 分期（全部正式排期，依次实施）：**① P0 观测瘦身 + P2 会话持久化**（小改动、独立收益）；**② pack 机制**（host-demo 与 codeflow 各迁为独立 pack，即形成双站点格局；codeflow pack 的 facts 纳入站点组件库交互提示——E2E 实证：一条"Semi 下拉须点选项行"可省数轮摸索）；**③ P1 历史压缩**（任务组硬前置）；**④ 任务组（§5）**——验收案例定死：**codeflow.asia 获取令牌 → mail.126.com 撰写含该令牌与使用方式的邮件发至指定收件人**，一个会话、一次任务级授权贯穿两站（发送步骤独立确认）、令牌值按 §5 敏感值数据流口径经模型上下文流转、审计按 C5 脱敏（引用传递维持挂锚点不提前实现）。批次④开工前先做 iframe spike：126 写信正文编辑器在 iframe 内，快照与步进器现仅走顶层文档，须验证 content script all_frames + 同源 iframe 下钻可行性。
- 锚点：pack 间依赖/组合（一个业务域拆多 pack）——出现真实复用场景时评估；pack 签名与来源信任（第三方分发）——pack 越出本仓分发时评估；跨会话用户记忆——ADR-014 设计时评估。
