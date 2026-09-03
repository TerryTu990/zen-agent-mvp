# evals — 功能配置评测集（ZA-EVAL 落地载体）

评测对象是**功能配置质量**（system-prompt 基座 / pack.json / feature.md / facts.md / tools.json / skills），
不是代码单测。六维度闭集（权威 `ZA-C-EVAL-01`）：讲解正确 / 装配换出 / 引导命中 / 工具触发 / HITL 触发 /
自动化触发；「拒答边界」随 2026-09-03 基座通用化退出闭集。

## 当前状态

- **runner 已建成**：`scripts/evals/run.mjs`（入口 `pnpm eval`）。协议层直驱，不经浏览器/插件——runner
  自己扮演客户端：发上行帧、读 SSE 下行帧，收到 `exec-instruction` 代插件之职调宿主 API 回 `exec-result`，
  收到 `hitl-request` 按场景 `expect.hitlVerdict` 回 `hitl-decision`，收到 `snapshot-request` 回场景声明的
  确定性快照。LLM 为确定性 mock（`scripts/mock-llm/server.mjs`），非真实模型。
- **四个快照根依次独占同端口起 server**：`examples/host-demo/config`（跑本目录 `scenarios.json` 17 场景）、
  `examples/acceptance`、`assets`（生产快照）、`examples/site-packs`（已下线站点包）；每根再按
  `packs/*/eval/scenarios.json` 自动发现逐 pack 跑。当前合计 89 组场景。
- **维度覆盖**：`explain` / `assembly-swap` 与 `assembly` / `guide` / `tool` / `hitl` / `automation` 均有场景。
- **宿主 API mock 有状态**：`orders` 状态表 + `calls` 调用流水，**每跑重置**；场景可用 `hostState` /
  `hostCalls` / `hostCallsAbsent` 断言代执行的真实副作用（批准后状态已变、拒绝后状态未变且接口未被调用）。
- **治理判定判据**：每跑开跑前记 `.za/eval-events.jsonl` 字节偏移，跑完只读该区间新增事件，按 `toolId`
  聚合出实际 `{riskTier, effectiveTier, verdict}` 与配对的 `hitl-verdict.decision`，与 `expectDecisions`
  逐条比对——分级被误降为 auto 直执、该拒未拒、或工具压根没经过决策点（治理被绕过）时必红。
- **审计完整性校验**：跑完校验 `.za/eval-events.jsonl` 逐行过 `audit-event.schema.json`、必含
  session-start / assembly / tool-decision / hitl-verdict / tool-execution 五类事件、无 secret 样式命中。
- **报告落点**：`runs/<日期>-<commit 短 hash>-eval.md`，含 commit 与工作区 dirty 标注、评测输入 SHA-256
  （覆盖 `scenarios.json` 与四个快照根）、`llmMode`/`runs`、逐场景通过率、维度覆盖表与审计完整性结论。

## 判据自检：`node scripts/evals/run.mjs --check`

不起 server、不调 LLM 的静态自检，两件事：

1. **注入内容探针字面在位**：mock 用 `sys.includes(字面)` 断言"装配确实把某段治理/事实送到了模型"，
   字面登记在 `scripts/mock-llm/server.mjs` 的 `PROBE_LITERALS`（`{literal, sourceFile, why}`）；
   逐条 grep `sourceFile` 断言字面仍在——源文件措辞漂移会让探针静默恒 MISS 或整条剧本失活。
2. **场景判据可证伪**：把每个场景的 `expect` 跑在「空回答 + 零帧 + 零审计事件 + 宿主初态」上，
   要求必红。全过即该场景判据恒真（如只写 `mustNotMention` 的场景，agent 什么都不答也算过）。

任一项有问题即 exit 1；改 `assets/` 或场景集后应先跑 `--check`，再跑 `pnpm eval`。

## 纪律（权威见 .claude/rules/ZA-EVAL.md）

- 改 `assets/` 或示例功能配置后必跑命中子集，全绿才算改对（EVAL-01）。
- 每场景重复 `ZA_EVAL_RUNS`（缺省 3）次、全过才算该场景通过；基线与回归以 ≥3 跑通过率比较（EVAL-02）；
  改单个 pack/feature 跑该 packId/featureId 子集，改基座 / registry / 装配引擎跑全量。
- 评测场景与 feature.md / facts.md / skills 内嵌示例互斥（EVAL-03）：新增内嵌示例须与本目录查重。
- 素材与代码同仓版本化（EVAL-04）；`.za/events.jsonl` 是评测度量数据源。
- **判据只能变严不能变松**：某条场景在新判据下变红，先当作判据抓到了真问题去分析，不得改松判据凑绿。

## scenarios.json 字段

本目录 `scenarios.json`（host-demo 根）：`{id, dimension, page（相对 host-demo 的页面路径）,
featureId（服务端应判定值，null=无命中仅基座）, question, expect}`；`dimension: assembly-swap` 另有
`flow`（页面跳转序列），判据是服务端 featureId 判定与 describeInjection 注入块随之切换；
`dimension: automation` 另有 `watch`（`{id, focus}`，runner 写成 L2 用户自建 page-watch 触发器后以
`automationId` 发起无人值守回合，跑完清空 overlay）与 `snapshotSequence`（首份建基线、其后各份制造变化）；
`groupPagesReports` 声明 `user-message` 之前按序上报的任务组页面清单（adr-023）。

pack 级 `packs/<packId>/eval/scenarios.json`：`{id, dimension, url（含 pack origin 的完整 URL）, question,
snapshotElements / snapshotNotices / snapshotText / snapshotTextTruncated / snapshotSequence（回给
`snapshot-request` 的确定性夹具）, execResultError（令代执行回错误结果）, expect}`。

### `expect` 字段

**文本判据**

- `mustMention`：回答须含其一的关键词组，外层数组为"且"、内层为"或"（`String.includes` 子串匹配）。
- `mustNotMention`：禁止出现的子串。
- `judges`：判据类型闭集，逐条连乘（任一不成立即该跑失败）；「不得出现」仍走 `mustNotMention`：
  - `{kind:"substring", anyOf:[...]}`——子串匹配其一（与 `mustMention` 单组同义）。
  - `{kind:"token", anyOf:[...]}`——**整词**匹配：命中处两侧须非字母/数字/下划线。英文等价 `\b`；
    中文因逐字成词，等价于"该词不与其他汉字连写"，故「页面」这类在复合词里恒真的短词判不过。
  - `{kind:"regex", pattern, flags?}`——正则匹配；`MOCK-*-HIT` 哨兵用 `^MOCK-...` 断言哨兵就是回答本身。

**治理与环境态判据**

- `hitlVerdict`：`"approve" | "reject"`（缺省 approve）——runner 扮演客户端对 `hitl-request` 的裁决。
- `expectDecisions`：`[{toolId, riskTier?, effectiveTier?, verdict, hitlDecision?, unattendedReadOnly?}]`，
  比对本跑审计区间内的 `tool-decision`（及配对 `hitl-verdict`）；`verdict ∈ allow|hitl|deny`。
- `hostState`：`{"orders.ORD-1001.status": "cancelled"}` 点分路径断言宿主 mock 的跑后状态。
- `hostCalls` / `hostCallsAbsent`：`[{method, path}]`，无序包含 / 不得出现语义。

**帧与装配判据**

- `featureId` / `toolIncludes` / `toolExcludesPrefixes`：assembly 维度经 `/injection` 自省端口断言。
- `frameCounts` / `frameSequence` / `targetToolId` / `evidenceRuleId`：帧级判据。
- `hitlCount` + `hitlToolId`：跑该轮数并断言每轮各触发一次独立 `hitl-request`（授权不复用）。
- `behavior`：人工走查判据（不参与机器判定）。
