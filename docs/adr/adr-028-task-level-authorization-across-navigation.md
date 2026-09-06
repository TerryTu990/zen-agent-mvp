# ADR-028 · 任务级一次授权：计划上导航工具，授权随任务导航延续

- 状态：已接受（2026-09-07，Terry 裁决「一个任务一次授权」）
- 相关：adr-013（站点包与跨站任务组，任务级授权首次引入）、adr-023（任务组多 tab 工作区）、
  adr-024（无人值守收口与批准复核，D4 授权作用域指纹）、adr-027（按需注入双轨模型）
- 取代：无（收紧并延展 adr-024 D4 的作用域语义；`open_url` 的 every-call 语义退场）

## 1. 背景

`docs/plans/2026-09-07-task-auth-and-ux-round.md` §1 的真实试用复盘：一句「打开百度、查新闻、打开最值得看的一条、
告诉我核心内容」在插件 0.11.0 / 服务端 5d6e88e 上至少要用户批准 3 次，叠加落点页未接入的循环后达到 6 次，用户放弃。
根因（§2-P3）在三处叠加：

1. 任务级授权键 `(sessionId, packId, packOrigin, task)`（adr-024 D4）——generic pack 的 `packOrigin` 是活跃页 origin，
   跨站导航后作用域必然失配，同一任务在新站上要重新授权；
2. `open_url` 在 toolgate 是 every-call：每次必弹卡、不消费授权；网关批准后也不登记授权
   （理由：导航卡上用户没看到任务计划）。`site_navigate` 会消费授权但同样不登记；
3. 于是冷启动导航、页面操作首批、打开结果页各要一次确认，任务越长确认越多。

Terry 裁决：**一个任务只授权一次**。用户批准的是任务，不是某个工具的某次调用。

## 2. 决策

### D1 计划上导航工具（contracts）

`OPEN_URL_PARAMS_SCHEMA` 与 `SITE_NAVIGATE_PARAMS_SCHEMA` 增可选 `plan: string[]`（`minItems: 1`、items string，
口径与 `browse.page-operate.plan` 一致、不设上限）；`task` 仍可选。`plan` 单独出现无治理意义，与 `task` 同现才构成
「用户在卡上看到了整任务计划」这一登记依据。

### D2 两个导航工具同律（toolgate）

`decide` 对 `open_url` 与 `site_navigate` 走同一条链：参数校验（含定向目标解析与各自的目标围栏）→ `unattended` 一律
deny（不消费授权，adr-024 D1）→ 带 `task` 且同作用域授权命中 → allow → 否则 hitl。`open_url` 的 every-call 语义取消。
导航恒为 hitl 档、无 auto 路径，因此 decide 的 allow 就是「任务级授权命中」——网关据此驱动 D4，无需扩 `GateDecision`。

### D3 带计划的导航批准即登记（gateway）

导航调用带 `task` 且 `plan` 为非空字符串数组时，用户批准即 `grantHitl`（作用域 = 当前 `(packId, packOrigin)`）。
不带 `plan` 的导航批准只覆盖本次、不登记——卡上只有目标地址，不构成任务级知情授权。`every-call` 工具照旧不登记。

### D4 授权随任务导航延续（gateway）

非定向 `open_url` / `site_navigate` 成功、调用带 `task`、且本次是「授权命中放行」或「带计划获批」时，落点重装配之后
以新作用域 `(packId, packOrigin)` 对同一 `task` 再登记一次。这是**服务端驱动**的延续：延续的是用户批准过的那次导航
（批准计划时用户已看到「打开结果页」这一步），不是模型自述换站。约束：

- 用户手动切页 / 换站不延续：adr-024 D4 的防挂靠语义原样保留——模型无法靠沿用标题在用户自己打开的站上复用授权；
- 越界落地（`site_navigate` 被 302 带出已安装围栏，按仅基座装配）不延续；
- 定向导航（`targetPage`）不改变活跃页、不重装配，故不延续；
- 延续的实现是独立函数 `continueTaskGrant`，导航成功分支只保留一次调用；`runExecSubflow` 以纯数据标记
  `taskGranted` 把「本次处于任务授权之下」暴露给调用方，不进回喂、不进审计。

### D5 任务授权卡（extension）

导航工具带 `task` + 非空 `plan` 的 HITL 卡按任务授权卡呈现：标题「授权任务：<task>」、一行「将先打开：<targetUrl>」
（仍取服务端组装字段）、计划有序清单、既有提示「授权后本任务内的后续操作……自动执行；执行中可随时点停止」、
按钮「授权执行」；默认焦点仍落「拒绝」。无 `plan` 的导航卡维持一次性确认卡（「需你确认」/「目标地址」/「确认执行」）。
客户端只按帧字段呈现，零治理判定（U7/U8）。

### D6 运行期治理与 LLM 面同步

- `OPEN_URL_TOOL_DEF` / `SITE_NAVIGATE_TOOL_DEF` 描述：任务首个动作 MUST 带 `task` 与整任务 `plan`；同 `task` 的后续导航
  自动执行；无 task/plan 的一次性导航每次确认。
- `assets`：ZA-FEAT-03 扩展到导航（首个动作无论是 open_url 还是 page-operate 都 MUST 带 task + 整任务 plan，后续沿用同一
  标题）；ZA-FEAT-09/11 改为「导航共享任务授权；只有任务外或新任务才重新确认」；`browse.page-operate` 描述同步；
  web-search SKILL 第 1 步带 task 与 plan；ZA-SYS-06 改为「任务的首次动作经平台确认；已批准任务内的导航按计划自动执行、
  用户随时可停」。

## 3. 与 adr-024 D4 的关系

D4 的目的是让作用域不由模型自述决定：`packId` / `packOrigin` 是服务端事实，模型沿用标题挂靠不上别的站的授权。
本 ADR 不改这一键，也不做跨作用域的模糊匹配；它只在**服务端已经放行/批准的导航**成功之后，把同一任务登记进新作用域。
换句话说，作用域切换的触发者仍是治理链自己（导航经过了 decide 与签发），不是对话内容（U8）。
adr-024「跨站任务会多出一张确认卡」这一代价，在任务首个动作带计划的前提下被取消；不带计划的导航仍逐次确认。

## 4. 代价与缓解

- **单次批准覆盖面扩大**：一次批准覆盖任务内任意导航与页面操作。缓解：卡上呈现整任务计划（ZA-FEAT-03/06 要求不可撤回
  动作显著声明）；授权 TTL 15 分钟滑动闲置期；用户「停止」吊销本会话全部授权（adr-024 D2）；敏感控件写入与 every-call
  工具仍逐次确认（不消费、不登记）；范围超出计划 MUST 换新 `task`（ZA-FEAT-04）——沿用旧标题夹带计划外操作是模型违规，
  由评测与审计（同 task 的 tool-decision 序列）可查。
- **计划是模型自述**：用户据以授权的清单由模型撰写。缓解：卡上「将发生什么」的权威仍是服务端反解的 effects / targetUrl；
  计划只决定授权是否登记，不决定任何一次调用能否通过校验（每次调用仍过参数/围栏/dom 校验，U7）。
- **无人值守零变化**：`unattended` 回合导航一律 deny、不消费授权（adr-024 D1 原样）。

## 5. 验收

- 单测：toolgate（open_url 带 task 已授权 → allow；未授权/异作用域 → hitl；unattended → deny 且不消费授权；plan 校验）；
  server `task-grant.test.ts`（一卡授权整任务、跨站后 B 作用域放行；无 plan 不登记）；extension 卡两种形态。
- 评测：`generic-task-grant-once`（hitlCount 1 + 落点跨域后 page-operate allow）、`generic-open-url-no-plan-no-grant`
  （两张卡、两次 approve）；`pnpm eval` 全量 ≥3 跑全绿 + `--check`。
- E2E：`pnpm test:e2e:task-grant`——空白页冷启动 → 一张任务授权卡 → A 站搜索 → 开 B → B 快照取到哨兵 → 总结；
  审计 hitl-verdict 恰 1、其后 tool-decision 一律 allow、tool-execution 一律 ok、B 站作用域下的页面操作落点 origin = B。
