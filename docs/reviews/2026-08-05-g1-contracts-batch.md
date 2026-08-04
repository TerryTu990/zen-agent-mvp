# G1 批次评审记录：P2.5-a 全量契约 + 载入语义

> 批次：G1（L0-L3 实施方案 §1）。日期：2026-08-05。
> 流程：契约/用例先行（workflow 双路并行）→ 实现 → 三视角独立只读评审 → 修复回归 → 同视角复核 → 本记录 + commit。
> 验证基线：`pnpm -r build` 退出码 0；`pnpm -r --workspace-concurrency=1 test` 全绿
> （contracts 136 / assembly 96 / extension 130 / server 125，全仓 9 包无回归）。

## 1. 批次范围（落地内容）

- **C7** `user-overlay.schema.json`（adr-014 §2 全量）+ TS 型别 + `validateUserOverlay` 组合校验器。
- **pack v2**（adr-020 §2）：`site.exclude` / `engines.contract` / `capabilities{anchors, skills, docs, preparation.workflows}` / `configSchema` / `integrity` / `name`；registry 登记项 `source` / `hash`。
- **C3**：`config-draft` / `config-decision` 帧（U8 确认写入通道的帧面）。
- **C5**：type 枚举增 `user-config-write` + `userConfigWriteData`；`assemblyData` 与 `toolDecisionData` 增 `userConfigRevision`（R4 三方互证）。
- **C6**：`InjectionBlock.origin`、`InjectionToolDescriptor`、`InjectionDescription.tools/packVersion/packSource/packName/featureTitle`、`ComposeInput.subject`、`UserConfigStore` 端口；`contractVersion` + `checkContractCompatibility` + `compileConfigSchema` + `preparationWorkflows` 运行时闭集。
- **assembly 载入期语义**：exclude 排除判定、engines 拒载、skills/docs 闭单双向对账（docs 递归相对路径）、workflows 子集校验、configSchema 合法性、knowledge-only pack 放行（tools.json 可缺省）、source/name/featureTitle 载入与注入自省透出。
- **extension**：帧闭集同步（config-draft/config-decision + 镜像测试）+ 路由分支；**gateway**：上行帧受理表穷举镜像（config-decision 契约内未启用，fail-closed 拒收）。
- 测试：新增 60+ 用例（正常/异常/边界）+ knowledge-only fixture（`packages/assembly/test/fixtures/registry-knowledge/`）。

## 2. 三视角评审发现与处置

### 产品视角（对照 R1-R9 + 设计稿 + adr-014/020）

| # | 级别 | 发现 | 处置 |
|---|---|---|---|
| P1 | major | `toolDecisionData` 缺 `userConfigRevision`，R4 三方互证契约断链 | 修复：schema + `ToolDecisionEvent` 补可选字段 + 用例 |
| P2 | major | pack/feature 无人读名字段，packs 页/确认卡/注入视图无数据支撑 | 修复：pack `name` 字段 + feature.md frontmatter title 解析 + `describeInjection` 透出 + `config-draft.scope.title` |
| P3 | major | `registry.source`「schema 接受但引擎无视」 | 修复：载入入 `LoadedPack.source`（缺省 official）+ `InjectionDescription.packSource/packVersion` 落值 + 两态用例 |
| P4 | minor | `InjectionToolDescriptor.origin` 含 'L2' 与只收紧叙事矛盾 | 修复：收窄为 `'L0' \| 'L1'` |
| P5 | minor | config-draft 的 scope 与 change 无一致性约束 | 修复：契约注明服务端 MUST 保证一致（G3 落库校验锚点） |

**复核（同视角续会话）：5/5 RESOLVED**，「修复均为加法演进，未引入新的放宽表达力或治理面漏洞；产品视角无遗留异议」。

### 架构视角（对照 U1-U8 + 技术方案 + 投影纪律）

| # | 级别 | 发现 | 处置 |
|---|---|---|---|
| A1 | major | 同 P1（toolDecisionData revision 缺位将迫使 P2.5-b 二次改契约） | 同 P1 修复 |
| A2 | major | docs 闭单对账 / schema 允许面 / pack_doc 围栏三者不同源（子目录名实不符） | 修复：`listDocFiles` 递归相对路径，三面共用同一文件集 + 双向用例 |
| A3 | minor | configSchema「合法性」载入期与写入期两套判定 | 修复：`compileConfigSchema` 唯一编译定义，两端共用 |
| A4 | minor | `preparationWorkflows` 与联合类型仅单向同源 | 修复：`Record<workflow, true>` 穷举镜像派生（双向编译期爆错） |
| A5 | minor | gateway `UPSTREAM_TYPES` 手写镜像已漂移、无编译期同步 | 修复：`UPSTREAM_ACCEPTANCE: Record<UpstreamFrame['type'], boolean>` 穷举镜像 + 未启用帧如实 400 文案 |
| A6 | minor | `userConfigWriteData.overlay` 宽松 object 无结构保障说明 | 修复：$comment 固定结构权威在 C7、生产方 MUST 先过 `validateUserOverlay`（P2.5-c 可验） |

**复核（同视角续会话）：6/6 RESOLVED**，亲验 build+test 全绿；「两处 major 都按同源/闭单本义修，无降级绕过」。

### 规则视角（对照 CLAUDE.md + ZA 红线全集）

| # | 级别 | 发现 | 处置 |
|---|---|---|---|
| R1 | minor | `preparationWorkflows` 注释宣称双向保证实为单向 | 修复：同 A4（穷举镜像，注释如实） |
| R2 | minor | pack.schema.json 两处 $comment 含变更史措辞（违 HOW-08） | 修复：改写为当前契约语义 |

初评通过项：catalog 依赖纪律、deferral 锚点全带、SEC 假值纪律、AGENT-03 纯数据 fixture、AGENT-04 只收紧结构与负向用例、既有测试改动零弱化（`git diff -U0` 核实零删除行）、HOW-03 外科纪律。
**复核：2/2 RESOLVED**；修复期新增 diff 增量扫描（gateway 受理表、pack name、docs 递归、compileConfigSchema、注入自省元数据）报 1 条新 minor——gateway 的 config-decision 拒收分支（400「尚未启用」）无测试覆盖；已当场补 server 测试断言 400 + 文案（server 124→125 全绿），了结不留 deferral。其余维度（HOW-02/03/08/09/10/11、WHEN-01、SEC、AGENT-03/04）均判定干净。

## 3. 过程说明

- 实现 agent 撞会话限额后由主进程按方案 §2「主进程（或实现 agent）实现」接管实现阶段。
- 契约路与用例路的一处形状分歧（`user-config-write` fixture 缺 `subject`/`origin`）由主进程仲裁：schema 语义为准（审计自描述 + R4），修 fixture 补齐；两 agent 均未为凑绿弱化各自产物。
- 三视角复核均以 SendMessage 续用原评审会话（同视角复核，保留上下文）。

## 4. 未了结 deferral（WHEN-01，全部带锚点）

| 项 | 锚点 |
|---|---|
| `integrity` / registry `hash` 装配端启用 | P3.5（打包分发） |
| `capabilities.anchors` 装配端消费 | D2（引导 capability 落地） |
| pack `name` / `featureTitle` 的配置中心 UI 消费 | G4 |
| `config-draft.scope.title` 渲染与 scope/change 一致性落库校验 | G3（写入通道） |
| gateway `config-decision` 帧启用（受理表 `false` → handler） | G3 / P2.5-c |
| `readPackDoc` 对 docs/ 内非 `.md` 文件的既有放行收口（架构复核残余面备注） | P3.5（随 integrity 一并裁决） |
| `userConfigWriteData.overlay` 的「生产方 MUST 先过 validateUserOverlay」实现落点 | G3 / P2.5-c |

## 5. 验收门核对（方案 §1 G1 行）

- ✅ 契约 fixtures 全绿（含反例拒收）：contracts 136 用例（正常/异常/边界三维）。
- ✅ 现有 packs 原样过校验：assets/xianyu-seller + examples/host-demo 回归锚用例全绿。
- ✅ knowledge-only fixture 载入 + 讲解注入可用。
- ✅ 全量 `pnpm -r build` + 串行 test 全绿；未涉 assets/ 改动（fixture 置于测试目录），六维评测不触发。
