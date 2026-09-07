# HANDOFF — zen-agent-mvp（试用反馈修复轮完成态，2026-09-07）

> 面向：在本目录续作的下一个会话/开发者。
> 事实权威：代码、各 `.schema.json`、`docs/reference/00-design-brief.md`（SSOT v2）。本文件是过程性交接。
> 上一份交接（2026-09-03 对标优化轮）的内容已并入本文；其未竟事项在 §6 逐条给出现状。

## 一、这是什么、到哪了

**可被用户塑形的浏览器 agent harness**（「浏览器 agent 的 Claude Code / AI 时代的 Tampermonkey」）：
在任意站点上叠加 agent，按 `packId`/`featureId` 动态装配规则、知识与工具面，提供三档能力（信任阶梯）——
讲解（看）/ 引导（指）/ 受控代执行（做）。
源起 zen-flux-mvp 架构对谈，**复制已验证模式与契约、不共享代码**（adr-005）。

**当前分支**：`main`（本轮分支 `opt/2026-09-07-task-auth-and-ux` 已合并）。
本轮由 Terry 2026-09-07 的真实试用反馈驱动（审计会话 f4978c06 复盘见
`docs/plans/2026-09-07-task-auth-and-ux-round.md` §1-§2），做了五项产品改动 + 一次 E2E 有效性改造，产物见 §4。

## 二、验证现状（本机实跑，2026-09-08，`opt/remove-automation` 合并态 `24df066`）

| 门 | 命令 | 结果 |
|---|---|---|
| 依赖 lint（U2） | `pnpm lint:deps` | 绿 |
| 验证脚本路径自检 | `pnpm verify:paths` | 绿 |
| 构建 | `pnpm -r build` | 绿（7 workspace） |
| 单测 | `pnpm -r --workspace-concurrency=1 test` | **1711 例全绿**（91 文件；自动化下线退役了一批随能力消失的用例） |
| 评测 | `pnpm eval` | 104 组场景 × 3 跑全过；审计完整性 PASS（954 条事件）；报告 `evals/runs/2026-09-08-24df066-eval.md` |
| 评测判据自检 | `node scripts/evals/run.mjs --check` | 绿（探针字面 27 条在位 + 104 条判据均可被证伪） |
| 浏览器 E2E 家族（11 门） | `pnpm test:e2e:family` | **9 门绿 / 2 门红**：绿 = sidepanel、coldstart、nav-attach、task-grant、d3、m1、m2、explain-pack、user-config；红 = m3、m5（成因见下「已知未绿」，非本轮引入）；报告 `.za/e2e/family-24df066-dirty.json` |

家族 runner 落盘 `.za/e2e/family-<rev>[-dirty].json`（逐脚本退出码/耗时/git rev），各脚本证据在 `.za/e2e/e2e-evidence/<case>/result.json`。

**已知未绿（如实记录）**：
- `pnpm test:e2e:m3`：`d1 happy：应出现 tool-card 已完成状态` 断言失败。工具批次改为默认折叠后
  （`conversation-hitl.ts` 的 `body.hidden = true`），`innerText` 不再返回被折叠的卡面文案，而断言仍按展开态取文本。
  执行本体仍成立（`counts.cancel === 1`、卡片 `data-status="succeeded"`）。**在 `opt/remove-automation` 拉出点
  `1cfced0` 上以同一消息复现**，非自动化下线引入；判据本身已失效，须由折叠改动的归属批次决定改断言还是改呈现。
- `pnpm test:e2e:m5`：`组外标签页面板未被关闭（enabled=true）` 断言失败——组外标签页的 `chrome.sidePanel`
  开关未被显式关掉。同样**在 `1cfced0` 上复现**，非自动化下线引入；这一条是行为判据，须先判定是面板接入改动的回归
  还是判据过期。
- `pnpm test:e2e:real`（真实 LLM）与 `test:e2e:real-site`（真实站点）**BLOCKED，未执行**：凭证在 `ZA-C-SEC-03` 读禁区，
  开发期不得装载。且 `run-real-llm.mjs` 只装载 host-demo 场景，与本轮 generic-web / 导航授权路径未对齐——
  锚点「Terry 提供凭证解除 BLOCKED 时」（计划文档 §7.3）。
- 只能真机验证的项（E2E 已桩化或不可自动化）：批准点击内 `chrome.permissions.request(<all_urls>)` 是否被 Chrome 认作手势、
  用户允许后真实站点（含跳转/SPA）能否在 `ZA_NAV_ATTACH_WAIT_MS`（默认 8000）内接入、真实模型是否在任务首个
  `open_url` 带 task+plan 并在 attached:false 后不重复打开。**发布后须 Terry 按计划文档 §7.1 用同一百度任务复跑验收。**

## 三、命令速查

| 命令 | 作用 |
|---|---|
| `pnpm build` / `pnpm test` / `pnpm lint:deps` / `pnpm verify:paths` | 构建 / 串行单测 / 依赖 lint / 验证脚本路径自检 |
| `pnpm eval` / `node scripts/evals/run.mjs --check` | 协议层评测（104 场景 ≥3 跑 + 审计完整性）/ 判据自检（不跑 LLM） |
| `pnpm test:e2e:family [-- --only=a,b] [--skip=c]` | **E2E 家族串行 runner**：夹具/端口守卫自检 → 一次构建 → 11 脚本串行 → 落盘 family-<rev>.json |
| `pnpm test:e2e` `:m2` `:m3` `:m5` `:d3` `:coldstart` `:nav-attach` `:task-grant` `:sidepanel` `:explain-pack` `:user-config` | 单门 E2E（真实插件 + mock LLM）；`:nav-attach` 用只授权指定 origin 的夹具测未接入路径，`:task-grant` 是一任务一授权金路径 |
| `pnpm test:e2e:real` / `:real-site` | 需真实凭证，**BLOCKED**（SEC-03） |

E2E/评测端口全部可经 env 覆盖（`ZA_E2E_SERVER_PORT` / `ZA_E2E_MOCK_PORT` / `ZA_E2E_HOST_PORT` / `ZA_E2E_G6_*` /
`ZA_EVAL_*`，默认 8787/8788/4173…），多 worktree 并行时各自换一套；起服务前有端口守卫，占用即 fail-fast。
服务端 env 全表见 `docs/reference/03-configuration.md` §4（本轮新增 `ZA_NAV_ATTACH_WAIT_MS`）。密钥永不入仓（SEC）。

## 四、本轮做了什么

产物：根因与方案 `docs/plans/2026-09-07-task-auth-and-ux-round.md`（§7 为真机验收清单）、
adr-028（任务级一次授权）、adr-027 §4 补记（批准手势申请站点访问权限 + 接入回喂/止损）、
`docs/design/ui-style-guide.md` 收敛到 `DESIGN.md`（Atelier）口径。

| 任务 | 问题 | 关键改动 |
|---|---|---|
| T-A | 空白页上 open_url 新开页签 | `navigate-target.ts` 空白页（about:blank / 各浏览器新标签页）原地换 URL；首次导航未提交的 tab 不算空白 |
| T-B | 打开的新页永远 silent → 反复 open_url | 插件：HITL 批准手势内申请 `<all_urls>`（注入模型 IN 不变）；服务端：导航后等落点接入并回喂 `attached`、silent 页快照拒绝改「最多重试一次」口径、同址未接入再导航 fail-closed deny（`already-open-not-attached`）；assets ZA-FEAT-11 / web-search 同步 |
| T-C | 一个任务授权多次 | contracts：`open_url` / `site_navigate` 带 `plan`；toolgate：两导航同律（带 task 授权命中即 allow）；gateway：带 plan 批准即登记授权、授权随任务导航延续到落点作用域（服务端驱动，用户手动切页不延续，adr-024 D4 保留）；任务授权卡；assets ZA-FEAT-03/09/11、ZA-SYS-06、tools.json、SKILL；评测 +2 场景；E2E `task-grant` |
| T-D | 面板顶部「页面/URL/本页生效」块 | 撤除；`data-state`/`data-group-id` 迁到面板根 `.za-shell`；须知走 composer notice；配置中心入口改齿轮图标 |
| T-E | 配置中心「特别丑」 | 按 `DESIGN.md` 重做（左侧固定导航 + 768px 阅读列 + 分区卡片 + 行式设置项 + 粘性保存栏），功能与测试语义不变 |
| E2E 改造 | 旧 E2E 全绿却没拦住上述三问题 | 夹具 scoped 授权形态 + 桩化权限询问；`nav-attach` 六条断言；coldstart/task-grant 断言收紧为 `attached:true`；端口守卫；家族 runner；评测 `landingAttached:false` 分支 |

每项都走了「实施 → 审核 → 修复 → 审核」（审核最多两次），fable 5.1 总控；版本：快照 2.2.0、插件 0.12.0（已发布，见 §7）。

## 五、必须内化的约束（违反即返工）

- **U1-U8 升级不变量**（`.claude/rules/ZA-WHERE.md`）。本轮契约变更全部是 **U3 加法**（`plan` 可选、observation 附 `attached`、新 deny reason），旧调用点不传即维持基线。
- **两层治理别混**：开发期 `ZA-*` 红线约束开发；运行期治理在 `assets/`（ZA-SYS/ZA-FEAT），MUST NOT 进开发会话。
- **改 `assets/` 必跑评测**（`pnpm eval` ≥3 跑）；**改基座措辞前先 grep `scripts/mock-llm/server.mjs` 的 `PROBE_LITERALS`**；`assets/` 与 `examples/acceptance` 的 generic-web 镜像必须逐字节一致（`generic-pack-mirror` 单测）。
- **快照不可变（U4）**：`assets/` 内容变了就升 `assets/manifest.json` 版本并同步 `production-snapshot.test.ts` 的版本钉。
- **E2E 全家族用 `pnpm test:e2e:family` 跑**，不要只跑 build/单测；多 worktree 并行必须换端口 env。夹具缺省仍把 `optional_host_permissions` 提为已授权——要测未授权路径用 `prepareExtensionDir(dir, { hostPermissions })` 的 scoped 形态（见 `run-nav-attach.mjs`）。
- **评测不覆盖服务端「等待落点接入/唤醒」路径**（runner 以 `ZA_NAV_ATTACH_WAIT_MS=0` 起服）；该路径由 coldstart / nav-attach / task-grant 三条浏览器 E2E 兜住。
- **hooks 已挂载**：za-secret-guard / za-bash-guard / za-verify-on-stop。
- **C3 帧有三处编码**（schema / `packages/contracts/src/client-access-layer.ts` / `apps/extension/src/frames.ts`），改一处必须三处同步。

## 六、未竟事项与锚点（全部有界）

| 事项 | 锚点 |
|---|---|
| 真机验收未做：一次授权卡 + 一次权限气泡 + 结果页接入 + 无重复打开 + 总结含正文（计划文档 §7.1） | 发布 2.2.0 / 0.12.0 后由 Terry 复跑同一百度任务 |
| 真实 LLM / 真实站点 E2E BLOCKED，且 `run-real-llm.mjs` 未对齐 generic-web 导航授权路径 | Terry 提供凭证解除 BLOCKED 时（计划文档 §7.3） |
| 任务授权卡呈现谓词 `isTaskGrantCard`（插件）与服务端登记谓词 `hasTaskPlan` 靠约定同构，无漂移守卫 | 该谓词出现第三处使用、或 hitl-request 帧增加 `taskGrant` 字段时改为帧字段下发 |
| coldstart/task-grant/d3 失败态 `result.json` 不含 commit 字段（其余脚本含） | 下次触碰这三个脚本时统一走 `scripts/e2e/evidence.mjs` |
| 面板拉黑站点的须知文案偏长（composer notice 约 5 行） | 出现真实用户反馈时压缩措辞 |
| `<all_urls>` 一次性申请改变了 adr-027 的权限体验口径（注入模型未变） | Terry 复核；回退即删 `conversation-hitl.ts` 的 `ensureSiteAccess`，代价是任务内自动导航打开的页无法接入 |
| toolgate NonceStore / SessionStore / hitlGrants 仍是进程内存 | S4 状态外置里程碑 |
| r2 审核 12 条 partial（`docs/reviews/2026-09-03-audit-r2.md`）中 `record_application` 进 describeInjection、`domContext` 同步两条 | 下一轮收口 |
| 配置中心可用性十项（G6 §4.3）剩余项 | 首个外部用户试用前 |

## 七、下一步建议

1. **已发布（2026-09-07）**：服务端 `zen-agent-server:dc04179` @ lingm2（release `dc04179-20260906T233819Z-59982`，快照 2.2.0 与本仓 `assets/` 逐文件一致，healthz/匿名激活冒烟通过，容器 healthy）；插件 `release/artifacts/zen-agent-extension-0.12.0.zip`（本机 gitignore 产物，已解压到同名目录供 Chrome 加载，生产地址已烤入）。回滚见 release skill。
2. **真机验收**：Terry 在 0.12.0 上按计划文档 §7.1 复跑「帮我打开百度，查询 AI agent 新闻，打开最值得关注的一条并总结」；任何一项不符按 §7.2 定位是手势/接入时长/模型行为哪一类。
3. 上一轮遗留：r2 partial 两条（§6）；真实 LLM 门对齐（§6）。
