# G2 批次评审记录：P2.5-b L2 合并链路

> 批次：G2（L0-L3 实施方案 §1）。日期：2026-08-05。
> 流程：契约/用例先行（workflow 双路并行）→ 实现（workflow）→ 三视角独立只读评审 → 修复回归 → 同视角复核 → 本记录 + commit。
> 验证基线：`pnpm -r build` 0 错；`pnpm -r --workspace-concurrency=1 test` 全绿
> （contracts 146 / assembly 113 / extension 130 / server 134 / toolgate 93，全仓 671 用例）；`pnpm lint:deps` 通过。
> 三路复核 agent 均独立复跑验证，数字一致；规则路另以基线严格 flags 对新增测试文件跑 `tsc --noEmit` 0 错。

## 1. 批次范围（落地内容）

- **UserConfigStore fs 实现**（`apps/server/src/user-config-store.ts`）：布局 percent-encode 确定性编码（任意字符集 subject 可定位、结构上无穿越面）、revision=sha256、lastGood 缓存 + stale 降级、无缓存类型化抛错、原子写（tmp+rename）。
- **assembly compose L2 合并**：每回合单次读取定格；注入序 L0 → sitesIndex → L1 feature/facts → L2 "\*" 全局 → L2 pack 级 → skills → docsIndex（blocks 逐条 origin/id）；riskTier 恒 max(L1,L2)；disabledTools 可见面移除 + descriptors 置 forbidden（幻觉调用兜底）；越界引用按 pack 全量工具闭集逐条失效（invalidRefs）；enabled:false 回落仅基座 + packDisabled 标注；故障拆分降级（rules/facts fail-open + 工具面全 forbidden 且可见面清空）。
- **toolgate 消费**：`GateUserConfigInput`（revision?/degraded?/effectiveTiers）max 钳制（入参只能收紧）；decide/issueExecInstruction/executeServer 三点同口径；degraded 轮 deny 理由 `user-config-unavailable` 与配置性 forbidden 可区分（R6）。
- **server 网关贯通**：subject 构造、L2 定格面冻结贯穿判定与签发（封 TOCTOU）、**buildSystemContent 拼入 userRules/userFacts**（facts 后、skills 前）、审计三事件带 revision/stale/degraded/invalidRefs/packDisabled/effectiveTier。
- **契约增量**（全部 U3 加法）：ComposeResult L2 字段族、InjectionBlock kind 增 user-rules/user-facts、`validateOverlayAgainstL1` 写入期只收紧校验、audit assemblyData/toolDecisionData 扩展。
- **U4 红线双源修订**：`.claude/rules/ZA-WHERE.md` WHERE-04 + 设计基准 §4 与代码同一 commit（了结 adr-014 §7 与 G1 登记锚点）。
- 测试：+44 用例（l2-merge 18 / overlay-l1-validation 7 / user-config-tiers 9 / fs store 8 / server L2 贯通与审计等）。

## 2. 三视角评审发现与处置

三路交叉印证同一 blocker；去重后 1 blocker + 5 major + 9 minor，全部修复，无带病放行。

| # | 级别 | 发现（视角） | 处置 |
|---|---|---|---|
| B1 | blocker | L2 个人规则从未进入实际 LLM 注入，而透明视图/审计按「已注入」口径输出（产品/架构/规则三路一致；实现 agent 未自报） | buildSystemContent 拼入 userRules/userFacts + server 贯通测试（capturing mock 断言 system 文本与条目 id、/injection 视图同 id 互证） |
| M1 | major | 每回合 compose/describeInjection 双读，破坏「单次读取定格」（产品/架构） | assembleFor 单次 compose，审计字段全从同一产出派生；/injection 保留独立实时视图语义 |
| M2 | major | invalidRefs 越界基线误用 feature 过滤面，合法跨 feature 收紧被误标（产品；规则/架构呼应） | mergeToolFace 改 pack 全量工具闭集基线（与写入期同口径）+ 跨 feature 回归测试 |
| M3 | major | enabled:false 网关侧归属失真 + 防幻觉附注缺失（产品） | PackRef 改由 composed.packId 构造；packDisabled 标注入 ComposeResult 与审计（schema/TS 同步） |
| M4 | major | degraded 哨兵 'storage-failure' 冒充 revision hash，两事件表达分裂（规则 major/架构 minor） | GateUserConfigInput.revision 可选 + degraded 标志；toolDecisionData 增 userConfigDegraded；两事件同缺省同标注 |
| M5 | major | fs store 默认启用却零直测；toolgate 签发点重校验无用例（规则/架构） | fs store 8 用例 + toolgate issue/executeServer/degraded 理由 4 用例 |
| m1-m9 | minor | deny 理由不可区分（产品）、degraded 可见面未清空（架构）、tool-decision 只记静态 riskTier（架构）、非原子写（架构）、invalid-subject 与故障耦合（架构）、revision「恒有值」注释失实（产品）、测试不过严格 tsc（规则）、config-draft 一致性注释、$comment 措辞 | 全部修复：user-config-unavailable 理由、可见面清空、effectiveTier 审计字段、tmp+rename 原子写、percent-encode 解耦、注释修正、显式类型 |

**同视角复核结论**：产品 6/6 RESOLVED、架构 8/8 RESOLVED、规则 6/6 RESOLVED + 增量扫描确认修复期新增 diff 无新 blocker/major（测试改动核实为强化非弱化）。

## 3. 过程说明

- 阶段一/二由 workflow 编排（契约路+用例路并行 → 实现路）；契约路同批落 U4 红线修订。
- 实现 agent 自报 3 项未了结项，其中 2 项（哨兵 revision、fs store 无直测）被评审升格为 major 并在本批了结；1 项未自报缺口（B1）由三路评审独立发现——三视角机制的价值实证。

## 4. 未了结 deferral（WHEN-01，全部带锚点）

| 项 | 锚点 |
|---|---|
| 写入端点暴露（`UPSTREAM_ACCEPTANCE['config-decision']=false` → handler、`PUT /v1/user-config`） | G3（P2.5-c） |
| fs 布局大小写不敏感文件系统上的 subject 大小写碰撞消歧（规则路复核既有边缘面） | G3 写入通道落地时一并处理 |
| 关停轮审计补 disabledPackId 追溯字段（产品路复核备注：配置中心展示「已关停 pack 的会话」时需要） | G4 配置中心 UI |
| validateOverlayAgainstL1 基线注释「跨 pack 全局闭集」与合并期 pack 闭集的口径说明（产品路备注，无放宽面） | G3 写入端点消费该函数时对齐措辞 |
| test 目录 typecheck 门（防严格 TS 漂移，规则路建议非承诺项） | CI 门禁就位时（与 lint:deps 纳 CI 同锚点，ZA-C-WHERE-02） |
| L2 导出 / subject 迁移 / Google 登录等 | 沿 adr-014 既有锚点（P3.5 / P4），本批未触碰 |

## 5. 验收门核对（方案 §1 G2 行）

- ✅ 单测矩阵全绿（§4 示例矩阵全覆盖：riskTier 合并 / 越界逐条失效 / "\*" 作用域 / 故障语义两分支 / revision 定格 / 双用户隔离 / 注入序 / enabled 关停 / 频率下限写入期校验）。
- ✅ 故障语义两分支在 compose 层（mock store）与真实 fs store 层双重验证。
- ✅ 全量 build/test/lint:deps 绿；未涉 assets/ 改动，六维评测不触发。
- ✅ U4 红线修订与实现同一变更提交（adr-014 §7 履约）。
