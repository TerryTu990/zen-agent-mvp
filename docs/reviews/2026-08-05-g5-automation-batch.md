# G5 批次评审记录：L3 自动化泛化

> 批次：G5（L0-L3 实施方案 §1）。日期：2026-08-05。
> 流程：契约/用例先行（workflow 双路）→ 实现（server ∥ extension）→ 三视角独立只读评审 → 修复回归 → 本记录 + commit。
> 验证基线：`pnpm -r build` 0 错；`pnpm -r --workspace-concurrency=1 test` 全绿
> （extension 215 / contracts 176 / server 173 / assembly 113 / toolgate 93 等，全仓 825 用例）；`pnpm lint:deps` 通过；`assets/` 零改动。

## 1. 批次范围

- **平台内建模板闭集**（`packages/contracts/src/automation-template.ts`）：v1 只含 `page-watch`；`readOnly` 为字面量 `true`（可写模板无法被静默引入，须先扩类型并显式实现放行分支）。
- **用户自建触发器契约**（adr-021）：`user-overlay.watches`（≤5 条，`additionalProperties:false`）+ `validateWatches`（templateId 闭集 / URL 可解析且协议闭集 / 参数过模板 paramsSchema / id 唯一）+ `validateOverlayAgainstL1`（与 pack automation id 撞名拒收）。
- **R7 只读底线的结构强制**：`resolveWatchRun` 三态；只读轮 `llm.chat` **不传任何 tools**，页面要素由服务端 `snapshot-request` 直取；越界调用 deny 并落 `unattendedReadOnly` 审计。
- **报告收口**：首轮建基线不报告；无变化只留审计不打扰面板；有变化产摘要报告。
- **extension**：watch 实例解析、描述符派生与 pack 描述符合并调度；配置中心自动化页补上 G4 置灰的「新建触发器」。
- 测试：+43 条（contracts 21 / server 6 / extension 16）；`scripts/mock-llm` 加法哨兵分支驱动确定性越权路径（三路核实为纯加法、既有用例零回归）。

## 2. 三视角评审发现与处置

三路去重后 **6 major + 12 minor**（无 blocker）。核心是两处 fail-open 与一组 R6 失真。

| # | 级别 | 发现（视角） | 处置 |
|---|---|---|---|
| M1 | major | **未知 `automationId` 在无人值守下回落普通回合**：拿到完整 dom 工具面（含 auto 档写类页面操作），R7 失守。可达路径：跨设备删除 watch 后本机缓存仍触发、L2 降级读缺该实例（架构，规则同源） | `none` 分支改 fail-closed：既不在 L1 pack automation 闭集也不在 `overlay.watches` 的 automationId 一律 403；降级读（stale）下未解析实例返 503 |
| M2 | major | **基线先于报告成功推进**：报告轮失败则已检出的变化被吞掉且永不再报，叠加失败即暂停 → 变化永久丢失（架构） | 基线推进移到报告成功之后；失败轮保留上轮基线，同一变化下轮仍会被检出 |
| M3 | major | **变化检测观测面不含正文**，而主用例（价格/库存）多为普通文本 → 永远「无变化」，且与真无变化不可区分（产品） | 基线纳入页面提示文本（notices，快照已采集）；观测面限制如实写入模板 description、面板 hint 与 adr-021「后果·负」，并挂锚点（正文级比对随首个需要它的模板立项） |
| M4 | major | **文案不实**：模板与面板称「按周期只读打开目标页」，而平台从不新建页面，只复用已打开且已入会话组的页（产品/规则一致） | 文案统一改为「按周期读取你已打开并加入会话组的目标页…平台不会自动新建页面」；adr-021 新增「关键前提」段披露该约束及其对 R9 兑现度的限制 |
| M5 | major | **watch 复用 pack 自动化的自我关停语义**：找不到工作页即本机置 `enabled=false` → 新建触发器在首个周期自杀（规则/产品一致） | watch 派生描述符跳过关停（只跳过本轮）；pack 自动化保持原语义（用户已离开工作流即停） |
| M6 | major | **基线不按被监测 URL 归并 + 工作页按路径前缀匹配** → 同 origin 的其他页面被当作被监测页，产生虚假「新增/消失」报告（产品；规则指出服务端判定还宽于客户端） | 基线键纳入实际快照 URL；`isWatchWorkPage` 改为路径精确相等（watch 指定的是一个页面而非路由族，比客户端段边界语义更严） |
| m1 | minor | 周期上界两端分叉（契约 1440 / 调度端 60），且超界实例会拦下整页保存（产品/架构） | 契约上界收到 60 与调度端对齐（只收紧）；adr-021 同步 |
| m2 | minor | `unattendedReadOnly`（adr-021 指定的 R7 机械证据）零用例覆盖（架构） | R7 用例补断言（已验证该字段确在发射） |
| m3 | minor | 报告失败时已确证的变化摘要被整条丢弃（产品） | 失败分支透传摘要：「检出变化但报告生成失败：<摘要>；已暂停」 |
| m4 | minor | `watchBaselines` 无逐出、无 TTL（架构/规则） | 加 LRU 上界（500 条）；多实例语义与重启后行为写入 adr-021「后果·负」并挂锚点 |
| m5 | minor | adr-021 §3 称「工具面只保留只读内建能力」，实现是完全不传 tools（文本比实现宽）（架构） | ADR 改写为「不下发任何工具定义；页面要素由服务端 snapshot-request 直接获取」 |

## 3. 未了结 deferral（WHEN-01，全部带锚点）

**本批新增**

| 项 | 锚点 |
|---|---|
| 变化检测的正文文本级比对（当前只比对可交互要素/表格单元格/dl 项/提示文本/标题） | 首个需要正文比对的模板立项时 |
| 比对基线的持久化与多实例语义（当前进程内 + LRU，重启后首轮重建基线不报告） | 托管形态多实例上线时（迁至共享存储） |
| 触发器运行可见性：每条 watch 的「上次运行 / 结果」与设计稿的运行历史表（当前长期沉默无法区分「无变化」与「已被暂停」） | G6 前的面板打磨（数据可取自本机 storage） |
| watch 与 pack automation 撞名的两端处置不一致（客户端保留 pack、服务端 watch 优先），且 pack 升级后新增同名 automation 不再被任何环节发现 | 两端统一为「撞名即拒绝调度」——随 pack 导入/升级链路（P3.5） |
| `automationRunId`/`automationId` 审计归因目前只落 watch 轮，pack 自动化轮未透传 | 与 adr-019 自动化审计归因一并处理（G6 审计面复查） |
| watch 自动回合的审计仍以 `tool-execution` + `execution:'server'` 承载（并非工具执行，会污染 server 通道统计） | G6 审计面复查（评估新增 `automation-run` 事件类型） |
| `triggerAutoScan` 忽略投递结果，瞬时存储故障会使单飞锁悬挂到下一周期并触发暂停 | G6 前的调度健壮性收口 |
| **E2E-F 浏览器级 runner**（本批只到服务集成级；`scripts/e2e` 下无对应脚本） | **G6**（G6 workflow 已含 E2E-F 驱动 agent） |

**G4 记录中锚定 G5 的六项——本批未了结，重新登记**（三路规则视角要求不得失锚）

| 项 | 新锚点 |
|---|---|
| 越界引用（toolId 已不在 L1 工具集）在配置中心标红并提供清理入口 | G6 前的面板打磨 |
| pack 能力面 chips 与 `workRoutes` 投影 | G6 前的面板打磨 |
| 409 冲突后保留待保存态并差异高亮 | G6 前的面板打磨 |
| 未安装 pack 作用域的 `packConfig` 使后续保存恒 400 且无删除入口 | G6 前的面板打磨 |
| config-draft 409 提示重复、accept 成功的下行确认帧 | G6 前的面板打磨 |
| `disabledTools` 表达被保存改写为 `riskTierRaise:'forbidden'`（可见性意图降级） | G6 前的面板打磨 |

## 4. 验收门核对（方案 §1 G5 行）

- ✅ R7 无人值守底线用例：只读轮不下发工具定义、越权写调用 deny 且落 `unattendedReadOnly`、全程无 `exec-instruction`/`hitl-request`；未知/未启用/非只读模板一律 fail-closed。
- ✅ 通用页面监测模板对任意 URL（不绑 pack）可用；用户自建触发器契约（adr-021）立案并了结 adr-019/adr-020 的「用户自建触发器契约」锚点。
- ✅ 全量 build/test/lint:deps 绿；`assets/` 零改动，六维评测不触发。
- ⚠️ **E2E-F 浏览器级未跑**：本批到服务集成级为止，浏览器级 runner 移交 G6（见 §3）。据此 G5 的验收门「E2E-F 走通」**未完全满足**，如实记录，不以「已完成」标注该项。
- ⚠️ 三视角同视角复核未发起（修复由主进程自验 + 新增/加固用例锁定）；G6 前如限额允许应补做。
