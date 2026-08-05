# L0-L3 全层实施方案（goal + workflow 编排）

> 状态：定稿 v1（2026-08-04，Terry 确认方法四支柱后落定）。类型：操作指南 + 参考（人读层）。
> 上游：技术方案 `2026-08-04-site-pack-and-user-config-tech-plan.md` §5（分期）、adr-014/020、SSOT v2。
> 方法四支柱（Terry 指定）：**契约驱动 → 测试驱动 → 三视角独立 review → E2E 门**。
> 每个批次由主会话以 workflow 编排执行（`.claude` 红线与 hooks 对全部子 agent 生效）。
> 环境事实（服务器/LLM/测试目录/E2E 站点）见 §6/§7；**凭证值一律不出现在本文档与仓库**（SEC-01）。

## 1. 目标分解（G 线批次）

| 批次 | 层 | 范围 | 依赖 | 验收门 |
|---|---|---|---|---|
| G1 契约层 | L1/L2 契约 | P2.5-a 全量：C7 user-overlay schema、pack v2 字段 + 载入语义（exclude/engines/闭单/preparation 子集/configSchema）、C3 config-draft/decision 帧、C5 user-config-write + userConfigRevision、C6 InjectionBlock 三字段 + UserConfigStore 类型、registry source 字段、knowledge-only fixture | — | 契约 fixtures 全绿（含反例拒收）；现有 packs 原样过校验 |
| G2 L2 合并链路 | L2 读 | P2.5-b：UserConfigStore fs 实现、compose subject + 收紧合并 + revision 定格传 toolgate、describeInjection origin/baseTier/effectiveTier | G1 | 单测矩阵全绿（§4 示例）；故障语义两分支验证 |
| G3 L2 写入通道 | L2 写 | P2.5-c：teach 草稿帧、`PUT /v1/user-config`、面板编辑复用、审计全量脱敏快照 | G2 | E2E-B 走通；U8 红线复查 |
| G4 L0+配置中心 UI | L0/L2 UI | options 扩展为配置中心四页（按 `docs/design/` 设计稿 + ui-style-guide 令牌）：站点包/个人定制/自动化/全局设置；侧边栏透明视图与上下文条 | G2（展示 L2 需数据） | 界面与设计稿逐项对照；R4 来源标注可见 |
| G5 L3 自动化泛化 | L3 | adr-019 续：通用页面监测模板（任意 URL 只读）、用户自建触发器契约立案（锚点在此了结）、自动化报告收口 | G1 | E2E-F 走通；无人值守底线（R7）用例 |
| G6 E2E 门 + 发布 | 全层 | §6 案例集全量回归 + lingm2 发布 | G1-G5 | §6 通过门 + release 冒烟 |

依赖图：G1 → G2 → G3 → {G4, G5 可并行} → G6。每批次完成即 commit（含契约/测试/实现/review 记录）。

## 2. 单批次标准工作流（workflow 模板）

每批次一次 Workflow 编排，五阶段；阶段间产物落盘（scratchpad + 仓库），主进程负责合并与提交：

1. **契约/用例先行**（并行两路 agent）：
   - 契约路：产出/修订 schema + ajv strict 校验器 + fixtures（每字段：合法样本、非法样本、边界样本）；
   - 用例路：产出测试用例矩阵（§4），用例先写先红（尚无实现时断言失败即为预期）。
2. **实现**：主进程（或实现 agent）在用例存在且红的前提下实现；实现代码 MUST 消费 schema 校验器，
   不得旁路自写解析（契约驱动的机械保证）。
3. **三视角独立 review**（并行 3 个只读子 agent，fresh context，不带实现过程偏见）：
   - **产品视角**：对照 `2026-08-04-product-form-definition.md`（R1-R9）+ `docs/design/` 设计稿 + SSOT §1——实现是否遵循产品设计意图（如收紧矩阵语义、来源标注、拒答边界）；
   - **架构视角**：对照 ZA-WHERE U1-U8 + 契约文档——端口纪律、加法演进、fail-closed、双源模型；
   - **规则视角**：对照 CLAUDE.md + `.claude/rules/` 全集——HOW（简洁/外科/不伪造）、WHEN（deferral 有界）、SEC、AGENT-03/04；
   - 输出统一 schema：`{severity: blocker|major|minor, point, suggestion, evidence(file:line)}`。
4. **修复循环**：主进程修复全部 blocker/major → `pnpm -r build` + 串行 test 回归 → 重跑命中视角复核；
   循环直至三视角无 blocker/major（minor 可带锚点登记后放行）。连续 3 轮无进展停下复盘（HOW-06）。
5. **批次验收**：验收门核对 + 涉 assets/ 改动跑六维评测（ZA-EVAL）+ commit。

workflow 脚本骨架（每批次实例化，阶段名固定便于对照）：

```js
phase('契约与用例')   // parallel: schema+fixtures / 测试矩阵（先红）
phase('实现')         // 主进程实现，消费校验器
phase('三视角评审')   // parallel 3 readonly reviewers, schema 化 verdict
phase('修复回归')     // loop: fix blockers/majors -> build+test -> re-review, dry=pass
phase('批次验收')     // 验收门 + eval(若涉 assets) + commit
```

## 3. 契约驱动细则

- 顺序铁律：schema 定稿并 commit → 校验器 + 正/反 fixtures → 实现。禁止「实现先行、schema 事后补」。
- 契约变更一律 U3 加法：新增字段可选、旧制品原样有效；每个新增字段在同批次内有装配端语义或显式锚点
  （adr-020 「禁 schema 接受而引擎无视」）。
- pack 校验门 fail-closed：非法 pack 拒载并给可定位错误；knowledge-only pack 是合法性基线 fixture。
- 规范校验即测试：contracts 包的 fixtures 测试就是「开发内容过规范校验」的机械落点，进常规回归。

## 4. 测试驱动细则

用例矩阵三维度（正常/异常/边界），实现前先写先红。G1/G2 示例矩阵（实施时按此风格扩全）：

| 关键点 | 正常 | 异常 | 边界 |
|---|---|---|---|
| riskTier 合并 | L2 hitl 覆盖 L1 auto → 生效 hitl | L2 声明 auto 低于 L1 hitl → 写入期拒 | L1=forbidden 时任何 L2 值不改变结果 |
| 越界引用 | toolId 在 L1 集合内 → 生效 | toolId 已不存在 → 该条失效 + 审计，其余生效 | 整文件解析失败 → 走存储故障语义 |
| `"*"` 全局作用域 | 跨站规则在无 pack 站点注入 | `"*"` 内出现 restrictions → schema 拒 | `"*"` 与 pack 级同名规则的注入顺序 |
| 故障语义 | rules 缺失 → 纯 L1 可用 | restrictions 读失败 → 受影响工具拒执行 | stale revision 降级 + 审计标注 |
| revision 定格 | 同轮 compose 与 toolgate 同 revision | 轮中 PUT 更新 → 本轮仍旧值 | 空 overlay 的 revision 稳定性 |
| pack v2 载入 | v2 字段齐备正常载入 | engines 不满足 → 拒载 | 无 tools.json 的知识型 pack 合法 |

纪律：断言不许为凑绿改写（HOW-05，za-bash-guard 拦 `--no-verify`）；回归恒为
`pnpm -r build` + `pnpm -r --workspace-concurrency=1 test`；报告如实附输出（HOW-07）。

## 5. 三视角 review 规范

- reviewer 是**独立只读子 agent**：输入 = 本批次 diff + 对照文档清单（§2 所列）；禁改代码，只产 verdict。
- 处理规则：blocker/major 必修复后复核；minor 允许带锚点登记放行（WHEN-01）；同一 point 修复后
  由**同视角** reviewer 复核（SendMessage 续会话，保留其上下文）。
- review 结论（含未修复 minor 清单）随批次 commit 落 `docs/reviews/`，作为验收证据。

## 6. E2E 规范与案例集（提前确认，G6 执行、G3 起增量跑）

**环境**：
- 构建发布到本地测试根 `/Users/terrytu/Workspace2025/Working/tmp/zen-agent/<yyyymmdd-HHmm>/`（时间戳隔离，可并存回退比对）。
- LLM：DeepSeek 临时凭证（`ZF_LLM_*` 命名），`.env` 置于测试根目录、由 Terry 放置（za-secret-guard
  禁 agent 写字面值，已实测）；server 启动时映射 `ZF_LLM_*`→`ZA_LLM_*` 并自补 JWT/签名 secret
  （既有 E2E 环境事实，见项目记忆 e2e-demo-environment）。临时 key，E2E 期结束轮换。
- 驱动：Playwright `launchPersistentContext` 加载插件（`za.autoActivate` 免点激活）；证据 = 审计事件
  （`.za/events.jsonl` 脱敏）+ 截图，每案例归档到该时间戳目录 `evidence/`。

**案例闭集**（每例四段式：前置 / 步骤 / 断言 / 证据）：

| # | 案例 | 覆盖 | 断言要点 |
|---|---|---|---|
| E2E-A | 讲解与拒答（回归） | L1 | 有据回答带引用；配置外问题明确拒答 |
| E2E-B | L2 全链路 | L2 | teach 草稿→确认→下轮注入含规则且透明视图 origin=L2；收紧 auto→hitl 后该工具弹确认卡 |
| E2E-C | 治理故障语义 | L2/U7 | restrictions 不可读 → 受影响工具拒执行；rules 不可读 → 会话正常纯 L1 |
| E2E-D | pack v2 载入 | L1 | exclude 路径不激活；engines 不满足拒载有可见错误；知识型 pack 讲解可用 |
| E2E-E | **真实站点主案例** | L1+跨站+工具 | goofish.com 搜索 AI 相关商品 → 提取商品清单 → 经确认写入飞书云盘 `zen-agent-test` 文件夹表格（https://scni9roy6i25.feishu.cn/drive/folder/IhiufABaxl6XF3dfBIPc86KnnKw）；断言：表格新增行数与提取数一致、写入前有 HITL 确认、审计含全链路事件 |
| E2E-F | 通用自动化 | L3 | 页面监测模板对任意 URL 周期只读运行、变化时报告；无人值守不执行写操作（R7） |

**通过门**：A-F 全部 ≥1 次通过；E2E-E 追加 **≥3 次重复通过**（对齐 ZA-EVAL ≥3 跑纪律）后方可发布。
飞书写入凭证按 SEC-02 运行时注入（沿 adr-017 飞书链路先例），不入任何制品。

## 7. 发布（G6 末）

- 通道：release skill（`ssh lingm2`，发布目录 `/root/zen-agent`）——构建镜像/插件 zip、部署、冒烟、回滚均沿其既有流程。
- 发布前门（全部满足）：全量 build/test 绿 + §6 通过门 + 涉 assets 改动过六维评测 + 三视角 review 无未处置 blocker/major。
- 发布后：生产冒烟（讲解 + 一次 HITL）；不通过即回滚（release skill 路径）。

## 8. 贯穿治理与安全

- 凭证：DeepSeek key / 飞书凭证 / 服务器 secrets 一律不入仓、不入文档、不入日志（SEC-01/02，
  za-secret-guard 硬拦已验证）；本文档只记「存放位置与命名」，不记值。
- workflow 全部子 agent 同受 `.claude` 红线与 hooks 约束；reviewer 只读；实现类 agent 改动最终由
  主进程合并提交（单一提交责任点）。
- 每批次未了结项按 WHEN-01 挂锚点登记于批次 commit 与本文档修订，不带病标完成。

## 9. G 线收尾登记（2026-08-05 修订）

### 9.1 G6 结果

G1-G6 六批次全部 commit（清单见 `docs/reviews/2026-08-05-g6-e2e-gate.md`）。
E2E 案例 A/B/C/D/F 浏览器级通过；**E2E-E 未执行（阻塞：真实 LLM 与飞书凭证在 SEC-03 凭证读禁区内，
开发期不得装载）**，§6 通过门因此不绿。**未发布**，裁定与解除路径见该记录 §5。

### 9.2 后续批次：配置中心可用性收口

G3-G6 累积的面板类未了结项原以「G6 前面板打磨」为锚，该锚随 G6 结束失效。
统一重挂到本批次，**触发条件：首个外部用户试用前**（在此之前无外部用户，这些项不构成实际损失；
一旦进入外部试用即全部必修）。范围与逐项来源见 `docs/reviews/2026-08-05-g6-e2e-gate.md` §6。

判据：这八项全部属「用户能否自己看懂并改对配置」的可用性面，无一破坏治理边界
（不涉 U1-U8、R1 只收紧、R7 无人值守底线），故不阻断 G 线验收。
