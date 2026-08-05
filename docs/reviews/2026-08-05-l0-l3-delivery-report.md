# L0-L3 编排实施最终交付报告

> 执行 SSOT：`docs/plans/2026-08-04-l0-l3-orchestrated-implementation.md`。日期：2026-08-05。
> 范围：G1→G2→G3→{G4∥G5}→G6 六批次。**结论：G 线全部完成，发布门未全绿，未发布。**

---

## 1. 各批次结果与 commit 清单

| 批次 | commit | 结果 | 三视角处置 |
|---|---|---|---|
| G1 契约层（P2.5-a） | `eea555f` | ✅ | 6/6 RESOLVED + 同视角复核；修复期增量扫描的 1 新 minor 当场了结 |
| G2 L2 合并链路（P2.5-b） | `28369b5` | ✅ | **1 blocker**（L2 规则产出但从未进实际 prompt）+ 5 major 全修；产品 6/6、架构 8/8、规则 6/6 复核 RESOLVED |
| G3 L2 写入通道（P2.5-c） | `5726d8b`、`f9c05d7` | ✅ | 3 major + 12 minor 全修；三路复核 8/8、5/5、4/4 RESOLVED |
| G4 L0 + 配置中心 UI | `a474211`、`445c54d` | ✅ | **1 blocker**（首装自锁）+ **1 回归 blocker**（`disabledTools` 静默撤销，比修前更糟）+ 11 major；三轮复核全 RESOLVED |
| G5 L3 自动化泛化 | `8fcf0d9` | ✅ | 6 major 全修；**同视角复核当批未发起**，于 G6 补做（§3.2） |
| G6 E2E 门 | `5aa6e01`、`60e403f`、`b87ff87`、`a3d7a9e`、`f11552e`、`832aa39`、`360b0dd`、`846a0d0` | ✅ 收敛 | **1 blocker**（`automationId` 未上行）+ 7 major + 11 minor；四轮同视角复核，末轮三路一致「无 blocker/major，可收敛」 |

全部 commit 在本地 `main`，**未 push**。

## 2. 验证证据索引

### 2.1 全量验证（每批次均跑，以下为终态）

| 项 | 命令 | 结果 |
|---|---|---|
| 构建 | `pnpm -r build` | 0 错 |
| 测试 | `pnpm -r --workspace-concurrency=1 test` | **866 全绿**（extension 237 / server 190 / contracts 178 / assembly 113 / toolgate 93 / audit 5 / card-inventory 10 / fulfillment 8 / llm-port 32） |
| 依赖 lint | `pnpm lint:deps` | 通过（U2 星形组装成立） |
| assets 改动 | `git diff --stat eea555f~1..HEAD -- assets/` | **空** |

用例数自 G 线基线 825 增至 866（+41）。`assets/` G 线全程零改动，故 **ZA-EVAL 六维评测不触发**——这不是「跑过并通过」，是「按规则不适用」。

### 2.2 E2E 案例集（方案 §6）

驱动脚本均为真 Chromium + MV3 extension + 真 gateway/assembly，LLM 走仓库自带确定性 mock；harness 签名密钥每次运行进程内随机生成，仓库不留固定串。

| 案例 | 结果 | 驱动 | 证据 |
|---|---|---|---|
| A 讲解与拒答 | ✅ | `scripts/e2e/run-g6-explain-pack.mjs` | `.za/e2e/e2e-evidence/e2e-a/` |
| B L2 全链路（8 条断言） | ✅ | `scripts/e2e/run-g6-user-config.mjs` | `.za/e2e/e2e-evidence/e2e-b/` |
| C 治理故障语义（5 条断言） | ✅ | 同上 | `.za/e2e/e2e-evidence/e2e-c/` |
| D pack v2 载入（D1/D2/D3） | ✅ | `run-g6-explain-pack.mjs` | `.za/e2e/e2e-evidence/e2e-d/` |
| **E 真实站点主案例** | ❌ **BLOCKED，通过次数 0** | `scripts/e2e/run-g6-real-site.mjs`（**从未执行**） | 无 —— `e2e-e/` 目录不存在 |
| F 通用自动化 R7 | ✅ | `scripts/e2e/run-g6-automation.mjs` | `.za/e2e/e2e-evidence/e2e-f/` |

A/B/C/D/F 在每一轮修复后均逐条复跑，终态全绿。

**E2E-E 阻塞原因（如实）**：需真实 LLM 密钥与飞书运行时凭证；凭证位于测试根 `.env`，而 `za-secret-guard`（ZA-C-SEC-03 凭证读禁区）拦截任何指向该文件的装载命令，SEC-03 明示解释器拼接属已知残余面须自守，故**未绕过、未执行、未伪造通过**。

解除条件：
```
node --env-file=<测试根>/.env scripts/e2e/run-g6-real-site.mjs --runs=3
```
另需 `ZA_E2E_FEISHU_SHEET_URL` 指向目标表格、`ZA_E2E_PROFILE_DIR` 指向已登录 goofish 与飞书的持久化 profile。

### 2.3 评审记录

`docs/reviews/2026-08-05-g{1,2,3,4,5}-*.md` + `2026-08-05-g6-e2e-gate.md`（后者含 §4.1–§4.6 六路评审与四轮同视角复核全量处置表）。

## 3. 三视角评审处置记录（跨批次要点）

### 3.1 机制本身的产出

三视角独立评审多次抓出实现 agent 未自报、且单元测试无法暴露的问题：

- **G2**：「L2 规则产出但从未注入实际 prompt」由三路独立发现——功能看起来完整，实际用户定制永远不生效。
- **G4**：`disabledTools` 的修法是死代码，导致零编辑保存会静默撤销用户禁用（**比修前更糟**）；产品与架构两路各自以 jsdom 探针独立复现。
- **G6**：`automationId` 从未随上行帧送达服务端 → adr-021 的 R7 无人值守只读强制**从真实客户端整条不可达**。827 用例全绿、build 0 错，只有浏览器级 E2E 才暴露。
- 规则路多次抓出**假绿测试**（断言恒真、早退、id 与夹具不符）与**记录与代码不符**。

### 3.2 G5 同视角复核（补做，方案 §5 要求在此了结）

| 条目 | 合并裁定 |
|---|---|
| M1 未知 automationId fail-closed | PARTIAL → 判定本体成立，但三路一致指出：G5 提交时该分支在真实客户端上是死代码，故 G5 记录的 ✅ 在服务集成级为真、产品级为假 |
| M2 基线推迟到报告成功后 | RESOLVED |
| M3 观测面纳入 notices + 限制披露 | PARTIAL → 处置表称的三处披露只兑现 ADR 一处，两处面向用户的文案都没写；G6 补齐 |
| M4 文案不实 | RESOLVED |
| M5 watch 跳过自我关停 | PARTIAL → 原路径闭合，但自我关停另有四处入口 |
| M6 基线归并 + 工作页匹配 | PARTIAL → 只收紧了服务端，客户端仍前缀匹配；G6 修正 |

复核另查出 3 条 major（客户端/服务端语义分叉致触发器自杀、基线键过度分区致永不报告、三条修复零回归锁），均于 G6 处置。

### 3.3 G6 四轮同视角复核的收敛轨迹

每一轮都查出**上一轮的修复本身不成立**，这是本次交付最值得记录的事实：

| 轮次 | 查出的失效形态 |
|---|---|
| 一轮 | 错误谓词被原样搬进新逻辑（`tool-decision.verdict === 'approve'` 不在闭集内，断言恒失败）；oracle 与面板渲染器互斥；非 503 一律永久停用（回归） |
| 二轮 | 语义反转把「漏报」换成「误报」（归一丢弃 query/hash 致不同页共用基线）；解码后重拼致 key 碰撞；只改半句的注释留下病灶本体 |
| 三轮 | 把「没看成」记成「看过没变」（判否记 `ok`，而该审计行是运行历史「无变化」的数据源） |
| 四轮 | 断言在两种世界里结果相同（「基线未被污染」锁不住）；新增契约成员 schema 侧零覆盖 |
| 末轮 | **三路一致：无 blocker/major，可收敛**；条目 1/2/3 由变异实测证明断言可证伪 |

主进程亦独立复跑两个变异确认：把判否改回 `settle('ok')` → outcome 序列断言红；把工作页判定挪到基线推进之后 → 「无变化」断言红。

## 4. 未了结 deferral 清单（WHEN-01，全部带锚点）

### 4.1 阻断发布

| 项 | 锚点 |
|---|---|
| **E2E-E 真实站点主案例未执行，通过次数 0** | **发布前必须了结**；依赖真实凭证与已登录 profile，不可顺延 |
| E2E-E 未验证点：闲鱼/飞书要素能否被通用 DOM 快照定位；若不足须为飞书补 pack（走 L1 载入校验），**不得放宽 generic 工具面** | E2E-E 首次实跑时裁决 |
| E2E-E `snapshotRoot` 指向 `examples/acceptance`（`assets/` 无 generic 兜底 pack），走的不是发布快照 | E2E-E 实跑前裁决 |
| E2E-E 的 `countListItems` 对「模型输出表格」或「整轮多个列表」退化为 fail-closed 失败 | E2E-E 首次实跑时裁决 oracle |

### 4.2 自动化链路（用户可直接感知）

| 项 | 锚点 |
|---|---|
| 自我停用还有两处入口未按「瞬时故障不停用」收口（`forward(contextMessage)` 失败、真失败轮）；三条停用提示无恢复指引；pack 自动化自我关停完全无通知 | 下一次改插件调度链路时 |
| `triggerAutoScan` 忽略投递结果 → 单飞锁悬挂到下周期并触发暂停 | 同上 |
| 站点自有来路参数（`from=`/`scm=`/`share_source=`）使 watch 每轮判否，而跳过轮不打扰面板 → 用户看到长期沉默 | 触发器运行可见性落地时 |
| 变化检测观测面不含普通段落正文（价格类主用例可能永久沉默；已在面板 hint 如实披露） | 首个需要正文比对的模板立项时 |
| 比对基线为进程内状态 + LRU：重启后首轮重建不报告；多实例下重复/漏报 | 托管形态多实例上线时（迁共享存储） |
| 跳过轮（`outcome:'skipped'`）尚未在运行历史呈现——该视图本身未实现 | 随触发器运行可见性一并落地 |
| `decideAutoScanDelivery` 只吃 `httpStatus`，三个不同 HTTP 调用的 403 塌成同一信号 | 部署形态引入前置代理时 |

### 4.3 配置中心可用性收口（锚点统一为**首个外部用户试用前**）

原锚「G6 前面板打磨」随 G6 结束失效，已在方案 §9 登记为具名批次。十项：越界引用标红 + 清理入口、pack 能力面 chips 与 `workRoutes` 投影、409 冲突保留待保存态、未安装 pack 作用域 `packConfig` 使保存恒 400 且无删除入口、config-draft 409 提示重复与 accept 下行确认帧、`disabledTools` 被改写为 `riskTierRaise`、触发器运行可见性、HITL 卡标注收紧来源、共享 `tokens.css`、**插件无「打开配置中心」导航入口且两套叫法**、服务端未启用用户配置存储时自动化页整页早退而「新建触发器」按钮仍在。

判据：全部属「用户能否自己看懂并改对配置」，无一破坏治理边界（不涉 U1-U8 / R1 只收紧 / R7），故不阻断 G 线验收。

### 4.4 守卫与契约

| 项 | 锚点 |
|---|---|
| `auto-scan.ts` 四处常量镜像（`WATCH_TEMPLATE_IDS` / `PLATFORM_MIN_WATCH_MINUTES` / `MAX_WATCHES` / `WATCH_FOCUS_MAX_LENGTH`）无对拍守卫 | 下一次改这四个常量或其 contracts 侧来源时 |
| C5 `ExecutionOutcome` ↔ schema enum 无全等对拍（`skipped` 两向可拦，再扩成员只改单边不会红） | 下一次 C5 闭集扩员时 |
| `pack.schema.json` 的 `workRoutes` `$comment` 只描述 pack 前缀语义，该字段现有两个语义不同的生产者 | 下一次改 pack 自动化声明契约时 |
| `config-draft-unknown-tool` 分支与 PUT 字节上限分支补专用用例 | 下一次改 L2 写入通道时 |
| reject 草稿弃置无审计事件 | 下一次审计事件契约修订时 |
| `automationRunId`/`automationId` 审计归因只落 watch 轮，pack 自动化轮未透传 | 同上 |
| watch 自动回合审计以 `tool-execution`+`execution:'server'` 承载，污染 server 通道统计 | 同上（评估新增 `automation-run` 事件类型） |
| 模型臆造 packId 的噪音评估 | 下一次 `assets/` 改动触发六维评测时 |

### 4.5 平台面（锚点未到期）

单 pack `engines` 不兼容致整快照拒载无 per-pack 隔离（P3.5 pack 分发链路）、`GET /v1/packs` 按 tenant 过滤（P4 托管）、`readBody` 无流式上限（部署加固）、watch 与 pack automation 撞名两端统一（P3.5）、test 目录 typecheck 门（CI 门禁就位时）、L2 导出 / subject 迁移 / Google 登录（P3.5 / P4）、preparation/workflow 服务端硬编码真泛化（第二个履约站点 pack 接入时）、旧品牌文案归一（P2 品牌回归，已在 `2026-08-04-generic-extension-productization.md:93` 登记）。

## 5. 发布状态

# 🔴 未发布

方案 §7 发布前门四项：

| 门 | 状态 |
|---|---|
| 全量 build/test 绿 | ✅ 866 全绿、build 0 错、lint:deps 通过（已亲自复跑） |
| §6 E2E 通过门 | ❌ **A-F 中 E 未通过（0 次，要求 ≥3）** |
| 涉 assets 改动过六维评测 | ✅ 不适用（G 线 `assets/` 零改动） |
| 三视角 review 无未处置 blocker/major | ✅ 六路评审 + 四轮同视角复核，末轮三路一致可收敛 |

**未执行 release skill，未 ssh lingm2，无生产冒烟结果。** 生产上运行的仍是上次发布的 `d9d51ed`（插件 0.3.4）。

### 5.1 生产现状的风险提示

`0.3.4` 带着 G6 才发现的 blocker：`automationId` 未随上行帧送达服务端，adr-021 的 R7 无人值守只读强制在真实客户端上整条不可达——有 pack 的站点上，自动回合本应被收窄为只读，实际拿到完整工具面（含 hitl 档工具，而无人在场可确认）。缺陷引入于 `d4a51c8`（adr-019 批次③），非 G5 引入。修复在 `5aa6e01`，未发布。

这构成一个需要人决策的取舍：**等 E2E-E 跑通再一并发布，还是先把该修复送到生产**。按目标指令「任何门不绿则停在最终报告、不发布」，此处不自行决定。

### 5.2 解除阻断的路径

1. 提供真实 LLM 凭证与已登录 goofish/飞书的持久化 profile，跑通 E2E-E ≥3 次并归档证据；
2. `apps/extension/manifest.json` 版本递增（当前仍为 `0.3.4`）；
3. 走 release skill，冒烟（讲解 + 一次 HITL）不通过即回滚。

**若 E2E-E 因外部依赖确实不可达，MUST NOT 自行降级判绿**——须就「E2E-E 未验证状态下是否接受发布」显式确认（ZA-C-WHEN-01 唯一放行口径）。

## 6. 交付的诚实边界

- A/B/C/D/F 全部跑在本地夹具 + 仓库自带 mock LLM 上，该 mock 的设计目的是把「回答对不对」退化为「装配对不对」。**对真实站点的可用性零证据。**
- G6 的四轮复核每轮都查出上一轮修复不成立（§3.3）。末轮判定可收敛，且断言经变异实测证明可证伪；但这个收敛过程本身说明：**未经真实站点验证的那一面，风险大概率尚未被看见。**
- 本报告所有绿灯项均为主进程亲自复跑，未采信子 agent 自报。
