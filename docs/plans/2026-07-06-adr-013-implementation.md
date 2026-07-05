# ADR-013 实施方案（批次①-④ → 验收案例：codeflow 取 key × mail.126.com 发信）

> 状态：执行中（2026-07-06，分支 `docs/adr-013-v8`）。
> 本文是 ADR-013 v7 的开发期实施方案（人读层）：把决策翻译为文件级改动清单、契约变更、验证门与验收运行手册。
> 决策权威仍是 `docs/adr/adr-013-site-pack-and-cross-site-task-group.md`；冲突以 ADR 为准。

## 一、目标与验收

**总验收（= 批次④验收案例）**：用户真实 Chrome 中，一个会话内完成——
codeflow.asia 创建 API key → agent 经 navigate 指令打开 mail.126.com（自动入组）→
撰写含该 key 与使用方式的邮件 → **发送步骤独立确认** → 发至 231889617@qq.com。
一次任务级授权贯穿两站；key 值按 ADR §5（v6）经模型上下文流转，审计落盘按 C5 脱敏。

**过程门（每批次必过）**：`pnpm -r build` + `pnpm -r --workspace-concurrency=1 test` 全绿；
批次涉及配置/评测面时 `pnpm eval` 全绿（≥3 跑）；既有浏览器 E2E（`test:e2e`/`:m2`/`:m3`）不回归。

**文档同步项（随本方案落地）**：ADR 批次④行"令牌全程引用传递不进模型上下文"为 v5 残留，
与 §5（v6 显式修正：MVP 允许敏感值经模型上下文、引用传递挂锚点）矛盾——修正该行为引用 §5 口径（记 v8）。

## 二、现状基线（侦察结论，2026-07-06）

- **装配**：`packages/assembly/src/index.ts` 单文件；`loadSnapshot` fail-closed；`resolveFeature` 为全局 featureIdRules 正则表（无 origin 维度）；全仓无 packId 概念。
- **会话**：`apps/server/src/sessions.ts` 内存 Map；history 仅 user/assistant 文本轮；快照观测只活在回合内 `messages`（≤150 元素 JSON、可达十余 KB/次、`ZA_MAX_TURN_ROUNDS=12` 内逐轮累积），回合结束即丢；无压缩、无落盘。
- **llm-port**：不读上游 usage、无窗口配置（`LlmStreamEvent.done` 无 usage 字段）。
- **toolgate**：dom 工具仅校 `pathPrefixes` 前缀（无 origin）；http adapter 完全不校 origin；`navigate|waitFor` 在 `RESERVED_DOM_ACTIONS` 中 fail-closed 拒绝（契约枚举三处已齐备）。
- **claims**：C2 单对象贯穿 6 处（sessions/ports/toolgate 渲染/审计取值/demo-token）。
- **extension**：打开页面即自动建会话，组键=origin（`background.ts:260`）；图标点击无行为；快照只走顶层文档（无 all_frames、无 iframe 下钻）；`host_permissions`/`matches` 仅 localhost + codeflow.asia；navigate 步客户端未实现（`dom-steps.ts` default fail）。
- **配置**：host-demo 在 `examples/host-demo/config`（旧格式）；codeflow 配置在仓库外 `../tmp/zen-agent-demo/config`（单功能 `codeflow-token`，规则宽匹配 `/console`）；126 零素材。
- **评测**：runner 写死 `evals/scenarios.json` + host-demo 根。
- **真机验收形态**：`scripts/e2e/serve-codeflow.mjs` 起服务端（真实 LLM、`.env` 在 `../tmp/zen-agent-demo/`），浏览器=用户真实 Chrome + 真实登录 cookie，扩展手工加载，`za.token` 经 SW 控制台写入。

## 三、批次①：P0 旧观测瘦身 + P2 会话持久化（server 单模块）

### P0（`apps/server/src/gateway.ts` + `sessions.ts`）
1. 回合结束时把工具轮（assistant `toolCalls` 回声 + `role:tool` 观测）随 user/assistant 文本一起落 history（现状：整段丢弃）——跨回合任务连续性是批次④前提。
2. 落 history 时执行瘦身：**全历史仅保留最近一次 page_snapshot 观测全文**，更早的（含本回合内较早轮次的）替换为一行存根 `[快照已过期：N 元素，refs 失效]`。
3. 回合内 `messages` 只追加不回改（护 prompt 缓存前缀）；替换只发生在回合落盘边界。
4. 非快照类工具观测（http 执行结果等）原样保留，不在 P0 范围。

### P2（`apps/server/src/sessions.ts` 新增持久化装饰器，组装在 `apps/server/src/index.ts`）
1. `createPersistentSessionStore(inner, {dir, ttlMs})`：写路径 append `.za/sessions/<sessionId>.jsonl`（事件行：create/context/history/claims/summary），读路径内存 miss 时按文件重放恢复。
2. 闲置 TTL 默认 1 小时（`ZA_SESSION_TTL_MS`，env 可调），定时清理过期文件与内存项；不做归档/查询。
3. **fail-open**：存储任何异常只记一次告警、不进控制流（沿审计旁路语义）；与 `.za/events.jsonl` 审计流严格分离。
4. 落盘内容含对话与 claims 派生字段，不含 JWT 原文/secret 值（SEC-01/04）。

**验证门**：新增单测（P0 存根替换边界、P2 重放恢复/TTL/fail-open）；全量 build+test；`test:e2e` 不回归。

## 四、批次②：pack 机制（assembly + contracts + server + eval runner + 配置迁移）

### 契约（C4 扩展，additive）
1. 根 manifest 二形态判别：**registry** `{version, packs:[{packId, version}]}` 或 **legacy**（现 featureIdRules 形态，按缺省 `packId=default`、无 site 围栏载入——存量迁移路径，保留并测试）。
2. 新 `pack.schema.json`：`{packId, version(semver), site:{origin, locations?(路径前缀数组,缺省["/"])}, tenant?, featureIdRules, features[]}`；`tenant` 用于 claims→origin 路由（见批次④）。
3. C5 审计事件顶层加可选 `packId`/`packVersion`。

### 装配引擎（`packages/assembly`）
1. `loadSnapshot` 两级：registry→逐 pack fail-closed 校验（拒载语义不变）；同 origin location 前缀重复 → 拒载。
2. `resolveFeature(url)` 两级：origin 精确匹配 + 最长 location 前缀 → 唯一 pack；pack 内 featureIdRules → featureId；无命中 → 仅基座（现 fail-safe 不变）。返回值升为 `{packId, packVersion, featureId, snapshotVersion}`。
3. skills 收敛 pack 作用域：只注入激活 pack 的 skills。
4. `docs/` 渐进披露：pack 激活时注入文档索引（frontmatter 标题+摘要）；新增平台内建 `pack_doc` 工具（服务端执行、只可读当前激活 pack 的 docs/、单次读取截断上限、fail-closed），注入模式参照现 `guide_highlight` 内建工具。docs/ 为空则不注入索引（对验收非阻塞）。
5. featureId/toolId 审计与端口定位升 `{packId, featureId}` 二元组。

### server / 评测
1. `gateway.ts` 装配调用链带 packId；审计 assembly/tool-* 事件补 packId/packVersion。
2. eval runner（`scripts/evals/run.mjs`）：保留现 `evals/scenarios.json` 全量跑，新增按根发现 `packs/*/eval/scenarios.json` 逐 pack 跑（mock LLM 协议层，≥3 跑判回归）。

### 配置迁移（改配置必跑 `pnpm eval`，ZA-EVAL）
1. `examples/host-demo/config` → registry 根 + `packs/host-demo/`（site.origin 对齐 e2e host 端口，run-m* 脚本统一 host 端口）；既有 13 场景评测与三套浏览器 E2E 全绿为迁移完成判据。
2. 新建 `examples/acceptance/` registry 根：
   - `packs/codeflow-console/`：从 `../tmp/zen-agent-demo/config` 迁入仓，`site.origin="https://codeflow.asia"`、`locations:["/console"]`、`tenant:"codeflow"`；facts 纳入站点组件库交互提示（"Semi 下拉须点选项行"等）；顺手修正两处漂移（feature.md 引用不存在的 mcp-echo 工具；facts.md 查询端点与 tools.json 不符）；补 `eval/scenarios.json`（≥3 场景：装配命中 /console/log、工具面投影、拒答）。
   - `packs/mail-126/`：**新建**，`site.origin="https://mail.126.com"`、`locations:["/"]`；feature `mail-compose`（写信/发送）；facts 写 126 webmail 结构（写信按钮、收件人/主题输入、正文编辑器在 iframe 内、发送按钮、安全弹窗形态——批次④ spike 后回填实测细节）；工具见批次④。
3. `serve-codeflow.mjs` → 升级为 `serve-acceptance.mjs`：`ZA_SNAPSHOT_ROOT=examples/acceptance`，`ZA_MAX_TURN_ROUNDS=40`，其余（demo-token、审计 sink、`.env` 映射）沿用。

**验证门**：assembly 单测补 registry/legacy/最长前缀/重复前缀拒载/pack 作用域 skills/pack_doc 围栏；全量 build+test；`pnpm eval`（含新 pack 场景）；三套浏览器 E2E 全绿。

## 五、批次③：P1 历史压缩（llm-port + server；任务组硬前置）

1. llm-port（additive）：请求带 `stream_options:{include_usage:true}`；`done` 事件加可选 `usage:{inputTokens, outputTokens}`（上游返回即透传）。
2. 触发估算：优先上一轮 usage 实数，缺省按字符近似（≈chars/3，实现时可校准）；达 `ZA_LLM_CONTEXT_WINDOW`（默认 200000）× `ZA_LLM_COMPRESS_THRESHOLD`（默认 0.6）即压缩。
3. 压缩器（gateway 回合边界执行）：较早回合压为滚动摘要（业务目标/已完成步骤/关键结论），最近 K 轮（默认 4）保留原文；摘要以 LLM 生成、失败则本回合放弃压缩（fail-open，下回合再试）。
4. 结构约束：任务级授权的 task 标题与计划保留在摘要器之外（授权语义不得被摘要糊掉——`hitlGrants` 在 toolgate 侧本就不进历史，此处指历史中的 task 计划文本入摘要时须整句保留）；治理注入每轮全量重建、结构上不参与压缩；站点边界标记（批次④注入）在摘要中保留。
5. 摘要状态入 `SessionState`（P2 已持久化 summary 事件行）。

**验证门**：单测（阈值触发/最近 K 轮保留/边界标记保留/摘要失败 fail-open/usage 缺省近似）；全量 build+test；`test:e2e` 不回归。

## 六、批次④：显式会话组 + 任务组（extension 重构 + toolgate/gateway + 126 配置补全）

**前置 spike（开工前）**：真机打开 mail.126.com 写信页，确认正文编辑器 iframe 的同源性与 DOM 结构。
- 同源（预期）→ 方案 A：快照器从顶层文档递归下钻同源 iframe（`contentDocument` 可达），ref 带 frame 路径，dom 步进器按 frame 路径解析——**不需要 all_frames**；
- 跨源 → 方案 B：`all_frames:true` + background 聚合多帧快照（复杂度高，届时单独评审）。
spike 结论回填 mail-126 pack 的 facts。

### extension（§5 显式会话组）
1. **显式发起**：content script 不再自动挂面板/建会话；`chrome.action.onClicked` → 当前 tab 挂面板 + 新建会话 + 包进新 zen 标签组。同 origin 多组各自独立。
2. 桥按**组实例**建：`groupBridge` 键从 origin 改为 tabGroup id；`chrome.storage.session` 存 groupId→sessionId；组员资格=显式创建+显式加入（用户拖 tab 入组 → 挂面板接入同一会话）；关组=关会话。
3. 活跃页路由、单桥单 SSE、user-echo 镜像全部保留（仅组键与成员资格语义变化）。
4. **navigate 步客户端实现**：content 收到含 navigate 的指令转发 background → `chrome.tabs.create` 入本组 + 标活跃 → exec-result 回 `{ok, url}`；navigate 指令强制单步（服务端签发时约束）。
5. 快照 iframe 下钻（按 spike 方案 A）；`manifest.json` `host_permissions`/`matches` 增 `https://mail.126.com/*`、`https://*.126.com/*`。
6. **e2e 可操作性开关**：`chrome.storage.local` `za.autoActivate:[origin...]`（配置级显式开关，非对话可改；仅 dev/demo 用）——命中 origin 的页面视同图标点击自动激活，供自动化驱动验收；生产默认关。
7. 组内切站回合注入边界标记（"以下对话发生在 X 站点"）——server 侧生成（见下），extension 无感。

### server / toolgate（任务组治理面）
1. **per-origin claims**：`SessionState.claims` 升 `claimsByOrigin: Record<origin, IdentityClaims>`（C2 契约不变）；路由规则：claims.tenant 匹配 pack.tenant 的所有 pack origin。toolgate 按目标工具所属 pack 的 origin 取 claims，http/server 工具缺失/过期即 fail-closed 拒绝（U7）。
2. **dom 工具身份口径（U7 细化，记入 ADR v8）**：dom 步在用户自己的页面会话内执行、无 claims 注入面——dom 工具只要求平台 JWT 有效，不要求该 origin 的宿主 claims；http/server 工具维持宿主 claims 硬要求。126 侧纯 dom 工具因此无需 126 宿主身份签发体系。
3. **围栏带 origin**：dom `pathPrefixes` 由 pack.site.origin 补齐为绝对围栏（校 origin+path）；http adapter 相对模板锚定 pack origin；navigate 目标 URL 必须落在**已安装某 pack** 的 site 围栏内（origin+location），越界不签发；exec-instruction 仍只发活跃页，目标 origin ≠ 活跃页 origin 时不签发（navigate 除外，其语义即开新页）。
4. **navigate 签发**：`RESERVED_DOM_ACTIONS` 移除 navigate（waitFor 维持保留）；单步强制；`DomStep` 如缺目标 url 字段则 additive 补齐并**三处同步**（schema.json / contracts TS / extension frames.ts）。
5. **对外发送独立确认**：C1 加可选 `hitlMode:"per-task"|"every-call"`（缺省 per-task，additive）；`every-call` 跳过 `hitlGrants` 复用、次次确认。`mail-126` 工具面：`mail-126.page-operate`（dom，riskTier hitl，任务级授权）+ `mail-126.send-email`（dom，riskTier hitl，`hitlMode:"every-call"`，步集只含点击发送）；授权卡计划中明示"发送前单独确认"。
6. **站点边界标记**：会话 currentUrl 的 pack 切换时，向历史注入一行系统侧标记（随 P1 摘要保留）。
7. 审计：tool-* 事件已带 packId（批次②）；组/导航行为经现有事件类型可追溯，不新增事件类型。

**验证门**：toolgate 单测（origin 围栏/越界不签发/navigate 单步/every-call 不复用授权/per-origin claims 缺失拒绝）；extension 单测（组实例桥/显式激活/navigate 转发/iframe ref 解析）；全量 build+test+eval；三套浏览器 E2E 全绿（host-demo 迁 pack 后语义不变，`za.autoActivate` 供脚本激活）。

## 七、验收运行手册（真机，批次④完成后）

前提（人工一次性）：用户 Chrome 已登录 codeflow.asia 与 mail.126.com；重建扩展并加载 unpacked；
`node --env-file=../tmp/zen-agent-demo/.env scripts/e2e/serve-acceptance.mjs` 起服务端；
SW 控制台写入 `za.token`/`za.serverBaseUrl`/`za.autoActivate`。

流程：打开 `https://codeflow.asia/console/log` → 激活面板（图标或 autoActivate）→ 下达任务
（"创建一个 API key，然后用 126 邮箱把 key 和使用方式发邮件给 231889617@qq.com"）→
批准任务级授权卡 → agent 建 key（/console/token）→ navigate 开 mail.126.com（自动入组）→
写信（收件人/主题/正文含 key 与 base_url/model 使用说明）→ **独立发送确认卡** → 批准 → 发送成功。

判定：126 显示发送成功页/已发送列表有该信；`.za/` 审计流含完整事件链且 key 值已脱敏；
开发侧不把 key 值写入仓库/日志/对话产物（SEC-01 自守）。

## 八、风险与权衡

| 风险 | 处置 |
|---|---|
| 126 编辑器 iframe 跨源 → 方案 A 失效 | spike 前置；跨源则批次④暂以方案 B 评审后再动工（本方案批次④前不写死实现） |
| 126 反自动化（安全弹窗/滑块/短信验证） | dom 步进器遇未知弹窗 read+快照回喂由 agent 决策；仍被拦则人工过一次验证后重跑（验收允许人在环） |
| 显式会话组重构回归既有 E2E | run-m* 场景以 `za.autoActivate` 等价替代"打开即注入"；三套 E2E 全绿为门 |
| per-origin claims 简化（tenant 路由） | MVP 单租户 demo 足够；多宿主身份获取 UX 是 ADR 已声明的负面后果，标准版处理 |
| P1 摘要质量影响长任务 | 最近 K 轮原文 + task 计划整句保留 + fail-open；验收路径回合数受 `ZA_MAX_TURN_ROUNDS=40` 保护 |
| key 值经模型上下文（ADR §5 口径） | 合法产品数据流；审计 C5 脱敏 + 开发侧 SEC-01 自守；引用传递挂锚点不提前实现 |

## 九、执行顺序与提交纪律

批次①→②→③→④严格串行（依赖递进），每批次一组提交（build+test+eval 门全绿才提交）；
批次④开工前完成 spike 并回填 mail-126 facts。开发由 Workflow 编排（Opus 4.8），每批次产出走
本方案第三-六节的验证门；验收（第七节）由主会话真机驱动。
