# HANDOFF — zen-agent-mvp（MVP 完成态，2026-07-04）

> 面向：在本目录续作（标准版分期 S1-S4，或接真实 LLM/宿主）的下一个会话/开发者。
> 事实权威：代码、各 `.schema.json`、`docs/reference/00-design-brief.md`（SSOT）。本文件是过程性交接，可随标准版开工归档。

## 一、这是什么、到哪了

嵌入式**功能辅助智能体**平台（ToB 内部系统）：按用户当前功能（featureId）动态装配规则/事实/skills/工具集，
提供功能讲解、UI 引导、API 调用协助。源起 zen-flux-mvp 架构对谈，**复制已验证模式与契约、不共享代码**（adr-005）。

**MVP 全部完成（M0→M4）**，四条能力端到端闭环、六道门全绿：

| 里程碑 | 能力 | 关键实现 |
|---|---|---|
| M0 奠基 | 治理/契约/骨架 | ZA 红线 + hooks、C1-C6 schema + 端口、文档/ADR×9 |
| M1 讲解闭环 | URL→featureId→装配→流式问答 | assembly 装配引擎、llm-port(+mock)、server SSE 网关、extension 对话 UI |
| M2 引导 | guide-action 高亮/滚动 | built-in guide_highlight 工具（不经 toolgate）、extension page-action（D9 闭集） |
| M3 代执行+HITL | 分级判定→挂起确认→一次性签名→页面代执行→回喂 | toolgate 三方法、server 多轮 loop + 挂起恢复、extension 代执行+HITL 卡片 |
| M4 审计+评测门 | 全链路事件 + 五维度评测 | audit jsonl sink（record-only 旁路）、server 五类事件埋点、eval runner |

## 二、验证现状（本机实跑，2026-07-04，Opus 4.8）

- `pnpm -r build` 绿（8 workspace）；`pnpm -r --workspace-concurrency=1 test` **195 测试全绿**
  （contracts 54 / assembly 20 / audit 5 / llm-port 21 / toolgate 21 / server 36 / extension 38）。
- `pnpm lint:deps` 绿（U2 星形组装）。
- `pnpm test:e2e` / `:m2` / `:m3` 全绿（真 Chromium 加载 MV3 插件 + 确定性 mock LLM + host-demo 全链路）：
  讲解 a / 换出 b / 引导 c / HITL 代执行 d（happy+拒绝+forbidden）/ 拒答 e。
- `pnpm eval` 绿：13 场景 × 3 跑全 3/3（讲解/引导/工具/HITL/拒答五维度）；审计完整性 PASS（事件链齐、全过 schema、无 secret）。
- 三反例分层：拒绝+forbidden 浏览器 E2E；nonce 重放/ttl/invalid-result toolgate 单测 + server 集成（见 `evals/runs/2026-07-04-m3.md`）。

## 三、命令速查

| 命令 | 作用 |
|---|---|
| `pnpm build` / `pnpm test` / `pnpm lint:deps` | 全量构建 / 串行单测 / 依赖 lint |
| `pnpm test:e2e` `:m2` `:m3` | 浏览器 E2E（真实插件 + mock LLM，headless 检测不到扩展自动回退 headed） |
| `pnpm eval` | 协议层评测 runner（五维度 ≥3 跑 + 审计完整性），报告落 `evals/runs/` |

真实 LLM 端点走 `.env`（`ZA_LLM_BASE_URL/ZA_LLM_API_KEY/ZA_LLM_MODEL`），永不入仓（SEC）。
server 启动必需 env：`ZA_JWT_SECRET` / `ZA_SIGNING_SECRET`（缺失拒启）/ `ZA_SNAPSHOT_ROOT` 等，见 `apps/server/src/main.ts`。

## 四、必须内化的约束（违反即返工）

- **U1-U7 升级不变量**（`.claude/rules/ZA-WHERE.md`）：端口只传 JSON 可序列化值；模块禁横向 import、apps/server 唯一组装点（lint:deps 硬验）；`execution` 闭集 client|server（MVP 只实现 client，server 枚举保留）；配置=版本化不可变快照；接入层五能力不随形态变；审计 schema 独立于落点；决策永远服务端 fail-closed + 代执行指令一次性签名。
- **两层治理别混**：开发期 `ZA-*` 红线约束开发；运行期治理在 `assets/`（ZA-SYS/ZA-FEAT），MUST NOT 进开发会话。
- **改 assets/ 或示例功能配置/mock 必跑评测**（`pnpm eval`，ZA-EVAL）；≥3 跑判回归。
- **hooks 已挂载**：za-secret-guard（secret 明文/凭证闭集）、za-bash-guard（禁 --no-verify + commit 暂存扫描）、za-verify-on-stop。

## 五、未竟事项与锚点（均有界，无隐藏坑）

| 事项 | 现状 | 触发锚点 |
|---|---|---|
| LLM 仅确定性 mock，未接真实 provider | eval/E2E 用 mock 保确定性；真实讲解质量未评 | 接真实 provider 时以 `pnpm eval` 换 `.env` 端点复跑（框架已就绪） |
| `LlmMessage` 无 assistant `tool_calls` 回声字段 | 端口冻结，MVP 由 mock 凭末条 role:tool 观察驱动总结 | 接真实 provider 时评估给 `LlmMessage` 加可选 `toolCalls`（加法兼容） |
| C3 帧三处编码（schema/contracts TS/extension frames.ts）无自动 drift 校验 | 头注释声明同步义务，已手工保持一致 | 契约进入高频变更期时引入 codegen |
| `assets/` 根无生产 manifest（开发/E2E 以 `examples/host-demo/config` 为快照根） | `assets/README.md` 说明理由（无实体功能则 manifest 必被 fail-closed 拒载） | 首个生产功能配置落地时补 |
| toolgate NonceStore / server SessionStore 为内存实现 | 接口已按"可外置设计"包一层 | S4 状态外置（Redis/DB） |
| 代执行回合无 turn 级超时（客户端不回 exec-result 则该回合挂起） | toolgate ttl 管 nonce 侧过期；SSE 心跳保活 | 标准版按需加回合超时兜底 |
| server `execution:'server'` 直调通道未实现（U3 枚举保留） | toolgate 遇非 client 通道 fail-closed 拒绝 | 标准版 S1 服务端直调通道 |
| DOM 自动化替点（填表/点按钮）不做 | D9 裁定：引导高亮 + API 代执行覆盖主价值 | 标准版后按真实需求评估 |
| `.claude/skills/` 仅占位 README | 零投机移植 | 各自锚点见该 README |

## 六、下一步：标准版分期（roadmap §标准版，S 线按客户需求可调序）

- **S1 服务端直调通道**：toolgate 补 `execution:'server'` 执行器；改一个字段即从 client 切 server，agent/网关/客户端零改动。
- **S2 配置中心**：git 文件 → 后台 UI + 版本化发布 + 发布评测门（继承 eval runner）；assembly 零改动（U4 同构验证点）。
- **S3 多形态客户端**：补嵌入 SDK / 浏览器壳，同一 C3 契约（U5 验证点）；server 零改动。
- **S4 七系统拆分 + 状态外置**：端口→RPC（U1）；先拆 ④ LLM 接入；会话/nonce 状态外置；审计 jsonl→DB（U6）。

续作参照 zen-flux-mvp 同构实现（模式级、禁复制粘贴遗留术语），路径见 `docs/reference/01-architecture.md`。
