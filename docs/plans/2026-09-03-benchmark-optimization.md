# 2026-09-03 对标优化方案（B1-B7 批次编排）

> 日期：2026-09-03。基线 commit `ed634f0`，分支 `opt/2026-09-03-benchmark-optimization`。类型：操作指南（人读层）。
> 上游：改前审核 `../reviews/2026-09-03-audit-r1.md`（112 条发现、48 条 major 经三票反驳存活 40 条）；
> 对标研究 `../research/2026-09-03-benchmark-mechanisms.md`（129 张模式卡，adopt 49 / adapt 47 / reject 25 / 待裁决 8）。
> 方法沿用 `2026-08-04-l0-l3-orchestrated-implementation.md` §2 的批次模板与四支柱（契约驱动 → 测试驱动 → 独立评审 → E2E 门）。

## 1. 方案怎么定的

三路独立提案（治理优先 / 用户价值优先 / 工程健康优先）+ 三位独立裁判按五项打分（宗旨两问、U1-U8 与 R1-R9 合规、
风险与回滚、验证成本、价值/成本）。**三位裁判一致判「治理优先」胜出**（40 / 39 / 39 分，次优「用户价值优先」32 / 38 / 37）。
胜者的核心论证：页面采集与产品入口都在**扩大爆炸半径**，而今天承接这个半径的同意机制是空的——
授权卡上用户据以裁决的标题/摘要/计划 100% 由模型撰写，授权作用域的键是模型自己写的 task 字符串，
用户点「停止」在真实网关路径上到不了吊销函数，无人值守回合在服务端与人工回合完全同构。**先扩能力再补治理，等于先把注入的收益做大再去堵它。**

主会话从胜者综合，并嫁接了次优提案与裁判点名的可取项（下表「嫁接自」列）。裁判的**否决项**同样被采纳为纪律：

| 被否决的做法 | 否决理由（裁判复核后的事实） |
|---|---|
| 用「`ZA_APPLICATIONS_DIR` 缺省不装配」当作 A-SEC-01 的闭合 | `applications.ts` 全文无任何分账维度，默认关闭不等于隔离；必须真做 subject 分账 |
| 在评测批次之前放宽 `ZA-C-EVAL-02`（为「三跑等价一跑」让路） | 先放宽验证门、再产出用来论证放宽的证据，因果颠倒 |
| 只下发 `effects` 契约字段而不改插件渲染 | 契约层判据会全绿（schema 对账通过、字段已下发），但 A-SEC-02 完全未闭合，r2 会被假绿骗过 |
| 反向注入实验（临时把 riskTier 从 hitl 改 auto、让 toolgate 对 hitl 判 allow） | 无人值守下变异残留即治理被永久放宽，直接违 U7；本轮改用「判据变异 + 立即改回」的只读式有效性验证 |
| 以「建议在真实站点手工冒烟一次」作为计算样式可见性改造的唯一真实浏览器验证 | 无人值守会话不可执行；改为浏览器级 E2E 断言 |

裁判还复核出 r1 的一处**误报**：A-TEST-09 称 `release/verify-phase1.sh` 不存在——该文件实际被 git 跟踪且在仓（已核实）。
本方案不为该项安排修复，并在 r2 中如实标注「误报」。

## 2. 批次编排

顺序原则：**先让验证手段可信（B2）→ 再补治理决策链（B3）→ 再改采集与产品面（B5/B6）→ 韧性收尾（B4/B7）**。
B2 前置于一切的理由：`pnpm test:e2e`（默认 E2E 门）在 Phase 0 基线**即红**——`run-m1.mjs` 断言「职责范围/无关」，
而基座 2026-09-03 改通用助手后 mock 对该问句固定回 `MOCK-GENERAL-QA-HIT`，断言必然超时失败。
不先修它，后续每一批的「E2E 全绿」都不可信。

| 批次 | 主题 | 闭合 | 规模 | 需 ADR | 涉 assets |
|---|---|---|---|---|---|
| **B1** | 文档与红线校正 | A-DOC-02..18、A-ARCH-03/04/05/06、A-ASM-03/10、A-TEST-04、A-UX-09/15 | M | 否 | 仅 README |
| **B2** | 评测与 E2E 有效性 | A-TEST-01/05/06/08/09/14、A-DOC-16、PC-EVAL-01/05/06/08、G4-EVAL-01/02/06/07 | M | 否 | eval/scenarios |
| **B3** | 治理链路与内核归一 | A-ARCH-01/02、A-ASM-01、A-ORCH-06、A-SEC-01/02/03、A-GOV-01/03/04/05/08/09、A-PAGE-05、A-UX-04、PC-ORCH-06、PC-GOV-04/07/08/11、PC-GOVI-07、G1-02/03/04/06/08、G2-01/02/03、G3-06/10 | XL | 是 | 否 |
| **B4** | 编排韧性 | A-ORCH-01/02/03/05/08/11/12、A-ORCH-09/10、PC-ORCH-01/02/03/04/05/07/08/10、PC-CGB4-04/05/06、G3-09、G6-ORCH-01/02/03/05/06 | L | 否 | 否 |
| **B5** | 页面数据获取 | A-PAGE-01/02/03/04/06/07/08/09/11/12、PC-PAGE-01/02/03/04/06/07/08/09/13、PC-CGB1-02/04、PC-CGB2-04、PC-ORCH-11、G5-PAGE-01/03/04/06 | XL | 否 | 否 |
| **B6** | 用户塑形生效与可见 | A-SUP-01/02、A-UX-02/03、A-ASM-02、PC-CGB3-05/06、PC-PROD-06、PC-CGB2-02、PC-PROD-04、PC-CGB1-03 | L | 否 | 否 |
| **B7** | 收尾 | A-DOC-09、终态门、交付报告 | S | 否 | 否 |

### B1 文档与红线校正 ✅ 已完成（commit `16d551c`）

成功标准（全部已复验）：`grep -rn "MVP 只实现 client" .claude/ packages/*/src packages/*/schemas` 零命中；
`grep -n "U1-U7" docs/reference/01-architecture.md` 零命中且 §5 含 U8 小节；六份 ADR 状态行为「已接受」；
`lint:deps` + `build` + 单测 1241 例 + `eval` 88 组 ×3 跑全绿。

### B2 评测与 E2E 有效性（进行中）

**目标**：让「绿」这件事本身可信。没有可信的判据，后续批次的验收全部是空的。

| 项 | 内容 | 嫁接自 |
|---|---|---|
| T0 ✅ | `run-m1.mjs` 场景 e 断言由「职责范围/无关」改为 mock 哨兵 `MOCK-GENERAL-QA-HIT`（该哨兵仅在 system 含基座字面「通用助手」时产出，故同时证明基座已随装配到达模型） | 工程健康提案 B2，三裁判一致点名 |
| T0b ✅ | `scripts/verify-paths.mjs` + `verify:paths` 门：`verify:*` 引用的测试路径必须存在（vitest 对不存在路径静默零匹配，`verify:phase2` 曾长期引用两个已删文件而门仍全绿） | 同上 |
| T0c ✅ | `package.json` 补三个 mock-LLM E2E 入口（`test:e2e:explain-pack` / `:user-config` / `:automation`） | 同上 |
| T1 | 判据类型闭集 `judges: [{kind: substring｜token｜regex}]`，`token` 做词界匹配消除短词恒真 | PC-EVAL-01 |
| T2 | `expectDecisions` 治理事件判据：跑前记审计 sink 字节偏移、跑后只读该区间，按 toolCallId 聚合比对 verdict——「该弹卡而未弹 / 该拒而未拒 / 治理被绕过」变机器可判 | G4-EVAL-01 |
| T3 | 删 `HITL_DECISION_BY_SCENARIO` 硬映射，改 `expect.hitlVerdict` 数据驱动 | G4-EVAL-02 |
| T4 | 宿主 mock 带内存状态表 + `expect.hostState` / `hostCalls`，拒绝路径断言状态**未**变 | PC-EVAL-06 / G4-EVAL-06 |
| T5 | `PROBE_LITERALS` 集中登记 + `run.mjs --check`（不跑 LLM）：探针存在性 + 判据非空洞反向验证 | PC-EVAL-05 |
| T6 | 报告头写 `{commit, dirty}` + 输入哈希补 `examples/host-demo/config`；文件名去旧品牌 | PC-EVAL-08 |
| T9 | 补 automation 维度场景（该维度当前为零，其建立锚点已于 adr-019 落地时到期） | A-TEST-03 |

**纪律**：判据只能变严不能变松；若现有场景在新判据下变红，说明判据抓到真问题，**停下来分析并如实报告，禁改松判据凑绿**（ZA-C-HOW-05）。
有效性自证用「判据变异 + 立即改回」（改期望值看是否变红），**不做**改 riskTier 之类的治理变异。

### B3 治理链路与内核归一（最大批次）

**目标**：让「本回合无人在场」「用户已撤回」「批准是否仍然成立」「授权属于哪个站点」「用户看到的是不是将真正发生的事」
这五件事在服务端判定链上有确定语义。

| 项 | 内容 | 闭合 |
|---|---|---|
| G1 | `GateDecisionInput` / `IssueExecInstructionInput` 加可选 `unattended`（U3 加法）；自动回合传入；toolgate 对 unattended 回合的 hitl 档直接 `deny(reason: 'hitl-unattended')` 并落审计，不再依赖插件自动 reject | A-ARCH-02、A-GOV-03、A-ORCH-04、PC-ORCH-06 |
| G2 | `ToolGatePort` 加 `revokeHitlGrants(sessionId)`（纯数据入参，不塞回调）；`handleStop` 同步调用 | A-GOV-01、PC-ORCH-06 |
| G3 | **批准恢复执行前复核**：approve 之后、签发之前重跑分级 / L2 收紧终值 / 围栏 / dom 步骤校验，任一不过即拒绝并如实告知 | G1-02（r1 未抓到的新缺陷） |
| G4 | 任务级授权键由「模型自述 task 字串」改为服务端可验证指纹（`sessionId + packId + origin + task`） | A-GOV-02、G1-03/04/09 |
| G5 | `GateDecision` 回传 `sanitizedSteps`；网关据 `domContext` 把 ref 反解为 role/label 生成**机械摘要**随 `hitl-request` 下发；卡片渲染真实动作而非模型自述 | A-SEC-02、G1-06、PC-GOV-07、PC-GOVI-07 |
| G6 | `hitl-request` 加 `pack{packId,name,source}` / `tightenedBy` / `ttlMs`（服务端组装消毒）；卡片按 UI 规范五要素渲染；默认焦点落「拒绝」 | A-UX-04、G1-08 |
| G7 | 敏感控件闭集：`input:password` / `input:file` 目标的 read 拒绝、fill 强制 hitl 且不复用授权；客户端 `readValueOf` 对 password 返回掩码 | A-PAGE-05、PC-PAGE-05、PC-GOV-11 |
| G8 | 审计归因：`runTurn` 透传 run，`recordEvent` 一律带 `automationRunId`/`automationId`；副作用可能发生即先落在飞记录、取消改判终局；C5 `outcome` 闭集加「拒签未执行」与「已下发未归」 | A-GOV-03/04/06、G2-01/02/03 |
| G9 | 内核归一：`record_application`/`list_applications` 注入门由 `composed.packId !== null` 改为 pack 声明驱动；落盘按 subject（tenant + hostUserId）分账，复用 `user-config-store` 的 `encodeSegment` 口径 | A-ARCH-01、A-ASM-01、A-ORCH-06、A-SEC-01 |
| G10 | 治理态回收：会话 TTL 清理时同步回收 runtime / pendingHitl / nonce / grant / automationRuns；**回收失败 MUST 保留治理态**（nonce 墓碑仍在、重放仍被拒），不得「清不掉就当不存在」 | A-SEC-03、A-GOV-08、A-ORCH-10、G3-06/10 |
| G11 | 围栏在导航**落地后**重校验（捕 302 重定向逃逸） | PC-GOV-04 |

**ADR**：G1+G3+G4 属架构级语义变更，出 `adr-024-unattended-and-approval-revalidation.md`。

### B4 编排韧性

LLM 分层超时（total / firstChunk / idle，env 未设即完全不启用，等价性可断言）、`parallel_tool_calls:false` + 第 2..N 个调用回喂
`not-executed`、连续失败预算、未知工具/非法实参改同 toolCallId 的 tool 观测回喂、每轮请求前用已有 `pruneStaleSnapshots` 得请求视图、
`turn-complete.reason` 闭集、LLM 错误分类（`errorKind` 扩展 + `finish_reason=length` 如实告知截断）、
挂起等待器双轴超时、压缩失败两级降级 + 压缩输入过同一脱敏器。

### B5 页面数据获取

计算样式 + 尺寸可见性判定（jsdom 退化保可测）、accname 阶梯取代五级启发式、跨 collect 单调递增 + WeakMap 黏附 ref、
`elementsTruncated`/`elementsOmitted` 如实标注 + 视口优先配额、open shadow root 穿透、块级边界正文 + 多候选根、
回喂 URL 敏感参数脱敏、MutationObserver 静默窗、批次内页面变更守卫。

### B6 用户塑形生效与可见

`compose` 产出 `user-preferences` 与 `pack-config` 注入块（让 `verbosity` 与 `packConfig` 真正生效）、
面板上下文条的「本页生效」块（消费 `GET /injection`，含 reason 闭集与打开配置中心入口）、
右键 + 快捷键选区入口（选区在**服务端**拼接并加不可信标注）、409 改 rebase 保留待保存态。

### B7 收尾

HANDOFF 重写为本轮完成态、终态门、交付报告、r2 审核。

## 3. 本轮不做（诚实收缩，全部带锚点）

无人值守单会话不可能落地 96 个采纳项。以下明确不做：

| 项 | 锚点 |
|---|---|
| secret 保险库入站代入（PC-GOV-01/02/03、PC-GOVI-05、G1-07） | P3.5/P4：需 C7+C3+客户端存储三处扩展，且 SEC-02「平台零特权、不存用户凭证」的存储形态须先裁决 |
| 注入检测器管线（PC-GOVI-02）、参数来源污点（PC-GOV-12、PC-GOVI-04） | 定界与消毒（B3 未纳入的 PC-GOVI-01/PC-GOV-06）落地后仍出现注入失守时 |
| 不可信内容结构化定界（PC-GOVI-01、PC-GOV-06） | 与采集面同批做更合理；且是唯一触 `assets/system-prompt.md` 的项，独占一轮完整评测预算——下一轮改基座措辞时 |
| 站点权限档 / 用户级站点黑名单（PC-GOVI-03、PC-PROD-01/02、G3-04/05） | 首个外部用户试用前；与 A-ARCH-08（L0 运营者配置豁免）待裁决耦合 |
| 权限最小化注入（PC-GOV-10、G3-01/02/03） | P3 商店合规；需产品裁决（自动激活变点击激活） |
| 限流与并发上限（G3-07/08） | 对外部署/多租户前（三票判该面为 minor） |
| 批准项签名（G1-01）、审计事件树（G2-04/05） | HITL pending 持久化跨端恢复 / S4 审计独立服务 |
| pack 风险声明面与安装确认（PC-GOV-09、PC-PROD-05） | P3.5 pack 分发上线 |
| 快捷指令库、BYOK 多模型、会话历史（PC-CGB2-03、PC-CGB3-01、PC-PROD-03/07/08、PC-CGB4-01/02/03） | 待 Terry 裁决（产品形态增量） |
| 红队用例生成管线（G4-EVAL-03/05 完整版）、动作级判据（PC-EVAL-07 F1 部分） | 注入评测维度建立后 / dom 场景量足以支撑指标时 |

## 4. 待 Terry 裁决（8 项）

1. **R8 拒答边界的规范性改写**（A-UX-01、A-DOC-01、A-ASM-04/06）：2026-09-03 基座已改通用助手、拒答维度已退出评测，
   但产品形态文档 R8 仍以 MUST 要求「配置未覆盖明确拒答并指引安装对应 pack」，SSOT §1 第 1 档同。属定位级，本轮只同步可机械对齐的口径。
2. **注入透明视图的产品定位**（A-UX-02）：抽屉已在 `11454c4` 主动删除，但 R4 互证条款与北极星验收仍指向它。
   本轮 B6 只做面板上下文条内的最小「本页生效」块，R4 条文与验收措辞的修订待裁决。
3. **L0 运营者配置的 U4 豁免准则**（A-ARCH-08）：`ZA_GENERIC_ALLOWLIST` / `ZA_FULFILLMENT_*` 是快照与 L2 之外的第三类配置源，
   SSOT §4 未给显式豁免。
4. **履约语义进核心契约的取舍**（A-ARCH-04）：`CardInventoryPort` / `FulfillmentCoordinatorPort` 把电商发货/送卡语义固化进 C6。
5. 快捷指令库（L1 + L2 `quickActions`）是否进产品形态。
6. BYOK 多 provider 与会话历史列表的分期归属（P3.5 还是 P4）。
7. `ZA-SYS-04` 与 `ZA-SYS-01` 在 generic 页面的张力（A-ASM-06）：基座既要求「站点功能未覆盖即明确不确认」，又定位为通用助手。
8. 是否接受本轮未做项的锚点安排（§3 表）。

## 5. 每批次的共同验收门

1. `pnpm verify:paths`（新增）+ `pnpm lint:deps` + `pnpm -r build` + `pnpm -r --workspace-concurrency=1 test`，用例数不低于 Phase 0 基线 1241。
2. 命中的 E2E 子集（mock LLM）全绿；真实 LLM / 真实站点 E2E 一律标 **BLOCKED**（凭证在 SEC-03 读禁区内，不执行不伪造）。
3. 涉 `assets/` 的批次另跑 `pnpm eval` ≥3 跑。
4. 四视角独立评审（产品 / 架构 / 规则 / 对标）无未处置 blocker/major；评审记录落 `docs/reviews/2026-09-03-b<N>-*.md`。
5. 每一行 diff 可追溯到 r1 发现编号或模式卡编号。
