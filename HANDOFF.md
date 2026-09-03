# HANDOFF — zen-agent-mvp（对标优化轮完成态，2026-09-03）

> 面向：在本目录续作的下一个会话/开发者。
> 事实权威：代码、各 `.schema.json`、`docs/reference/00-design-brief.md`（SSOT v2）。本文件是过程性交接。
> 上一份交接（2026-07-04 MVP 完成态）的内容已并入本文；其未竟事项表逐条在 §5 给出现状。

## 一、这是什么、到哪了

**可被用户塑形的浏览器 agent harness**（「浏览器 agent 的 Claude Code / AI 时代的 Tampermonkey」）：
在任意站点上叠加 agent，按 `packId`/`featureId` 动态装配规则、知识、工具面与自动化，提供四档能力（信任阶梯）——
讲解（看）/ 引导（指）/ 受控代执行（做）/ 自动化（托管）。
源起 zen-flux-mvp 架构对谈，**复制已验证模式与契约、不共享代码**（adr-005）。

**当前分支**：`opt/2026-09-03-benchmark-optimization`（未合并到 main）。
本轮做了一次完整的「整体审核 → 机制级对标 → 分批优化 → 改后审核」，产物见 §4。

## 二、验证现状（本机实跑，2026-09-03，Opus 5）

| 门 | 命令 | 结果 |
|---|---|---|
| 依赖 lint（U2） | `pnpm lint:deps` | 绿 |
| 验证脚本路径自检 | `pnpm verify:paths` | 绿（新增：`verify:*` 引用的测试路径必须存在，防 vitest 静默零匹配） |
| 构建 | `pnpm -r build` | 绿（9 workspace） |
| 单测 | `pnpm -r --workspace-concurrency=1 test` | **1462 例全绿**（Phase 0 基线 1241，本轮 +221） |
| 评测 | `pnpm eval` | 89 组场景 × 3 跑全过；审计完整性 PASS |
| 评测判据自检 | `node scripts/evals/run.mjs --check` | 绿（探针在位 + 89 条判据均可被证伪） |
| 浏览器 E2E（mock LLM） | `test:e2e` `:m2` `:m3` `:d3` `:coldstart` `:automation` `:explain-pack` `:user-config` | **八项全绿** |

**已知未绿（如实记录）**：

- `pnpm test:e2e:sidepanel` **红**。它在 Phase 0 基线 `ed634f0` **就已经红**（基线失败点是 401 阶段
  「重试未使用重新激活的令牌」，现在推进到 404 阶段「重试改变了 messageId」）。
  主会话诊断：404 会话失效后的重试请求**根本未发出**（夹具帧序列只有 3 条、第 4 条缺失），
  而面板已清空草稿并显示本地回显——用户会以为消息已发送。按「卡住即停」纪律停止深挖，
  锚点：下一轮或专项修复（这是真实产品缺陷，不是脚本问题）。
- `pnpm test:e2e:real`（真实 LLM）与 `test:e2e:real-site`（真实站点 + 飞书）**BLOCKED，未执行**。
  凭证位于 `ZA-C-SEC-03` 的读禁区内，开发期不得装载，本轮未绕过、未伪造。
  解除命令见 `docs/reviews/2026-08-05-l0-l3-delivery-report.md` §2.2。
- `scripts/e2e/run-real-llm.mjs` 已在 B9 补上对新判据（judges / mockOnly / automation 维度）的兼容，
  但**因需要真实凭证而无法实跑验证**，只做了语法检查。

## 三、命令速查

| 命令 | 作用 |
|---|---|
| `pnpm build` / `pnpm test` / `pnpm lint:deps` / `pnpm verify:paths` | 构建 / 串行单测 / 依赖 lint / 验证脚本路径自检 |
| `pnpm eval` / `node scripts/evals/run.mjs --check` | 协议层评测（≥3 跑 + 审计完整性）/ 判据自检（不跑 LLM） |
| `pnpm test:e2e` `:m2` `:m3` `:m5` `:d3` `:coldstart` `:sidepanel` `:explain-pack` `:user-config` `:automation` | 浏览器 E2E（真实插件 + mock LLM） |
| `pnpm test:e2e:real` / `:real-site` | 需真实凭证，**BLOCKED**（SEC-03） |

服务端启动必需 env 见 `apps/server/src/main.ts`；全表见 `docs/reference/03-configuration.md` §4
（本轮新增 `ZA_LLM_TIMEOUT_MS` / `ZA_LLM_FIRST_CHUNK_MS` / `ZA_LLM_IDLE_MS` / `ZA_MAX_CONSECUTIVE_FAILURES`，
均为**未设即完全不启用**）。密钥永不入仓（SEC）。

## 四、本轮做了什么（B1-B9 九个批次）

产物：改前审核 `docs/reviews/2026-09-03-audit-r1.md`、对标研究 `docs/research/2026-09-03-benchmark-mechanisms.md`、
优化方案 `docs/plans/2026-09-03-benchmark-optimization.md`、改后审核 `docs/reviews/2026-09-03-audit-r2.md`、
交付报告 `docs/reviews/2026-09-03-optimization-delivery-report.md`；新 ADR：adr-024（无人值守收口与批准复核）、adr-025（基座通用化补记）。

| 批次 | 主题 | 关键改动 |
|---|---|---|
| B1 | 文档与红线校正 | ZA-C-WHERE-03「MVP 只实现 client」改为两通道均已实现 + adapter 分形；U1-U8 与 C1-C7 口径统一；六份已落地 ADR 转「已接受」 |
| B2 | 评测判据有效性 | judges 闭集（词界匹配消除子串恒真）、expectDecisions（读审计事件判治理）、宿主状态判据、PROBE_LITERALS + `--check` 自检、automation 维度从零补起 |
| B3a | 治理决策链 | 无人值守服务端收口（不再依赖插件自动 reject）、停止吊销授权、**批准恢复期复核**、授权作用域指纹、治理态回收 |
| B3b | HITL 卡真实性 | 卡上改为呈现服务端从净化终值反解的真实动作（此前全部取自模型自述）、R4 五要素、默认焦点落「拒绝」、敏感控件闭集 |
| B3c | 审计归因与内核归一 | 归因键透传、停止路径补记执行结局、C5 outcome 加两值、内建工具改 pack 声明门控 + 按 subject 分账、围栏落地重校验 |
| B5 | 页面数据获取 | 计算样式可见性、accname 阶梯、ref 跨快照黏附、截断如实标注、shadow DOM 穿透、正文块边界、URL 脱敏、DOM 静默窗 |
| B6 | 用户塑形生效与可见 | L2 偏好与 packConfig 真正进注入（此前写入后零消费）、面板「本页生效」块、右键选区入口 |
| B4 | 编排韧性 | LLM 分层超时、并行 tool_calls 不丢弃、失败预算、观测裁剪、错误分类、终止原因闭集、压缩降级 |
| B8 | r2 修复 | 处置改后审核查出并经三票验证存活的 8 条新问题（含停止后剩余调用仍分发的回归） |
| B9 | 收尾 | 真模型评测通路兼容、HITL 等待上限、验证脚本入口与头注、HANDOFF/ADR/UI 规范同步 |

## 五、必须内化的约束（违反即返工）

- **U1-U8 升级不变量**（`.claude/rules/ZA-WHERE.md`）。本轮的全部契约变更都是 **U3 加法**（新字段可选、新端口方法），
  旧调用点不传即维持基线行为——续作请保持这个纪律。
- **两层治理别混**：开发期 `ZA-*` 红线约束开发；运行期治理在 `assets/`（ZA-SYS/ZA-FEAT），MUST NOT 进开发会话。
- **改 `assets/` 必跑评测**（`pnpm eval` ≥3 跑，ZA-EVAL）。
  **改基座措辞前先 grep `scripts/mock-llm/server.mjs` 的 `PROBE_LITERALS`**（22 条，每条带 sourceFile）——
  mock 以基座字面为探针，改字面即评测假红；禁靠改探针把红评测改绿。
- **hooks 已挂载**：za-secret-guard / za-bash-guard / za-verify-on-stop。
- **C3 帧有三处编码**（schema / `packages/contracts/src/client-access-layer.ts` / `apps/extension/src/frames.ts`），
  改一处必须三处同步，`apps/extension/test/frames-schema.test.ts` 会逐帧属性集对账。

## 六、未竟事项与锚点（全部有界）

### 6.1 本轮遗留（优先级最高）

| 事项 | 锚点 |
|---|---|
| `test:e2e:sidepanel` 红（404 重试请求未发出，基线即红、本轮推进一个阶段） | 下一轮开工时优先专项修复 |
| 真实 LLM / 真实站点 E2E 未执行（BLOCKED） | 提供凭证与已登录 profile 后按 §2 解除命令执行 |
| `run-real-llm.mjs` 的新判据兼容未经实跑验证 | 同上 |
| **8 项待 Terry 裁决**（R8 拒答边界改写、注入透明视图定位、L0 运营者配置的 U4 豁免、履约语义进核心契约等） | 见交付报告 §6 与 adr-025 §决策待定项 |

### 6.2 r2 标记为 partial 的必修项（12 条，均有具体缺口描述）

见 `docs/reviews/2026-09-03-audit-r2.md` 的逐镜头销项表「还差什么」列。其中值得优先的：
`record_application` 仍未进 describeInjection 与 L2 收紧面（A-ARCH-01/A-ASM-01）、
`snapshotEpoch` 已落 domContext 但复核/watch 快照仍不同步 `domContext`（A-PAGE-04）。

### 6.3 上一轮（2026-07-04 / 2026-08-05）未竟事项的现状

| 原事项 | 现状 |
|---|---|
| C3 帧三处编码无 drift 校验 | **已了结**：`frames-schema.test.ts` 逐帧属性集对账 |
| `assets/` 根无生产 manifest | **已了结**：registry 登记 generic-web；`assets/README.md` 本轮重写为当前事实 |
| 代执行回合无 turn 级超时 | **部分了结**：B4 补了 LLM 分层超时与失败预算；HITL 等待上限见 B9 |
| toolgate NonceStore / SessionStore 内存实现 | 仍是内存；B3a 补了尺寸上界 + 高水位驱逐与会话逐出回收。锚点 S4 状态外置 |
| server `execution:'server'` 通道 | **早已实现**（本轮把红线与契约注释的过期表述改正） |
| DOM 自动化替点 | 已由 adr-011 落地（dom 可见步进） |
| `.claude/skills/` 仅占位 | release skill 已存在；README 本轮改为如实描述 |
| 配置中心可用性十项（G6 §4.3） | 本轮闭合「打开配置中心入口」与「叫法统一」两项；其余锚点仍是「首个外部用户试用前」 |

## 七、下一步建议

1. **修 `test:e2e:sidepanel`**（唯一一个红的门，且是真实缺陷）。
2. 把 8 项待裁决交 Terry，尤其 R8——它决定知识型 pack 的产品叙事。
3. r2 的 12 条 partial 里挑「进 describeInjection」与「domContext 同步」两条收口（都是本轮改动的残余面）。
4. 若要发布：先补 `apps/extension/manifest.json` 版本递增，再走 release skill；本轮**未发布**，生产仍是上次发布的版本。
