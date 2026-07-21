# xianyu-fulfillment 功能事实

> 2026-07-21 登录态真机验证；2026-07-22 对一笔明确授权的历史已发货订单完成一次通知重发。

- “联系ta”入口指向同 origin 的 `#/im?itemId=<商品ID>&orderId=<订单号>&peerUserId=<买家ID>`。
- 顶层文档存在唯一消息 `textarea`，placeholder 为“请输入消息，按Enter键发送或点击发送按钮发送”。
- 顶层文档存在唯一可见名称“发 送”的 button；输入为空时 disabled。
- 页面存在一个 iframe，但消息 textarea 和发送 button 均不在 iframe 内。
- 当前观察时未见 dialog、alert、status 或 aria-live 提示。
- 点击发送后，页面先显示消息气泡并短暂出现“发送中”，随后同一条最新卖家消息显示“未读”；输入框清空且发送按钮恢复 disabled。
- pack 的 `message-receipts` 证据配方按唯一卖家消息容器去重，只返回 `count + latest` 状态枚举而不采集消息正文；发送前后 `count` 恰好增加 1，且 `latest` 为“未读/已读”，可作为页面明确接纳消息的成功证据。输入框清空、工具执行 `ok` 或旧回执单独仍不能证明成功。
- 尚未在真机触发登录失效、验证码、频控或超时；这些异常通过受控 E2E 夹具验证，不主动破坏真实账号会话或诱发风控。
- 有界自动授权由服务端 toolgate 按已验签账号、工具、商品、有效期、单笔卡密数量和每日订单限额逐单匹配；pack 只声明业务键映射，不持有策略或额度。
