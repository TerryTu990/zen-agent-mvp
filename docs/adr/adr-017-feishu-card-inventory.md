# ADR-017：飞书作为轻量卡密库存账本

## 状态

已接受（2026-07-22）。

## 决策

首版不建设 Zen 管理后台或独立库存数据库，只使用一张私有飞书多维表登记卡密及 `available / reserved / sent / manual` 状态。运行时复用 `/Users/terrytu/Workspace2025/Working/feishu` 的 `general` profile 与既有 token 获取/刷新边界，通过 `lark-cli --as user` 访问；Zen 不实现第二套飞书 OAuth、token 存储或共享权限管理。

库存存储与履约编排分成两个模块。`packages/card-inventory` 只负责同订单查重、领取、预占与终态回填；`packages/fulfillment` 只负责“先预占 → 登记 opaque toolgate intent → 按页面回执回填”。两者只依赖 `@zen-agent/contracts`，唯一接线点仍是 `apps/server`。模型只见 `intentId`，卡密原文只在服务端库存端口、履约编排和最终签名 DOM 指令之间短暂流转，不进入模型、会话历史、审计或日志。

同一订单在进程内重复扫描复用同一个 intent；进程重启后以飞书 `order_id` 找回同一卡。`sent` 不再发送，`manual` 只允许人工恢复，`reserved` 可用原卡继续。页面结果不明确、intent 登记失败或回填失败均停止自动链路；闲鱼已确认但飞书 `sent` 回填失败时，对用户呈现失败并禁止继续处理下一笔。

MVP 明确采用单执行器串行前提，不伪装飞书多维表具有条件更新事务。出现第二执行器或多账号并行后，以同一卡竞争的实测风险为锚点，再引入条件更新或独立事务账本。

## 后果

管理员仍可直接通过飞书 UI、MCP 或 CLI 管理一张表，产品不增加管理页面。代价是 `lark-cli` 必须作为服务运行环境的受控依赖，且首版不支持多执行器并发领取。
