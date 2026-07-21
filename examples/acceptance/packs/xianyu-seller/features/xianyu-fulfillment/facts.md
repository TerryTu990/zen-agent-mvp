# xianyu-fulfillment 功能事实

> 2026-07-21 登录态真机只读验证；进入消息页但未填写、未发送。

- “联系ta”入口指向同 origin 的 `#/im?itemId=<商品ID>&orderId=<订单号>&peerUserId=<买家ID>`。
- 顶层文档存在唯一消息 `textarea`，placeholder 为“请输入消息，按Enter键发送或点击发送按钮发送”。
- 顶层文档存在唯一可见名称“发 送”的 button；输入为空时 disabled。
- 页面存在一个 iframe，但消息 textarea 和发送 button 均不在 iframe 内。
- 当前观察时未见 dialog、alert、status 或 aria-live 提示。
- 尚未验证发送后气泡、失败提示、登录失效、验证码、频控或超时形态；不得把输入框清空或工具执行 `ok` 当成发送成功。
