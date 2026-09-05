# Zen Agent

可治理的浏览器通用智能体：在任意站点上回答问题、讲解与代操作页面、按需打开网页完成任务；
站点专属能力以站点包按需上架（生产快照当前只装通用包，闲鱼卖家等站点包见 `examples/site-packs/`）。

**双版本一句话**：MVP = 模块化单体 + Chrome 插件 + git 文件配置 + `client`/`server`/`dom` 三执行通道；
标准版 = 七系统独立部署 + 三形态客户端 + 配置中心——靠升级不变量 U1-U8
保证从前者平滑长成后者。（「Zen Commerce Agent」已降级为发行变体名，不再是产品/仓库身份。）

设计基准（SSOT）：`docs/reference/00-design-brief.md`；架构与升级路径：
`docs/reference/01-architecture.md`；契约总览：`docs/reference/02-contracts.md`；
决策记录：`docs/adr/`；分期计划：`docs/roadmap.md`。

## 结构

```
packages/
├── contracts/    # C1-C7 schema + TS 类型（零依赖底座，schema 为事实权威）
├── assembly/     # ② 装配引擎：快照读取、注入组合、describeInjection
├── toolgate/     # ③ 工具门禁：分级判定 fail-closed + 代执行指令签发/回收
├── llm-port/     # ④ LLM 接入：provider 白名单插拔
└── audit/        # ⑦ 观测审计：record-only 旁路 → .za/events.jsonl
apps/
├── server/       # 模块化单体组装点（唯一同时依赖全部包，U2）
└── extension/    # Chrome 插件（C3 接入层契约实现，零 @zen-agent 依赖、经 HTTP/SSE 通信）
assets/           # 生产快照：稳定基座 + generic-web 通用包
examples/host-demo/   # 静态 demo 宿主页 + 示例功能配置（开发与评测锚定样例）
examples/site-packs/  # 已下线的站点包（xianyu-seller / yinxiang），测试与评测继续覆盖
examples/acceptance/  # 多 pack 验收快照（e2e 输入；无 system-prompt.md，用它须另设 ZA_SYSTEM_PROMPT_PATH）
evals/            # 功能配置评测集（scenarios.json）与历史报告（runs/）
scripts/          # e2e 驱动、评测 runner、mock-llm、依赖 lint
release/          # 发布脚本与产物：服务端镜像 / 插件 zip / 远端 compose
```

模块间禁直接 import：只经 `@zen-agent/contracts` 类型 + 端口注入，组装唯一在
`apps/server`（U2）；端口出入参全部 JSON 可序列化（U1）。

## 工具链

Node ≥22 · pnpm workspace + catalog（typescript/vitest/zod）· TypeScript 全 ESM 严格
（NodeNext / strict / noUncheckedIndexedAccess / exactOptionalPropertyTypes）· vitest 串行。

## 命令速查

完整清单以根 `package.json` 的 `scripts` 为准。

| 命令 | 作用 |
|---|---|
| `pnpm install` | 安装依赖 |
| `pnpm build` | 全仓构建（`pnpm -r build`，按拓扑序） |
| `pnpm test` | 全仓测试（`pnpm -r --workspace-concurrency=1 test`，串行） |
| `pnpm lint:deps` | 依赖 lint（U2 星形组装约束，`scripts/lint-deps.mjs`） |
| `pnpm eval` | 功能配置评测（`scripts/evals/run.mjs`，报告落 `evals/runs/`；改 `assets/` 必跑，ZA-EVAL） |
| `pnpm eval --check` | 评测判据自检：不起服务端、不调 LLM，只查注入内容探针字面在位 + 每条场景判据可被证伪 |
| `pnpm verify:paths` | `verify:*` 门里显式列出的测试路径存在性自检（vitest 对不存在路径静默零匹配，路径写错＝门失效） |
| `pnpm test:e2e`<br>（`:m2` `:m3` `:m5` `:sidepanel` `:coldstart` `:d3`） | 分场景端到端脚本（`scripts/e2e/run-*.mjs`），各自拉起服务端并驱动扩展 |
| `pnpm test:e2e:explain-pack`<br>`pnpm test:e2e:user-config`<br>`pnpm test:e2e:automation` | G6 三个浏览器端到端（真实 Chromium + MV3 + 可编程 mock LLM）：讲解/pack 载入三态、L2 用户塑形、自动化触发 |
| `pnpm test:e2e:real` | 真实 LLM 上游的端到端（读仓外 `.env`，密钥不入仓） |
| `pnpm test:e2e:real-site` | E2E-E 真实站点主案例（`scripts/e2e/run-g6-real-site.mjs`）。**需真实 LLM 凭证 + 操作者已登录的站点/飞书页面会话**，由操作者本人运行、不在自动批次内；本轮未执行 |
| `pnpm verify:phase1:core` | 验证门核心：`lint:deps` + `build` + `test` + `eval` |
| `pnpm verify:phase1` | `:core` + `release/verify-phase1.sh`（真实 MV3 E2E、zip、amd64 镜像、回滚行为） |
| `pnpm verify:phase2` / `pnpm verify:phase3` | 更大范围验证门：契约/快照用例定点回归（phase2）、sidepanel e2e（phase3） |
