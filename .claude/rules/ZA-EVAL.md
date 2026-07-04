---
paths:
  - "assets/**"
---

# ZA-EVAL — 功能配置评测纪律（开发期）

> 本文件按 paths 加载：操作 `assets/**`（system-prompt 基座 / features / skills）时进上下文。
> 编号 `ZA-C-EVAL-<NN><级>`，强制级语义见 `ZA-COMMON-META.md` 头。
> 配置内容质量直接决定产品成败——改了影响内嵌 agent 行为的制品，就必须用客观评测兜住退化。

---

## ZA-C-EVAL-01*  改 assets/ 必跑功能配置评测
**改 `assets/`（system-prompt 基座 / feature.md / facts.md / tools.json / skills）后 MUST 跑功能配置评测集，全绿才算改对；评测维度闭集：讲解正确 / 引导命中 / 工具触发 / HITL 触发 / 拒答边界。**
- 评测集建立锚点：首个功能配置进入验证时；建成前的 assets/ 改动 MUST 人工走查上述五维度并如实记录结果，不得以"评测集未建"为由跳过验证（见 ZA-C-WHEN-02）。
- 判定：改了 assets/ 却未跑评测集（或未走查）就标完成 → 触发，先验证。

> 反例：调了某 feature.md 的讲解措辞直接提交 → 无回归保障 → 违反 EVAL-01；
> 正解：跑命中该 featureId 的评测子集（或走查五维度），全绿再提。

---

## ZA-C-EVAL-02~  ≥3 跑判回归 + 触发分层
**基线与回归判定以 ≥3 次重复的通过率比较（单跑方差大不可信）；触发分层：改单个 feature 只跑该 featureId 命中的子集，基座 system-prompt / 装配引擎改动跑全量。**
- 每场景 token 成本沉淀进度量。
- 偏离（单跑下结论 / 该全量却只跑子集）须说明理由。

---

## ZA-C-EVAL-03*  示范样例与评测集互斥
**评测场景 MUST 与 feature.md / facts.md / skills 内嵌示例互斥，防评测污染。**
- 新增内嵌示例须声明来源并与评测集查重；若拿评测场景当示例，必须等量新增替换场景进评测集。
- 判定：内嵌示例与评测场景重叠未查重/未等量替换 → 触发，去重或补场景。

> 反例：把一个评测问答直接拷进 feature.md 当示范 → 模型见过答案、评测虚高 → 违反 EVAL-03。

---

## ZA-C-EVAL-04~  素材与代码同仓版本化
**system-prompt / feature 配置 / skills / 内嵌示例与代码同仓版本化；`.za/events.jsonl` record-only 作为评测度量与质量指标的数据源。**
- 不把配置素材留在仓外手维护（这也是 ZA-C-WHERE-04 快照版本化的前提）。
