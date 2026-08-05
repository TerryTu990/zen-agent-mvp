# 匿名自动登录批次验收记录（adr-022）

> 批次：删手填令牌 + 删 `/demo-token` + 上匿名自动激活。日期：2026-08-06。
> 目标一句话：**插件装上就能用，用户一个字都不用填。**
> 本记录由独立验收 agent 撰写：**逐门亲自复跑，不采信实现方自述**；为让门变绿而改实现或断言属越界，未发生。
> 验收终态：`pnpm -r build` 0 错；`pnpm -r --workspace-concurrency=1 test` 全绿 **939 用例**
> （extension 256 / server 211 / contracts 211 / assembly 113 / toolgate 93 / 其余 55）；`pnpm lint:deps` 通过；
> E2E 三案例（M1 / Side Panel / G6-B+C）逐条实跑通过；`assets/` 零改动 → ZA-EVAL 六维评测**按规则不适用**（非"评测通过"）。

## 1. 批次改动面（实测 `git status --short` + `git diff --stat`）

变更 40 个已跟踪文件（+735 / −697），新增 8 个未跟踪文件（1196 行），删除 1 个文件：

| 面 | 文件 |
|---|---|
| 契约（新） | `packages/contracts/schemas/activation.schema.json`(51)、`src/activation.ts`(20)、`test/activation.test.ts`(127)；`src/index.ts` 导出、`test/schemas.test.ts` 齐备清单各 +1 |
| 服务端（新） | `apps/server/src/activation.ts`(54)、`test/activation.test.ts`(335) |
| 服务端（改/删） | **删** `src/demo-token.ts`；`gateway.ts`（激活路由前置于 verifier）、`index.ts`（`ANON_ISS` 无条件并入白名单）、`main.ts`（默认 iss、去 `ZA_DEMO_TOKEN_ENABLED`）、`test/server.test.ts`（−40 行） |
| 插件 | `src/identity.ts`（重写：installId + 激活 + 缓存/单飞/退避）、`background.ts`、`config-center.ts`、`options.ts`、`options.html`、`content.ts`、`messaging.ts`、`sidepanel.ts`；`test/identity-activation.test.ts`(421，新)、`test/options-config-center.test.ts` |
| E2E | 新 `scripts/e2e/anon-identity.mjs`(32)；10 个脚本去预置令牌（m1/m2/m3/m5、g6-explain-pack/user-config/automation/real-site、xianyu、sidepanel）+ `serve-acceptance.mjs` |
| 文档/发布 | 新 `docs/adr/adr-022-anonymous-auto-login.md`(156)；`docs/reference/00-design-brief.md`、`03-configuration.md`、`04-deployment.md`、`docs/adr/adr-014`（§1 修订横幅）、`docs/plans/2026-08-04-…`、`docker-compose.yml`、`release/{README.md,build-extension.sh,deploy-server.sh,remote/env.example}`、两份 `release/SKILL.md` |

`assets/` 零改动（`git status --short assets/` 为空）。

## 2. 逐门结果

| # | 门 | 结果 | 证据 |
|---|---|---|---|
| 1 | `pnpm -r build` | ✅ 绿 | 9 个 workspace 项目全 `Done`，0 错；extension 四个 bundle 产出（content 22.0kb / background 63.4kb / options 55.2kb / sidepanel 56.0kb） |
| 2 | `pnpm -r --workspace-concurrency=1 test` | ✅ 绿 | 9 包 60 个测试文件，**939 passed / 0 failed**（详见 §3） |
| 3 | `pnpm lint:deps` | ✅ 绿 | `依赖 lint（U2）通过：星形组装约束成立。` |
| 4 | E2E `run-m1.mjs` | ✅ 绿 | 退出码 0；6 条场景断言全 `[pass]`；`M1 E2E 全部场景通过 ✅` |
| 4 | E2E `run-sidepanel.mjs` | ✅ 绿 | 退出码 0；`Phase 1A Side Panel E2E 全部场景通过 ✅`（401 路径见 §4） |
| 4 | E2E `run-g6-user-config.mjs` | ✅ 绿 | 退出码 0；E2E-B 8 条 + E2E-C 5 条断言全 `[pass]`；`G6 E2E-B / E2E-C 全部断言通过 ✅` |
| 5 | 残留检查 | ✅ 绿（1 处应改未改，minor） | 逐处判定见 §5 |
| 6 | 改动面 / `assets/` | ✅ 绿 | `assets/` 零改动 → ZA-EVAL **不适用**；另有一处我自己造成的工作区副作用，见 F5 |
| 7 | secret 面 | ✅ 绿 | `git diff` 全量正则扫（JWT/`sk-`/UUID/`Bearer …`/`secret=`）无真实凭证；命中项全为显式假夹具（`eyJ-fake-…`、`za-test-secret`、`xianyu-e2e-*-fixture`）与 env **变量名** |
| 附加 | `pnpm eval`（非必须，`assets/` 未改） | ✅ 通过但暴露 F5 | 18 场景 3/3 全过、审计 384 条事件校验 PASS；`M4 评测全部通过 ✅` |

## 3. 用例增量核对（基线 866 → 939，+73，逐条对账）

| 包 | 基线（G6 记录） | 本批 | Δ | 增减来源（实测 diff） |
|---|---|---|---|---|
| extension | 237 | 256 | **+19** | 新增 `identity-activation.test.ts` 19 条；`options-config-center.test.ts` 删 5 条（令牌已配置/未配置/首装填凭证/凭证无效/轮换凭证）+ 增 5 条（身份只读指纹/身份未知不臆造/改地址即落盘/改地址后 401 三段状态/服务端不可达）= 净 0 |
| server | 190 | 211 | **+21** | 新增 `activation.test.ts` 23 条；`server.test.ts` 65→63（删 `P0-b demo-token 端点（env 门控）` describe 下 2 条） |
| contracts | 178 | 211 | **+33** | 新增 `activation.test.ts` 32 条；`schemas.test.ts` 113→114（`it.each(schemaFiles)` 随 `activation.schema.json` 自动多一条编译用例） |
| assembly / toolgate / 其余 | 113 / 93 / 55 | 113 / 93 / 55 | 0 | 未触及 |
| **合计** | **866** | **939** | **+73** | 19+21+33 = 73，与总数差额完全对上，无未解释增量 |

**减少的 2 条**在 `apps/server/test/server.test.ts`，是 `/demo-token` 端点的 env 门控与自签闭环用例——端点整条删除，用例随之删除属正当；且删除面并非零覆盖：`apps/server/test/activation.test.ts` 补了两条反向用例（无令牌 POST `/demo-token` → 401 不再免鉴权放行；带有效令牌 → 404 路由已删），删除本身有回归锁。

## 4. E2E 执行结果与覆盖判定

| 案例 | 覆盖意图 | 结果 | 实测证据 |
|---|---|---|---|
| `run-m1.mjs` | 基本闭环（零预置身份） | ✅ 退出码 0 | 6 条：a 讲解 / Side Panel 重开会话恢复 / service worker 重启会话恢复 / e 拒答 / b 换出 UI 面 / 服务端注入换出 order-list→order-detail |
| `run-sidepanel.mjs` | 401 路径 | ✅ 退出码 0 | 夹具收到激活请求签出 token#1 → 首个 frames 被拒 401 → 面板出「令牌/身份失效 + 草稿仍保留」→ 重新激活得 token#2 → 断言 `frameRequests[1].authorization === Bearer token#2`、与 `[0]` 不同、sessionId 换新、messageId 不变（幂等） |
| `run-g6-user-config.mjs` | 换 subject 语义 + L2 全链路 | ✅ 退出码 0 | E2E-B 8 条（teach 草稿零落盘→确认落盘 subject 由 claims 推导→注入→透明视图→配置中心收紧→收紧生效走签名指令→审计）+ E2E-C 5 条（overlay 不可读拆分降级、治理面 fail-closed、幻觉调用被拒、审计 `userConfigDegraded`、降级横幅） |

三案例均为真 Chromium + MV3 插件 + 仓库自带确定性 mock LLM，**未装载 `.env`、未用真实凭证**（SEC-03 未触碰）。
`run-g6-user-config.mjs` 通过 `scripts/e2e/anon-identity.mjs` 走与插件同一条 `POST /v1/activation` 取身份，
并以 `anonHostUserId()` 手抄镜像预置 subject 数据——镜像漂移会让预置数据挂不到实际 subject 上而**直接失败**，不构成假通过面。

### 4.1 主进程补跑（2026-08-06，覆盖 3/11 → 9/11）

验收 agent 只跑了任务指定的三个；其余被本批改动的脚本由主进程逐个实跑：

| 案例 | 结果 | 实测证据 |
|---|---|---|
| `run-m2.mjs` | ✅ 退出码 0 | `M2 E2E 全部场景通过 ✅`（引导命中 + 锚点失配如实降级） |
| `run-m3.mjs` | ✅ 退出码 0 | `M3 E2E 全部场景通过 ✅`（HITL happy / 拒绝 / 执行偏好三档） |
| `run-g6-explain-pack.mjs` | ✅ 退出码 0 | `G6 E2E-A / E2E-D 全部用例通过 ✅`（含 engines 拒载可见错误、知识型 pack 讲解） |
| `run-g6-automation.mjs` | ✅ 退出码 0 | `E2E-F 通用自动化 … 全部场景通过 ✅`（含 R7 无人值守写工具被拒 + 审计留痕） |
| `run-xianyu.mjs` | ✅ 退出码 0 | `闲鱼 Chromium E2E 全部场景通过 ✅`（happy path + 异常 path 零重试） |
| `run-m5.mjs` | ❌ **失败** | 前 4 条断言 `[pass]`，末条 `等待超时：停止演练：等待停止总结`。**已判定为先于本批既存**：`git stash` 全部改动后在未改动的 HEAD 上复跑，失败于**完全相同**的场景与断言（`/tmp/e2e-m5-head.log`）；两次带改动复跑亦稳定复现同一处，非抖动 |

`run-m5.mjs` 的失败与本批次无因果关系，但它现在是一条**已知红的回归线**：本批次对该脚本做了去预置令牌与固定端口 8787 的改动，其中 4 条断言的绿是本批实测的，末条断言的红在改动前后一致。

## 5. 残留检查逐处判定

命令：`grep -rn "za\.token\|demo-token\|demoToken\|DEMO_TOKEN" apps packages scripts docs release docker-compose.yml`

| 位置 | 判定 |
|---|---|
| `apps/extension/test/identity-activation.test.ts`（5 处）、`apps/server/test/activation.test.ts`（4 处） | **正当**：反向回归断言（源码不含 `za.token`/`za-cc-token`、运行期不读该键、`/demo-token` 404/401） |
| `docs/adr/adr-022-…`（多处） | **正当**：本批 ADR 记述被删形态 |
| `docs/adr/adr-014`（2 处）、`adr-020:16`、`docs/plans/2026-07-06-…`、`docs/reviews/2026-07-22-phase-4.md`、`docs/reference/00-design-brief.md:105` | **历史记述可保留**：adr-014 已加 adr-022 修订横幅指明形态换轨；其余为历史 ADR / 计划 / 评审记录，按"历史记录不追改"惯例保留 |
| **`docs/reference/01-architecture.md:67` 与 `:310`** | **应改未改（minor，见 F1）**：live 参考文档仍把 `demo-token` 列为 `apps/server` "内部六模块"之一，且未登记新模块 `activation` |
| `apps/server/dist/demo-token.*`（3 个） | **非残留**：`dist/` 已 gitignore；server build 脚本不 `rm -rf dist` 故本机留下陈旧产物，但无任何 import 指向；`.dockerignore` 排除 `**/dist` 且镜像在 builder 内从源码重建，**发布产物不会带上它**（已核对 `Dockerfile:8-15`） |
| `release/artifacts/**`（0.3.x / 0.4.0 各 dist）（大量） | **正当**：已发布版本的历史产物；`release/artifacts/` 已 gitignore，不入仓 |

附带核对 iss 同步点：`main.ts:103` 默认值 `ANON_ISS`、`docker-compose.yml:19`、`release/remote/env.example:31-33`、
`docs/reference/03-configuration.md:168`、`04-deployment.md` 全部指向 `zen-agent-anon`，
且 `index.ts:269` 把 `ANON_ISS` **无条件并入**白名单（覆盖或漏填 env 都不会让服务端拒绝自己签发的令牌）——与文档表述一致。
`apps/server/test/*.ts`、`scripts/evals/run.mjs`、`scripts/e2e/run-real-llm.mjs` 中残留的 `zen-agent-demo` **非残留**：
它们是"外部签发方"夹具，各自显式传 `ZA_JWT_ISS_ALLOWLIST`/`issAllowlist`（已逐个核对），`pnpm eval` 实跑通过佐证。

## 6. 验收发现与处置表

> 全部为我在验收中亲自复现的发现；**无 blocker，无 major**。按 HOW-03/职责边界，验收阶段不改实现，一律登记交主进程裁决。

| # | 级别 | 面 | 发现 | 处置 / 锚点 |
|---|---|---|---|---|
| F1 | minor | 文档一致性 | `docs/reference/01-architecture.md:67`（架构图注）与 `:310`（模块表）仍写 `apps/server` "内部六模块 … demo-token"。该模块已删、新增 `activation` 未登记。其余 live 文档（00/03/04、adr-014）都已同步，唯此文件漏改 | **已修**（主进程，2026-08-06）：两处 `demo-token` 改为 `activation`（模块表补注 adr-022） |
| F2 | minor | E2E 稳健性 | `run-sidepanel.mjs` 把夹具绑定到**固定端口 8787**（原为 `listen(0)` 随机口），与 `run-m1.mjs` 的 server 同址。本机跑着 dev server 或两脚本并行即 `EADDRINUSE` 失败 | **未修**：脚本注释已说明理由（须占用插件构建的默认服务地址，否则 SW 取不到身份），是有意取舍。锚点：下次改 e2e harness 端口约定 / 引入并行执行时改为「先占默认口失败即显式报错说明冲突」 |
| F3 | 观察（非缺陷） | 规格偏离 | D7 要求 `run-sidepanel.mjs` 的 401 用例「预置伪造 `za.anonToken`」；实现改为**不预置**——插件真实激活得 token#1，夹具对首个 frames 回 401，插件重新激活得 token#2 | **接受**：覆盖面严格强于 D7 字面（额外覆盖"401 后确实换了新令牌而非复用被拒令牌"）。主进程须知情该偏离 |
| F4 | 开放裁决 | 发布链路 | `release/remote/sign-token.sh` 与 `deploy-server.sh:67-68` 对它的同步**已无消费方**（管理员签发→用户粘贴流程全删）。该脚本以服务端白名单首项为 iss（现即 `zen-agent-anon`），故仍能签出任意 hostUserId 的可用令牌——即生产主机上残留一条与"只留一条路"相悖的备用身份入口（需 shell 权限，非新增可利用面） | **已裁决并处置**（主进程，2026-08-06）：删除脚本与 `deploy-server.sh` 的同步/授权两行；运维应急由匿名激活覆盖，不保留备用签发入口。adr-022 §7 已改写为该结论 |
| F5 | minor（**先于本批既存**） | 评测证据可复现性 | `scripts/evals/run.mjs:658-670` 的"评测输入 SHA-256"对 `evals/scenarios.json` + `examples/acceptance/` + `assets/` 做**全文件树**哈希，不过滤 gitignore。本机 `examples/acceptance/.DS_Store` 被计入 → 指纹跨机器不可复现。且仓库内报告最后提交于 `766ce1f`(2026-07-22)，而评测输入最后变更于 `d4a51c8`(2026-08-04)——**该报告在本批之前就已是陈旧证据** | **未修**（与本批无关）。锚点：下次改 `scripts/evals/run.mjs` 或 ZA-EVAL 证据口径时，让 `addTree` 过滤 gitignore 面 |
| F6 | 工作区副作用（我造成） | — | 我为取额外证据跑了 `pnpm eval`，它**重写了** `evals/runs/2026-07-22-commerce-phase2.md` 的证据环境行（输入 SHA-256 一行，+1/−1）。协作纪律禁止我做 git 写操作，故未 `restore` | **需主进程处置**：该行变更与本批次无因果关系（`assets/` 未改），建议 `git checkout -- evals/runs/2026-07-22-commerce-phase2.md` 后再提交，避免记录里出现无来由的证据指纹变更 |

## 7. 设计裁决（D1-D8）落地抽查

抽查而非穷举；每条给出我实际读到的位置：

- **D1 安装 id**：`apps/extension/src/identity.ts:56` `crypto.randomUUID()` → `chrome.storage.local['za.installId']`。无密钥对、无 IndexedDB、无签名 ✅
- **D2 单端点**：`gateway.ts:2669` 在 `:2672` 的 `verifier.verify` **之前**判定 `POST /v1/activation`；注释明写"有意不要求 authorization"；无 env 门控 ✅
- **D3 派生**：`activation.ts:36` `anon-${sha256(installId).base64url}`；`:47-52` claims 闭集 `tenant='anon' / roles=['user'] / sub=hostUserId / iss='zen-agent-anon'`；TTL 24h（`:18`）。模块**无任何存储态**，installId 不入 token 载荷 ✅
- **D4 缓存/刷新**：`identity.ts` 单飞（`state.inflight`）+ 指数退避（1s→60s 上限）+ 按 baseUrl 分账 + `generation` 计数防旧身份令牌复活 ✅
- **D5 删手填**：`options.html` 无任何 token/令牌字段（仅 CSS 设计令牌注释）；插件源码零 `za.token`/`za-cc-token`（由 `identity-activation.test.ts:405` 源码级断言锁住）✅
- **D6 删 demo-token**：文件删除 + 路由/选项/env 接线全删，反向用例锁住 404 ✅
- **D8 锚点**：adr-022 尾部 deferral 表四项均挂具体锚点；代码内未见无锚点 TODO（`za-bash-guard` 亦会在提交时扫）✅
- **SEC 面**：`identity.ts` 全文无 `console.*`；激活失败错误文案只写 `身份激活被拒绝（HTTP xxx）`，不带 installId/token；`activation.ts` 头部注释明写原值 MUST NOT 落盘/进日志/进响应 ✅

## 8. 未了结 deferral（每条挂锚点）

| 项 | 触发锚点 | 状态 |
|---|---|---|
| **Google 账号登录（OIDC）** | **正式投产前置条件**——面向真实用户投产（托管服务开放 / 商店正式发行）前 MUST 完成；实施期 P4。已登记于 `docs/adr/adr-022` deferral 表、`docs/plans/2026-08-04-generic-extension-productization.md` P4、`docs/reference/00-design-brief.md` 身份行 | 未了结 |
| 访问控制与用量配额（按 subject 限量） | P4 托管服务启动时，或匿名激活出现滥用信号（激活量异常）时 | 未了结 |
| 跨设备同步与 subject 迁移（匿名 overlay 归并入账号 subject） | Google 登录上线时（adr-014 §1 渐进绑定） | 未了结 |
| 「重置身份」按钮 | 与 subject 迁移同批；在此之前重置会孤立该 subject 的 L2 overlay | 未了结 |
| ~~F1 `01-architecture.md` 模块表同步~~ | — | **已了结**（主进程，2026-08-06） |
| F2 sidepanel E2E 固定端口冲突处置 | 下次改 e2e harness 端口约定或引入并行执行 | 未了结 |
| `run-m5.mjs` 「停止演练：等待停止总结」超时（先于本批既存，已在 HEAD 上对照确认，见 §4.1） | 下次改 dom 步进器停止语义或 M5 用例时 | 未了结 |
| ~~F4 `release/remote/sign-token.sh` 去留~~ | — | **已了结**：删除（主进程裁决，2026-08-06） |
| tenant'd pack 的 per-origin 宿主身份随本批失效（`claimsByOrigin` 无写入方，`{{hostUserId}}` 工具恒被拒；`packScope`/`setOriginClaims` 的 tenant 分支暂留） | pack 契约清理批次，或 Google 登录上线后重新定义站点级身份注入 | 未了结（已登记入 adr-022 deferral 表） |
| F5 评测输入指纹不过滤 gitignore | 下次改 `scripts/evals/run.mjs` 或 ZA-EVAL 证据口径 | 未了结 |

**已接受取舍（MUST NOT 当缺陷重提）**：匿名登录无持有证明——安装 id 泄漏即可冒充。Terry 已明确权衡裁决；
可核查项只有「不可枚举 / 不落盘 / 不进日志」三条，本次抽查（§7 SEC 面）未见违反。身份强度由 P4 Google 登录提供。

## 9. 诚实边界（哪些面没有证据覆盖）

- ~~**E2E 只跑了 3/11 个脚本**~~ **已由主进程补跑到 9/11**（2026-08-06，见 §4.1）。仍**未跑**：`run-g6-real-site` 与 `run-real-llm`——需真实凭证，受 SEC-03 凭证读禁区约束，不具备执行条件（与 G6 记录中 E2E-E 的 BLOCKED 口径一致），其正确性只有静态阅读支撑。
- **`serve-acceptance.mjs` 未启动验证**：只核对了源码中已无 demo-token 启用与自签令牌打印。
- **三视角只读评审记录不在我的证据范围**：我是验收 agent，未收到本批评审 agent 的输出。§6 的处置表只含**我自己复现的发现**；若主进程另跑了三视角评审，其发现须由主进程合并进本记录，不得视作本节已覆盖。
- **未做安全渗透验证**：`/v1/activation` 的抗滥用（无速率限制、无配额）只做了源码确认"确实没有"，未做压测或枚举实验；这与"访问控制后期再加"的裁决一致，但意味着**激活端点的滥用面零实测证据**。
- **未验证真实浏览器上的首装体验**：三个 E2E 都在受控夹具服务端上跑；"装上就能用"在真实部署（`agent.flash-api.com`）上的端到端表现，只有 `deploy-server.sh` 新增的冒烟 curl 作为发布期保障，**本次未实跑**。
- **用例增量对账依赖 G6 记录的基线分布**（extension 237 / server 190 / contracts 178 / …）。我未在本批 HEAD 上重跑基线（需 git checkout，属禁止的写操作），故 §3 的 Δ 归因来自「当前实测计数 − G6 记录基线」+ 逐 diff 核对；三项 Δ 之和与总数差额完全对上，可信但非同机重跑对照。
