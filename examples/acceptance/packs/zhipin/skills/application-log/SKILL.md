---
title: 投递记录读写方法（application-log）
summary: greet 成功后如何调内建 record_application 落盘投递，用户问某天投了哪些时如何调 list_applications 汇总回报。
---

# 投递记录读写方法（application-log）

本 skill 只讲**何时、怎样调用平台内建的记录工具**，把每次打招呼落盘、按天可回溯复盘。
`record_application` / `list_applications` 由平台网关内建提供，**不写进 `tools.json`**，直接按名调用即可。
何时该打招呼、上限/授权等**规则**见 `job-search` / `job-detail` 的 `feature.md`，本篇不承载规则。

## 写：每次 greet 成功后调 record_application

时机：对某职位的打招呼（点"立即沟通"）**经页面证据确认成功后**，立即调用一次 `record_application`
落盘该条投递；一次成功 greet 对应一条记录，不重复记、不预先记（未成功不记）。

参数（全部为 JSON 可序列化字段）：

| 参数 | 填什么 | 来源 |
|---|---|---|
| `company` | 公司名 | 职位卡片 / 详情页 |
| `position` | 职位名称 | 职位卡片 / 详情页 |
| `jdDigest` | JD 关键要点摘要，1–2 句（方向/核心要求/薪资地点） | 你对该 JD 的浓缩，不贴全文、不含 secret |
| `score` | 匹配度分 | `jd-match` 评估结果 |
| `replyOdds` | 回复概率档：高 / 中 / 低 | `jd-match` 评估结果 |
| `reason` | 决策理由，一句话：命中的 S/R 维度 + 为何投 | `jd-match` 命中维度 + 打招呼话术要点 |
| `decision` | 本条决策：`greeted`（已自动打招呼） | 通常记已 greet 的；边界/弃项如需复盘可分别记 `boundary` / `rejected` |

调用示例（值为示意，按实际填）：

```
record_application({
  company:   "××银行金融科技子公司",
  position:  "大模型应用工程师",
  jdDigest:  "信贷风控方向大模型落地，要求 RAG/Agent 工程经验，武汉，40-60K",
  score:     87,
  replyOdds: "高",
  reason:    "命中 S1 金融AI + S3 工程化落地，中型企业回复概率高，据此已打招呼",
  decision:  "greeted"
})
```

落盘按天归档（`.za/applications/<当天日期>.jsonl`，平台侧路径，你无需拼路径）。记录为**旁路 record-only、
写失败不阻断**打招呼主流程：以工具返回为准，成功即续下一个职位，失败也不谎报、不因记录失败而停掉打招呼。
`jdDigest`/`reason` 里**MUST NOT** 写入任何凭证或 secret。

## 读：用户问"投了哪些"时调 list_applications

时机：用户问"今天/某天投了哪些""投递汇总""复盘一下今天的投递"等，调用 `list_applications` 读回记录。

参数：`date`（可选，`YYYY-MM-DD`）——问"今天"就省略 `date`（缺省当天）；问"昨天/某具体日期"就传对应 `date`。

```
list_applications()                 // 今天
list_applications({ date: "2026-07-07" })   // 指定某天
```

汇总回报方式：

- 先给**总条数**（如"7 月 8 日共打招呼 12 家"）。
- 再**逐条列**：公司 · 职位 · 匹配度分 · 回复概率档 · 一句理由（取自 `reason`）。
- 可按 `replyOdds` 高→低 或 `score` 高→低 排序，让用户先看更有戏的。
- 该天无记录就如实说"当天没有打招呼记录"，不编造。
- 只读不改：`list_applications` 仅汇总，用户要改投递策略是下一步对话，不在本工具范围。
