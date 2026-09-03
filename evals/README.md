# evals — 功能配置评测集（ZA-EVAL 落地载体）

评测对象是**功能配置质量**（system-prompt 基座 / pack.json / feature.md / facts.md / tools.json / skills），
不是代码单测。六维度闭集（权威 `ZA-C-EVAL-01`）：讲解正确 / 装配换出 / 引导命中 / 工具触发 / HITL 触发 /
自动化触发；「拒答边界」随 2026-09-03 基座通用化退出闭集。

## 当前状态

- **runner 已建成**：`scripts/evals/run.mjs`（入口 `pnpm eval`）。协议层直驱，不经浏览器/插件——runner
  自己扮演客户端：发上行帧、读 SSE 下行帧，收到 `exec-instruction` 代插件之职调宿主 API 回 `exec-result`，
  收到 `hitl-request` 按裁决表回 `hitl-decision`，收到 `snapshot-request` 回场景声明的确定性快照。
  LLM 为确定性 mock（`scripts/mock-llm/server.mjs`），非真实模型。
- **四个快照根依次独占同端口起 server**：`examples/host-demo/config`（跑本目录 `scenarios.json` 16 场景）、
  `examples/acceptance`、`assets`（生产快照）、`examples/site-packs`（已下线站点包）；每根再按
  `packs/*/eval/scenarios.json` 自动发现逐 pack 跑。当前合计 88 组场景。
- **维度覆盖**：`explain` / `assembly-swap` 与 `assembly` / `guide` / `tool` / `hitl` 均有场景；
  **`automation` 维度场景尚未建立**（登记于 `../docs/reviews/2026-09-03-audit-r1.md` A-TEST-03，
  锚点：该发现的处置批次落地时补齐）。
- **审计完整性校验**：跑完校验 `.za/eval-events.jsonl` 逐行过 `audit-event.schema.json`、必含
  session-start / assembly / tool-decision / hitl-verdict / tool-execution 五类事件、无 secret 样式命中。
- **报告落点**：`runs/<日期>-*.md`，含评测输入 SHA-256、逐场景通过率、维度覆盖表与审计完整性结论。

## 纪律（权威见 .claude/rules/ZA-EVAL.md）

- 改 `assets/` 或示例功能配置后必跑命中子集，全绿才算改对（EVAL-01）。
- 每场景重复 `ZA_EVAL_RUNS`（缺省 3）次、全过才算该场景通过；基线与回归以 ≥3 跑通过率比较（EVAL-02）；
  改单个 pack/feature 跑该 packId/featureId 子集，改基座 / registry / 装配引擎跑全量。
- 评测场景与 feature.md / facts.md / skills 内嵌示例互斥（EVAL-03）：新增内嵌示例须与本目录查重。
- 素材与代码同仓版本化（EVAL-04）；`.za/events.jsonl` 是评测度量数据源。

## scenarios.json 字段

本目录 `scenarios.json`（host-demo 根）：`{id, dimension, page（相对 host-demo 的页面路径）,
featureId（服务端应判定值，null=无命中仅基座）, question, expect}`；`dimension: assembly-swap` 另有
`flow`（页面跳转序列），判据是服务端 featureId 判定与 describeInjection 注入块随之切换；
`groupPagesReports` 声明 `user-message` 之前按序上报的任务组页面清单（adr-023）。

pack 级 `packs/<packId>/eval/scenarios.json`：`{id, dimension, url（含 pack origin 的完整 URL）, question,
snapshotElements / snapshotNotices / snapshotText / snapshotTextTruncated / snapshotSequence（回给
`snapshot-request` 的确定性夹具）, execResultError（令代执行回错误结果）, expect}`。

`expect`：`mustMention`（回答须含其一的关键词组，外层数组为"且"、内层为"或"）、`mustNotMention`、
`behavior`（人工走查判据）、`featureId` / `toolIncludes` / `toolExcludesPrefixes`（assembly 维度经
`/injection` 自省端口断言）、`frameCounts` / `frameSequence` / `targetToolId` / `evidenceRuleId`（帧级判据）、
`hitlCount` + `hitlToolId`（跑该轮数并断言每轮各触发一次独立 hitl-request，即授权不复用）。
