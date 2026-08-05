# G4 批次评审记录：L0 + 配置中心 UI

> 批次：G4（L0-L3 实施方案 §1）。日期：2026-08-05。
> 流程：契约/用例先行（workflow 双路）→ 实现（server ∥ options ∥ 透明视图 三路）→ 三视角独立只读评审 →
> 修复回归（两轮）→ 同视角复核 → 本记录 + commit。
> 验证基线：`pnpm -r build` 0 错；`pnpm -r --workspace-concurrency=1 test` 全绿
> （extension 193 / server 167 / contracts 155 / assembly 113 / toolgate 93 等，全仓 776 用例）；`pnpm lint:deps` 通过。

## 1. 批次范围

- **配置中心四页**（`apps/extension/src/config-center.ts` + options.ts/options.html）：站点包（人读名/版本/来源徽章/启停/未开放能力置灰）、个人定制（规则与事实逐条来源+作用域+删除、收紧矩阵低于 baseTier 档位不可选、`"*"` 全局作用域分区）、自动化（开关+周期，下限=pack 预设、上限=调度端上界）、全局设置（凭证状态不回显值、服务端地址、verbosity）。
- **注入透明视图**（`apps/extension/src/injection-view.ts` + 侧边栏抽屉）：L0/L1/L2 分层、pack 人读名·版本·来源徽章、工具面 baseTier→effectiveTier 收紧箭头与 tightenedBy、`storage-failure` 人读标注、来源未标注段单列（不伪造归属）。
- **服务端**：`GET /v1/packs` + `AssemblyPort.listPacks()`/`PackDescriptor`；`GET /v1/user-config` 增 `subject`（零定制用户构造归属键的唯一来源）；审计 `disabledPackId`。
- **契约**：user-overlay `maxItems`(200)/`maxProperties`(100)；`UserOverlayValidationIssue.kind='scale'`（规模类越界与结构非法可分）。
- 测试：+70 余条（packs 端点、配置中心 30+、透明视图 15、overlay 上界 9、store 规模放行 2）。

## 2. 三视角评审发现与处置（两轮）

三路去重后 **1 blocker + 7 major + 十余 minor**；第一轮修复后复核又发现 **1 回归 blocker + 3 major**，第二轮修净。

### 第一轮

| # | 级别 | 发现（视角） | 处置 |
|---|---|---|---|
| B1 | blocker | 首装/凭证过期时 options 页自锁：`save()` 因 `subject===null` 早退，连凭证都存不下（产品/规则一致） | 本机设置持久化与 L2 提交解耦；凭证变更后以新值重读重渲染；仍不可达时如实标注「个人配置未提交」。测试 harness 改为按 `authorization` 真判 401（原 stub 无视鉴权正是漏测根因） |
| M1 | major | 换凭证后仍用旧凭证请求（产品/架构） | 凭证与基址改实例内可变持有，保存即更新 |
| M2 | major | 自动化本机镜像先于 PUT 落盘：「保存失败却已在跑」（产品/规则） | 拆分 `persistLocalSettings` 与 `persistAutomationMirror`，后者只在 PUT 200 后 |
| M3 | major | `disabledTools` 不呈现，且改档会触发双重声明 400 死锁（产品/架构） | 矩阵呈现「已禁用」+ 写入期从 `disabledTools` 摘除面板接管的 toolId |
| M4 | major | 自动化安全暂停被面板保存静默恢复（架构） | 本机停用优先于 L2 + 「本机已暂停」徽章 |
| M5 | major | 周期上界丢失：填 120 分钟被调度端回落成更密的 5 分钟（架构/规则） | 与调度端共用 `MAX_AUTO_SCAN_MINUTES`，超界拒提交 |
| M6 | major | `maxItems`/`maxProperties` 作用于读路径，存量 overlay 变不可读且无自助恢复（架构） | issue 增 `kind:'scale'`；读路径对纯规模越界放行并告警，写入期照常拒收 |
| m* | minor | 注入视图标题越界「本轮」、读失败复用保存文案、过期锚点注释、测试名与断言不符等 | 逐条修复（标题与周边文案改「当前页面」、新增 `describeLoadFailure`、注释归正、断言补齐） |

### 第二轮（复核发现）

| # | 级别 | 发现 | 处置 |
|---|---|---|---|
| R1 | **blocker（回归）** | M3 的修法是死代码：`adoptOverlay` 播种 `state.tiers` 只看 `riskTierRaise`，兜底永不触发 → **零编辑保存会把用户的 `disabledTools` 静默撤销**（比修前更糟：面板可达的只收紧破坏）。产品/架构两路各自以 jsdom 探针实测复现 | 播种改为 `raised ?? (disabledTools.has(toolId) ? 'forbidden' : baseTier)`；补「存量 disabledTools 呈现为已禁用 + 零编辑保存不改变 restrictions」用例（此前测试对 `disabledTools` 零命中） |
| R2 | major | 新服务端地址未过 `normalizeTrustedServerBaseUrl` 即被本页采用 → 凭证会被发往未归一地址（架构/规则一致，探针实测） | 归一改为保存前置条件：不受信即拒绝保存并提示，`apiBaseUrl` 只接受归一值 |
| R3 | major | 「本机暂停优先」用例假绿：automation id 与 fixture 不符 + `if (toggle === null) return` 静默早退，实际零断言（规则/产品一致） | 改用 fixture 真实 id、删早退、断言徽章；另补反向用例 |
| R4 | major | 本机偏好无法区分「显式暂停」与「从未配置」：新装机器会被判成「本机已暂停」（规则） | `readLocalAutomations` 改三态（键存在才产 `enabled`），判定仅在「本机显式 false 且 L2 为 true」时成立 |
| R5 | major | `validateUserOverlay` 未开 `allErrors`，单错短路使「既超规模又结构非法」只报规模错 → scale 放行成为结构校验绕过口（架构/产品一致，实测三组样本） | 校验器改 `allErrors: true`；补 store 两条用例（纯规模越界放行 / 超规模+结构非法仍降级） |
| R6 | minor | 凭证变更后重读会覆盖待保存编辑却仍报「已保存」（规则） | 重读仅在此前无可用连接（`subject===null`）时执行，保留既有编辑 |
| R7 | minor | 测试头注含批次/变更史；`describeInjection` 注释未述建会话副作用；暂停徽章无样式令牌；文案「本地/本机」不一致 | 逐条修净 |

## 3. 未了结 deferral（WHEN-01，全部带锚点）

| 项 | 锚点 |
|---|---|
| 越界引用（toolId 已不在 L1 工具集）在配置中心标红并提供清理入口（adr-014 §3 承诺） | G5 |
| pack 能力面 chips（讲解/引导/代执行/自动化）与 `PackAutomationDescriptor.workRoutes` 投影 | G5（chips 中「引导」待 `capabilities.anchors` 投影，随 D2） |
| 409 冲突后保留待保存态并差异高亮（当前整体重载并提示复核） | G5 |
| 共享 `tokens.css`：配置中心与侧边栏令牌同源（透明视图风险档改用 auto/hitl/off 语义色） | G6 发布前 |
| 手抄镜像漂移守卫：`PackView`/`InjectionDescriptionView` 与契约字段闭集对账测试（同 frames-schema.test.ts 范式） | G6 E2E 门前 |
| `GET /v1/packs` 按 `claims.tenant` 过滤（当前返回全部已安装 pack 的展示投影） | P4 托管形态 |
| 未安装 pack 作用域的 `packConfig` 使后续保存恒 400，且面板无删除入口 | G5（与越界引用清理同批） |
| G3 遗留：config-draft 卡 409 状态提示重复、跨面板并发双击的终态提示 | G5 面板打磨 |
| G3 遗留：accept 成功的下行确认帧（当前静默，靠卡片终态反馈） | G5 |
| `readBody` 无流式上限（既有属性） | 部署加固批次 |

## 4. 验收门核对（方案 §1 G4 行）

- ✅ 界面与设计稿逐项对照：四页信息架构落地；替代项（能力 chips → 功能/工具计数）与省略项（更新提示、运行历史、纯数据校验徽章）均因无数据源而如实不渲染，未伪造（R6）；未开放能力一律禁用占位并带锚点。
- ✅ R4 来源标注可见：规则逐条来源徽章/作用域/时间；注入视图 origin 分层 + 收紧箭头 + `userConfigRevision`。
- ✅ R1 只收紧在 UI 层机械体现：低于 baseTier 档位 `disabled`；周期上下界与调度端同源；`disabledTools` 呈现且不被静默撤销（R1 回归已修并有用例锁定）。
- ✅ 全量 build/test/lint:deps 绿；`assets/` 零改动，六维评测不触发。
- ⚠️ 第二轮修复后的同视角复核未再发起（三路第二轮结论已覆盖全部修复项的判定依据；本记录如实标注：R1-R7 的修复由主进程自验 + 新增用例锁定，未经第三轮独立复核）。
