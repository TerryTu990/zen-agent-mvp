# 2026-09-07 任务级一次授权与试用体验修复轮（根因与方案）

> 类型：计划（人读层）。触发：Terry 2026-09-07 在插件 0.11.0 / 服务端 5d6e88e 上的真实试用反馈。
> 本文是本轮五项改动的共同依据：各任务实施者与审核者 MUST 先读本文。裁决权在 Terry；
> 本文记录默认取向与理由，Terry 复核时可逐条推翻。

## 1. 试用复盘（审计会话 f4978c06，2026-09-06 16:32Z 起）

任务原话：「帮我打开百度，然后查询 AI agent 的相关新闻，找到一条最值得我关注的页面，帮我打开，然后告诉我里面的核心内容」，
从 `chrome://newtab/` 空白页（组内唯一成员 p1，silent）点击 Zen 图标后发起。

| 时刻(Z) | 事件 | 说明 |
|---|---|---|
| 16:33:16 | assembly feature=null tools=[] | 静默页冷启动，仅基座 + open_url |
| 16:33:18→26 | open_url → hitl → approve → ok | **授权 1**；新开页签 p2 打开百度，p1 空白页留在组里（P1） |
| 16:33:44→49 | browse.page-operate → hitl → approve → ok | **授权 2**（per-task 首批）；随后三批 allow（任务授权复用） |
| 16:34:41→44 | open_url（新浪文章）→ hitl → approve → ok | **授权 3**；新开页签 p3，p3 此后**始终 silent**（未接入） |
| 16:34:58 | page_snapshot(targetPage=p3) outcome=skipped | 服务端拒绝：silent 页不可定向读取，文案建议「经导航打开其地址再重试」 |
| 16:35:01→07 | open_url → hitl → approve → deny `approval-stale:page-not-in-group` | **授权 4**（无效） |
| 16:35:19→36:14 | open_url → hitl → approve → ok | **授权 5**；又开出 p4（同 URL）仍 silent |
| 16:36:23 | open_url → hitl … | **授权 6**，用户放弃 |

会话文件里 p3/p4/p5/p7 四个同 URL 的新浪页全部 silent；context 始终停在百度搜索页。

## 2. 根因

### P1 空白页上 open_url 新开页签
`apps/extension/src/navigate-target.ts` `decideNavigateTarget` 只做同源复用（同 href 激活 / 同源异 URL 原地换 URL），
`chrome://newtab/` 与目标不同源 → `create`。空白页本身没有任何内容可保留，应原地导航。

### P2 打开的新页永远 silent → 循环打开
三段链条叠加：
1. **注入失败静默**：adr-027 后 host 权限降为 `optional_host_permissions`。新页接入依赖 background `sendActivate` →
   `chrome.scripting.executeScript`（`apps/extension/src/background.ts`），该 origin 未授权则注入失败、就此收手、无任何客户端信号。
   侧边栏没有就地授权入口（HANDOFF §7.2 已登记锚点），用户无从补授权。
2. **拒绝文案诱导再导航**：`apps/server/src/gateway.ts` 对 silent 页定向快照的拒绝文案是「需先激活该页——由用户切换到该页，
   或经导航打开其地址——再重试」，模型据此再次 open_url；同 href 走 `activate` 分支再次 `sendActivate`，注入再次失败，形成循环。
3. **回喂无接入信息**：open_url 成功回喂只有 `{url}`（`OPEN_URL_RESULT_SCHEMA`），模型无法区分「页已打开且可读」与「页已打开但未接入」。

### P3 一个任务多次授权
- toolgate 任务级授权键 = `(sessionId, packId, packOrigin, task)`（adr-024 D4）；generic pack 的 `packOrigin` = 活跃页 origin，
  跨站导航后作用域必然失配。
- `open_url` 在 toolgate 是 every-call（每次必弹卡、不消费授权），gateway 批准后也不登记授权
  （理由：导航卡上用户没看到任务计划）。`site_navigate` 会消费授权但同样不登记。
- 因此最少 3 次：冷启动导航 1 次 + 页面操作首批 1 次 + 打开结果页 1 次；P2 的循环再放大。

## 3. 决策

### D1（P1）空白页原地导航
`decideNavigateTarget` 优先级：同 href → activate；同源异 URL（非发起页）→ update；**组内首个空白页（非发起页）→ update**；否则 create。
空白页判定闭集：`about:blank`、`chrome://newtab/`、`chrome://new-tab-page/`、`edge://newtab/`、空 url。
发起页仍排除（原地重载会销毁发起页文档，回执无法送达）；冷启动直执行无发起页，故空白页可被复用。

### D2（P2）页面接入保障 + 循环止损
A. **批准手势内申请站点访问权限**：HITL 卡「批准」点击是用户手势，插件在此时若尚未持有 `<all_urls>`
   （`chrome.permissions.contains`）则 `chrome.permissions.request({origins:['<all_urls>']})`，无论用户是否允许都继续回传 approve。
   注入面不变：不变量 IN 约束的是「content 只出现在会话内被动作的页」，持有权限 ≠ 注入；权限只让既有注入路径能成功。
   *否决的备选*：逐 origin 申请——任务内自动执行的导航没有手势可用，Chrome 不允许无手势申请；
   回到静态 `<all_urls>` 注入——破坏 adr-027 不变量 IN。
   *代价*：首次批准时浏览器多一个「读取和更改所有网站上的数据」提示（一次性）；Terry 可随时回退为逐站。
B. **新页加载完成后注入**：`tabs.onUpdated(status=complete)` 补发激活已存在；核对 `performNavigate` 在页尚未加载时立即
   `sendActivate` 是否会注入进初始空文档并被丢弃，若是则改为只登记待激活、由 complete 触发。
C. **服务端**：
   1. 非定向 open_url/site_navigate 成功后，回喂前等待落点页接入（`session.groupPages` 中该 URL 页 status 变为 active/background），
      上限 `ZA_NAV_ATTACH_WAIT_MS`（默认 8000）；observation 追加 `attached: true|false` 与相应指引。
   2. silent 页快照拒绝文案改为：先重试一次定向快照；仍不可用则告知用户在该页点击 Zen 图标授权本站；**不要再次打开同一地址**。
   3. 止损：同会话对同一规范化 URL、组内已有该 URL 的 silent 页时再次 open_url → deny（reason `already-open-not-attached`），
      回喂同一指引；审计 tool-decision 记 reason。
D. assets：ZA-FEAT-11 与 web-search SKILL 同口径（未接入不重复打开、如实告知用户）。

### D3（P3）任务级一次授权：计划上导航工具，授权随任务导航延续
1. contracts：`open_url` / `site_navigate` 增可选 `plan: string[]`；语义同 `browse.page-operate.plan`（整任务计划）。
2. toolgate：两个导航工具同律——参数校验 → unattended deny → 带 task 且授权命中 allow → 否则 hitl。open_url 不再 every-call。
3. gateway：导航工具带 task 且 plan 非空时，批准即登记授权（用户在卡上看到了计划）；无 plan 的导航批准只覆盖本次。
4. **授权随任务导航延续**：导航调用带 task、且本次是「授权放行」或「带 plan 批准」，导航成功且非定向 → 落点重装配后以新
   `(packId, packOrigin)` 再登记同一 task。这是服务端驱动的延续（导航本身已获批准），不是模型自述换站；
   用户手动切页/换站不延续，adr-024 D4 的防挂靠语义保留。
5. HITL 卡：导航工具带 task+plan 的卡按「任务授权卡」呈现（任务标题、首步目标地址、计划清单、「批准后自动执行、随时可停」）。
6. assets：ZA-FEAT-03 扩展到导航（任务首个动作 MUST 带 task + 整任务 plan，无论工具）；ZA-FEAT-09/11、web-search SKILL、
   ZA-SYS-06 同步；tools.json 描述同步。改基座前核对 `scripts/mock-llm/server.mjs` PROBE_LITERALS。
7. 评测新增 hitl 维度场景（带 plan 一次授权 / 无 plan 不登记）；新增 E2E `test:e2e:task-grant`（金路径：空白页 → 一张卡 → 搜索 → 开结果页 → 快照 → 总结，hitl-verdict 恰 1）。
8. 记 adr-028。*代价*：一次批准覆盖任务内任意导航与页面操作（TTL 15 分钟滑动、停止吊销、敏感写入与 every-call 工具仍逐次确认）。

### D4（P4）去掉面板顶部页面上下文块
删除 `.za-context`（状态点 / 页面标题 / URL / 「本页生效」折叠块）。状态语义保留：`data-state` 与 `data-group-id` 迁到面板根 `.za-shell`
（E2E 依赖）；「当前页面不在任务组内」「本站不辅助」两条须知走 composer notice；「打开配置中心」改为 composer 操作行的齿轮图标按钮
（保留 `data-za-config-center`）。ui-style-guide §4 侧边栏结构同步。

### D5（P5）配置中心按 Atelier 重做
`DESIGN.md` 是令牌与语言 SSOT（侧边栏已按其落地）；配置中心改为同族：近中性底、暖近黑正文、黏土强调、发丝边、克制动效；
结构参考业界优秀设置页（左侧固定导航 + 720–800px 内容区 + 分区卡片 + 行式设置项 + 粘性保存栏）。
治理语义色继续专用（自动执行/需确认/已禁用），品牌色不表达治理。`docs/design/ui-style-guide.md` 令牌与布局收敛到 DESIGN.md 口径。

## 4. 任务拆分与模型分配（Fable 5.1 总控）

| 任务 | 模型 | 主要文件 | 验证门 | 顺序 |
|---|---|---|---|---|
| T-D 去顶部块（D4） | opus5 实施 / opus5 审核×2 | sidepanel.ts、sidepanel.css、相关单测、4 个 E2E 脚本选择器、ui-style-guide §4 | 插件单测、build、E2E sidepanel/m5/coldstart/d3 | 主树 1 |
| T-A 空白页原地导航（D1） | opus5 / opus5 | navigate-target.ts(+test)、navigate-execution.test、run-coldstart-open-url.mjs | 插件单测、build、E2E coldstart/d3 | 主树 2 |
| T-B 接入保障与止损（D2） | fable5.1 / fable5.1 | conversation-hitl.ts、sidepanel.ts、background/navigate-execution、gateway.ts、toolgate、assets(feature/SKILL)、adr-027 §4 | build、全量单测、eval+check、E2E coldstart/d3/m2/m3/sidepanel | 主树 3 |
| T-C 任务级一次授权（D3） | fable5.1 / fable5.1 | contracts、toolgate、gateway、conversation-hitl.ts、assets、scenarios+mock、新 E2E、adr-028 | build、全量单测、eval 全量+check、E2E 全家族 | 主树 4 |
| T-E 配置中心重做（D5） | opus5 / opus5 | options.html、config-center.ts、options 单测、ui-style-guide | 插件单测、build、Playwright 截图复核 | worktree 并行 |

## 5. 流程与门

每任务：实施+测试 → 审核 1 → 修复+测试 → 审核 2 → （按发现修复，不再审）。审核者只读不改。
总控收口：`pnpm lint:deps && pnpm verify:paths && pnpm -r build && pnpm -r --workspace-concurrency=1 test && pnpm eval`、
`node scripts/evals/run.mjs --check`、E2E 全家族串行（共用 8787 端口）、`git diff --check`；合并 T-E 分支与本轮分支到 main 并推送。

## 6. 风险与遗留

- D2-A 的 `<all_urls>` 一次性申请改变了 adr-027 的权限体验口径（注入模型未变）；可回退为逐站申请但会回到「任务内自动导航无法接入」。
- D3 扩大了单次批准的覆盖面；缓解见 D3-8，随 adr-028 登记。
- D4 撤掉的「本页生效」块曾是 R-2 裁决指定的 R4 终态载体。本轮把 R4 可追溯性与北极星验收改挂配置中心
  （product-form-definition §3/§4/§6、00-design-brief §9、03-configuration §1 已同步，R-2 标注被取代）；
  面板侧是否回挂装配可见载体挂锚点「配置中心 Atelier 重做（D5）落地时裁决」。此改口径尚待 Terry 追认。
- 真实 LLM / 真实站点 E2E 仍 BLOCKED（凭证在 SEC-03 读禁区），本轮以脚本化 mock E2E 与评测为门；发布后需 Terry 复跑同一任务验收。

## 7. 真机验收清单（Terry）

脚本化 E2E 已覆盖的判定见 `test:e2e:coldstart` / `test:e2e:task-grant` / `test:e2e:nav-attach` 与评测
`generic-open-url-not-attached`；下列各项只能在真实 Chrome + 真实 LLM + 真实站点上验证，发布后按 §1 同一任务复跑。

### 7.1 同一百度任务逐项勾选

任务原话（§1）：「帮我打开百度，然后查询 AI agent 的相关新闻，找到一条最值得我关注的页面，帮我打开，然后告诉我里面的核心内容」，
从 `chrome://newtab/` 空白页点击 Zen 图标发起。

- [ ] 整个任务恰一张授权卡（任务授权卡：标题「授权任务：…」、「将先打开：https://www.baidu.com/…」、计划清单、按钮「授权执行」）；
      卡上的计划覆盖整任务（打开百度 → 搜索 → 打开结果页 → 读取并总结），而不只是「打开百度」一步。
- [ ] 首次点击「授权执行」恰弹一次浏览器权限询问（「读取和更改所有网站上的数据」），允许后同一任务内不再询问；
      此后新任务的批准也不再询问（`<all_urls>` 已持有）。
- [ ] 百度页在原空白页原地打开：组内 tab 数不变、无空白页残留。
- [ ] 搜索与打开结果页均无第二张卡；打开结果页后该页接入（面板对该页可读：agent 能直接 page_snapshot 并给出正文要点，
      不出现「尚未接入 / 点击 Zen 图标」的转述）。
- [ ] 全程没有对同一地址重复打开（组内同 URL 页面 ≤ 1；`.za/events.jsonl` 无 `already-open-not-attached`）。
- [ ] 总结含结果页正文要点（不是标题复述，不是「无法读取」）。
- [ ] 任务结束后点「停止」再发同一任务：重新弹授权卡（停止吊销授权）。

### 7.2 只能真机验证的项

- [ ] **permissions.request 的手势有效性**：在真实 Chrome 里，「授权执行」点击处理内的 `chrome.permissions.request`
      被认作用户手势（弹出授权气泡而非静默失败）。E2E 只能桩化该调用（`stubPermissionRequest`），无法证明手势链路。
      若气泡未弹：检查点击处理与 `contains` 之间是否插入了别的 await（`apps/extension/src/conversation-hitl.ts ensureSiteAccess`）。
- [ ] **真实站点接入时长**：用户允许权限后，真实站点（含 302 跳转 / SPA 子路由）能在 `ZA_NAV_ATTACH_WAIT_MS`（默认 8000）内
      接入（回喂 `attached:true`）。E2E 的落点是本地静态页，加载与注入近乎即时。若经常超时：记录站点与耗时，考虑调大默认值。
- [ ] **模型遵从**：真实 LLM 在任务首个 `open_url` 上带 `task + 整任务 plan`（ZA-FEAT-03）；收到 `attached:false` 指引后
      不再重复打开同一地址、最多重试一次定向快照、然后如实转达「点击 Zen 图标」（ZA-FEAT-11 / web-search SKILL）。
      评测里的 mock 是确定性剧本，模型自由发挥只能真机看。
- [ ] **用户拒绝权限询问**：在气泡上选「拒绝」，任务仍继续（批准回传不受影响），落点页保持 silent，agent 转达授权指引而不循环开页。

### 7.3 挂锚点

- 真实 LLM 门（`test:e2e:real`）与本轮路径（任务授权卡 / attached 回喂 / already-open 止损）的对齐：挂锚点
  「Terry 提供凭证解除 BLOCKED 时」——届时把 §7.1 的百度任务按 `ZA-C-EVAL-02` ≥3 跑纳入该门。
