# HANDOFF — zen-agent-mvp 奠基期交接（2026-07-04）

> 面向：在本目录续作开发的下一个会话/开发者。读完本文件 + 下方"阅读顺序"前两篇即可开工。
> 本文件是过程性交接文档，M1 完成后可归档或删除；事实权威以代码、各 `.schema.json` 与 `docs/reference/00-design-brief.md` 为准。

## 一、这是什么项目、从哪来

嵌入式**功能辅助智能体**平台（ToB 内部系统）：按用户当前所在功能（featureId）动态装配规则/skills/工具集，提供功能讲解、UI 引导、API 调用协助。

源起：2026-07-04 在 zen-flux-mvp 会话中的架构对谈（可行性 → 多用户架构 → 客户端形态与执行通道 → 双版本定调），全部结论已收敛进 `docs/reference/00-design-brief.md`（奠基期 SSOT）。与 zen-flux-mvp 的关系是**复制已验证模式与契约、不共享代码**（adr-005）。

## 二、当前状态（M0 奠基已完成）

- ✅ 产出 88+ 文件：治理资产（ZA 红线 + hooks）、C1-C6 契约（5 schema + 端口类型）、架构文档/ADR×9/roadmap、可编译骨架、示例配置。
- ✅ 验证全绿（本机实跑）：`pnpm -r build`、`pnpm -r --workspace-concurrency=1 test`（5 包）、`pnpm lint:deps`（U2 星形组装）。
- ⚠️ **git 仓库已 init 但零 commit**——续作前先审阅并做首个 commit。
- 骨架各包实现体均为 `NOT_IMPLEMENTED` 占位 + roadmap 分期锚点，属预期状态（M0 范围声明见 SSOT §10），不是伪完成。

## 三、阅读顺序

1. `docs/reference/00-design-brief.md` — **SSOT**：双版本定义、七系统边界、U1-U7 升级不变量、C1-C6 契约清单、D1-D9 决策。
2. `CLAUDE.md` — 开发期红线摘要 + 治理分层 + rules/hooks 索引（新会话自动加载）。
3. `docs/roadmap.md` — 分期与验收；下一期是 **M1 讲解闭环**。
4. 按需：`docs/reference/01-architecture.md`（三条关键时序）、`02-contracts.md` + `packages/contracts/schemas/`（契约权威）、`docs/adr/`。

## 四、必须内化的约束（违反即返工）

- **U1-U7 升级不变量**（`.claude/rules/ZA-WHERE.md`，MVP→标准版平滑升级的全部保证）：端口只传 JSON 可序列化值；模块禁横向 import、apps/server 唯一组装点（`pnpm lint:deps` 硬验）；`execution` 闭集 client|server（MVP 只实现 client、server 枚举保留）；配置=版本化不可变快照；接入层五能力契约不随形态变；审计 schema 独立于落点；决策（riskTier/HITL）永远服务端 fail-closed + 代执行指令一次性签名（nonce/ttl/signature）。
- **两层治理别混**：开发期 `ZA-*` 红线约束开发行为；运行期治理在 `assets/`（ZA-SYS-NN 基座 / ZA-FEAT-NN 功能规则，两位编号，单一源 `ZA-C-AGENT-02`），MUST NOT 进开发会话。
- **hooks 已挂载**（`.claude/settings.json`）：za-secret-guard（secret/凭证闭集拦截）、za-bash-guard（禁 --no-verify + commit 暂存扫描无锚点 TODO）、za-verify-on-stop（未验证提示）。commit 里出现无锚点 TODO 会被拦，deferral 一律挂 roadmap 分期锚点。
- **改 `assets/` 必跑功能配置评测**（`ZA-EVAL`）；评测集锚点=首个功能配置进入验证时（M1），建成前人工走查。

## 五、遗留事项（均有界，无隐藏坑）

| 事项 | 状态 | 锚点 |
|---|---|---|
| `assets/` 根缺 manifest.json 实体（布局仅 README + examples 例证） | 已裁决可接受 | M1 装配引擎接入时补 |
| C3 消息帧三处编码（schema / contracts TS / extension frames.ts 手抄镜像）无自动 drift 校验 | 头注释已声明同步义务 | 契约进入高频变更期时引入 codegen |
| `.claude/skills/` 仅占位 README（7 项候选各挂触发锚点） | 零投机移植，按需再搬 | 各自锚点见该 README |
| 首个 git commit | 未做 | 人审阅后 |

## 六、下一步：M1 讲解闭环（roadmap 有完整验收）

范围：`packages/assembly` 装配引擎（读 `examples/host-demo/config` 快照 → resolveFeature(url) 服务端权威判定 → compose 注入 + describeInjection 同源自省）+ `apps/server` SSE 网关最小闭环 + `apps/extension` 对话 UI + `packages/llm-port` 首个 provider。
验收：插件对 demo 宿主页完成"URL → featureId → 装配 → 讲解问答"闭环；开工前先按 ZA-EVAL 定本期验收对话。

实现时优先参照 zen-flux-mvp 的同构实现（模式级参照，禁复制粘贴后遗留其术语）：装配换出见其 `packages/harness/src/session.ts`（composeFlowInjection / before_agent_start 整段覆写、禁 message append）、工具门禁见 `phase-tools.ts`（tool_call 拦截、禁 setActiveTools 路线）、provider 插拔见 `apps/server/src/gateway/llm.ts`、事件旁路见 `events.ts`。
