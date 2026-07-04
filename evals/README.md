# evals — 功能配置评测集（ZA-EVAL 落地载体）

评测对象是**功能配置质量**（system-prompt 基座 / feature.md / facts.md / tools.json / skills），
不是代码单测。五维度闭集：讲解正确 / 引导命中 / 工具触发 / HITL 触发 / 拒答边界。

## 当前状态与锚点

- **M1（本期）**：`scenarios.json` 覆盖 讲解正确 / 拒答边界 / 装配换出 三类场景，
  作为 M1 验收对话；评测 runner 未建成，按 ZA-C-EVAL-01 以人工走查 + E2E 脚本执行并记录。
- 引导命中维度场景：M2 引导落地时补。
- 工具触发 / HITL 触发维度场景：M3 代执行+HITL 落地时补。
- 评测 runner（自动跑五维度、≥3 次重复出报告）：M4 落地。

## 纪律（权威见 .claude/rules/ZA-EVAL.md）

- 改 `assets/` 或示例功能配置后必跑命中子集（runner 建成前人工走查并如实记录）。
- 基线与回归以 ≥3 次重复通过率比较；改基座/装配引擎跑全量，改单 feature 跑该 featureId 子集。
- 评测场景与 feature.md / facts.md / skills 内嵌示例互斥（EVAL-03）：新增内嵌示例须与本目录查重。
- 素材与代码同仓版本化；`.za/events.jsonl` 是评测度量数据源（M4 起）。

## scenarios.json 字段

`{id, dimension, page(相对 host-demo 的页面路径), featureId(服务端应判定值,
null=无命中仅基座), question, expect}`；`expect.mustMention`（回答须含其一的关键词组，
外层数组为"且"、内层为"或"）、`expect.mustNotMention`、`expect.behavior`（人工走查判据）。
`dimension: assembly-swap` 场景另有 `flow`（页面跳转序列），判据是服务端 featureId
判定与 describeInjection 注入块随之切换。
