# G3 批次评审记录：P2.5-c L2 写入通道

> 批次：G3（L0-L3 实施方案 §1）。日期：2026-08-05。
> 流程：契约/用例先行（workflow 双路并行）→ 实现（server ∥ extension 双路）→ 三视角独立只读评审 →
> 修复回归 → **同视角复核受阻（见 §4，账号会话限额）** → 本记录 + commit。
> 验证基线：`pnpm -r build` 0 错；`pnpm -r --workspace-concurrency=1 test` 全绿
> （server 157 / extension 140 / contracts 146 / assembly 113 / toolgate 93，全仓 704 用例）；`pnpm lint:deps` 通过。

## 1. 批次范围（落地内容）

- **teach 草稿链路**：`config_draft` 内建工具（CONFIG_DRAFT_* 契约常量；引导全在工具 description，`assets/` 零触碰）→ 服务端构造条目与 change（客户端只回传 draftId+decision，U8 结构保证）→ `config-draft` 帧下行 → 面板确认卡 → `config-decision` 上行 → 合并 + 双校验（`validateUserOverlay` 含 configSchemas + `validateOverlayAgainstL1`）→ 落盘 → `user-config-write` 审计（origin=teach，写后全量快照）。
- **面板编辑面**：`PUT/GET /v1/user-config`（subject 一致性、同一双校验链、审计 origin=panel、可选 `?expectedRevision=` 乐观并发、来源归一、体积守卫）。
- **草稿创建期守卫**（评审后加固）：`"*"`+riskTierRaise 拒、featureId+riskTierRaise 组合拒、packId/featureId 不在快照拒、L1 只收紧预检（base 更严 / 未知 toolId 拒）、已 disabled 键过滤使「预览 = 落盘」。
- **extension**：`.za-config-card` 独立组件（summary + 人读作用域 + change 逐条预览 + 信任 microcopy + TTL 提示 + 终态区分文案）、终态/可重试失败区分（409/400 出历史 + 状态说明，网络/5xx 重放）。
- **G2 deferral 了结**：fs store 段编码大小写消歧后缀 + legacy 布局检测警示；`validateOverlayAgainstL1` 基线口径注释对齐。
- **新增端口方法**：`AssemblyPort.listConfigSchemas()`（U3 加法；写入期 packConfig fail-closed 表的唯一来源，替代硬编码 `{}` 的伪造面）。
- 测试：+38 用例（teach-flow 全链路含守卫与生命周期、user-config-write 端点矩阵、config-draft-card 卡片行为、fs store 消歧）。

## 2. 三视角评审发现与处置

三路去重后 **1 blocker 级缺口（无）+ 3 major + 12 minor**，全部修复；无带病放行项。

### 产品视角（R3/R4/R6 + 设计稿 + adr-014 §5/§8）

| # | 级别 | 发现 | 处置 |
|---|---|---|---|
| P1 | major | accept 先摘草稿后校验/落盘：存储瞬时故障或校验冲突时用户已确认的草稿永久失效，而 503 文案暗示可重试 | 摘除移到写入成功/reject 之后；`inFlight` 标记防并发双击；文案改「稍后可重试确认」；集成用例锁定「503 重试仍 503 而非 409」 |
| P2 | major | extension 对 409 终态错误一律 history-replay，形成「点击→409→重现可操作卡」死循环 | 改用 `deliver` 取 httpStatus：accepted/409/400 为终态（出历史 + 状态说明「草稿已失效…请重新让助手生成」），仅网络/5xx 重放 |
| P3 | minor | 卡片终态仅变暗，accept/reject 不可区分，缺设计稿的已保存态与信任 microcopy | 增 outcome 区（已保存 ✓ 可在配置中心修改或删除 / 未保存——仅本次会话按此执行）；reject 按钮改「仅本次会话生效」；增「对话不会直接修改你的配置」 |
| P4 | minor | `"*"` 作用域显示为字面 `*`；模型可填不存在的 packId 产惰性条目 | `"*"` 渲染「所有站点」；packId/featureId 不在快照 → 草稿期拒（`config-draft-unknown-scope`） |
| P5 | minor | 草稿 TTL 对用户不可见 | 卡片 microcopy 注明「草稿 10 分钟内有效」 |
| P6 | minor | PUT 整份覆盖无乐观并发控制（面板旧态可静默冲掉 teach 写入） | 增可选 `?expectedRevision=`，不符 409 不落盘 |
| P7 | minor | PUT 路径 origin/sourceSessionId 客户端自报，可伪饰 teach 来源 | 新增条目（id 不在当前 overlay）origin 归一为 manual + 剥离 sourceSessionId；既有条目原样 |
| P8 | minor | 消歧后缀改布局无迁移，存量静默孤儿化 | 架构路以 git 证据核实无发布存量（0.3.4 早于 G1/G2）；补 store 初始化 legacy 文件检测警示一次，不做迁移 |

### 架构视角（U1-U8 + 技术方案 §3.3）

| # | 级别 | 发现 | 处置 |
|---|---|---|---|
| A1 | major | `featureId` + `riskTierRaise` 同用时卡片 scope 显示 feature 级、实际收紧 pack 级全域——违反帧契约「scope 是 change 的机械投影」MUST | 草稿创建期拒（`config-draft-pack-level-restrictions`）+ 工具 description 修正「featureId 仅作用于 rules/facts；riskTierRaise 恒整 pack 生效、不可与 featureId 同用」 |
| A2 | minor | 先消费后校验 + 400 重放死卡（与 P1/P2 同源）；建议草稿期 L1 预检 | 同 P1/P2；另落 L1 只收紧预检（base 更严拒 `config-draft-not-tightening`、未知 toolId 拒 `config-draft-unknown-tool`） |
| A3 | minor | TTL 过期分支无用例；pendingConfigDrafts 惰性清理 | `ServerOptions.configDraftTtlMs`（缺省 10 分钟）+ 60ms TTL 过期 → 409 用例；会话终止清理挂锚点（§4） |
| A4 | minor | overlay 体积无上界（PUT 可膨胀每轮注入与审计快照） | PUT 增字节上限 128KB + 条目总数上限 500，超限 400 不落盘；schema `maxItems` 演进挂锚点（§4） |
| A5 | minor | 消歧改布局对开发机存量静默孤儿化 | 同 P8（legacy 检测警示） |

**架构视角核实通过项**（本批未改动）：U8 结构闭合（change 只存服务端、客户端帧 `additionalProperties:false` 仅 draftId+decision）、双校验禁旁路、`mergeDraftIntoOverlay` 只收紧（既有 forbidden 不降档、disabledTools 无草稿写入路径）、U1（`listConfigSchemas` 纯 JSON + structuredClone）、U7 闭集（409/400/503/401）、draft 消费经 `session.ownerSub === claims.sub` 属主门、审计 revision 取自 `store.write` 返回值、`describeInjection` 不带 subject 不破坏 L2 单次定格。

### 规则视角（CLAUDE.md + ZA 红线全集）

| # | 级别 | 发现 | 处置 |
|---|---|---|---|
| R1 | minor | `draftEntries` 注释含「（假设 2）」过程性溯源（HOW-08） | 删除，只留当前契约描述 |
| R2 | minor | 工具 description 对 featureId 语义误导（与 A1 同） | 同 A1 |
| R3 | minor | 合并期静默跳过已 disabled 键，但 change 预览仍展示该项（预览≠落盘） | 改为草稿创建期读当前 overlay 过滤 disabled 键（构造上保证预览=落盘）；全过滤空且无 rules/facts → 拒 `config-draft-empty` |
| R4 | minor | deferral 锚点归属（reject 留痕锚 G4 不对位）与仓库内未落盘 | reject 留痕改锚 G6（U8/C5 复查）；全部未了结项落盘于本记录 §5 |

**规则视角核实通过项**：`assets/` 零改动（EVAL-01/AGENT-01 守住，teach 引导确走工具 description）；U8/AGENT-04 无放宽面（config_draft 入参值域仅 hitl|forbidden、合并只升不降、disabledTools 无草稿写入路径、subject 一律 claims 推导）；两处既有测试改动为契约演进对齐非弱化（`server.test.ts:290` 语义从「帧未启用」演进为「通道未组装 fail-closed」；`:2465` 因消歧尾缀改经 store 端口预置，布局断言等价迁移至 store 测试）；新增测试过基线严格 flags `tsc --noEmit`；SEC 全假值、错误文案不带值。

## 3. 修复期新增测试（锁定修复语义）

`teach-flow.test.ts`：featureId+riskTierRaise 组合拒、未知 packId 拒、base=forbidden 声明 hitl 拒、TTL 过期 → 409、存储故障 accept → 503 且重试仍 503（草稿不被吞噬）。
`user-config-write.test.ts`：expectedRevision 三态（不符 409 不落盘 / 相符 200）、origin 归一（伪饰 teach → 落盘 manual 且无 sourceSessionId）、条目数超限 400 不落盘。
`config-draft-card.test.ts`：`"*"` → 「所有站点」、accept/reject 终态文案区分。

## 4. 流程偏差（如实记录，HOW-07）

三视角**初评全部完成并返回**（产品 2 major + 6 minor、架构 1 major + 4 minor、规则 4 minor），修复全部落地并经全量回归验证；但**同视角复核（SendMessage 续会话）三路均因账号会话限额中断**（`session limit · resets 12:50pm Asia/Shanghai`），未取得复核裁定。

处置：主进程对每项修复做了代码级自验（config-decision 时序、inFlight 复位路径、守卫分支、PUT 校验链顺序、extension 终态分支），并以 38 条新增/加固用例把修复语义锁进回归；**复核在限额恢复后补做，结论追加至本记录**。本批次因此标记为「修复完成、复核待补」，G3 commit 落地但任务保持在复核补做前不关闭。

## 5. 未了结 deferral（WHEN-01，全部带锚点）

| 项 | 锚点 |
|---|---|
| 三视角同视角复核补做 | 会话限额恢复后（本批次唯一未闭合流程项） |
| accept 成功的下行确认帧（当前静默，靠卡片终态反馈） | G4 配置中心/面板打磨时评估 |
| reject 草稿弃置的审计留痕（当前无事件） | G6（U8/C5 复查时裁决是否新增事件类型） |
| user-overlay schema 层 `maxItems`/`maxProperties` 契约演进（当前守卫在写入端点） | G4（面板编辑是同一端点消费方） |
| 会话终止时清理 `pendingConfigDrafts`（当前惰性清理 + TTL） | 会话生命周期治理项（与 pendingHitl 同批处理） |
| 模型臆造 packId 的噪音评估（当前草稿期已拒） | G6 E2E 门评测 |
| 关停轮审计 `disabledPackId` 追溯字段（G2 遗留） | G4 配置中心 UI |

## 6. 验收门核对（方案 §1 G3 行）

- ✅ E2E-B 走通（服务集成级）：草稿 → 确认 → 落盘 → 下轮 system 注入含规则 → `/injection` user-rules 同 id（origin=L2）→ 收紧后 auto 工具判 hitl 且零 exec-instruction → 审计三方 revision 互证。
- ✅ U8 红线复查：三视角均确认对话内容无绕过确认通道的写入路径（change 服务端单持、客户端零写入判定、双校验禁旁路）。
- ✅ 全量 build/test/lint:deps 绿；`assets/` 零改动，六维评测不触发。
- ⚠️ 同视角复核待补（§4）。
