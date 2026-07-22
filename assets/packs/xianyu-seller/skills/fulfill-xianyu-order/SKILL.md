---
name: fulfill-xianyu-order
description: 依据闲鱼卖家页面证据识别并完成单个订单履约。用于查找待发货订单、受控点击发货、确认平台已发货，再通过服务端零参数准备器安全发送固定卡密通知并复核回执。
---

# 履约单个闲鱼订单

## 工作流

1. 调用 `page_snapshot`，确认当前 feature、登录态、遮挡提示和页面状态。
2. 在订单管理页选择“待发货”，重新快照；计数为零或空态时报告无可处理订单并结束。
3. 对候选订单分别读取平台状态、订单编号和对应操作入口。把三者按同一订单块绑定；不能绑定就转人工。
4. 打开订单详情后重新快照，核对路由 `orderId`、同页订单编号、唯一商品链接、`order-shipment-status=待发货` 和唯一可用“发货”按钮。不一致立即停止。
5. 调用零参数 `prepare_xianyu_shipping`；成功只取得 opaque `intentId`，原样调用 `xianyu-shipping.execute-intent`。不得添加订单号、商品号或 DOM 步骤。服务端会在点击前写 `shipping-attempted`。
6. 点击后由网关强制重新快照。只有同页状态唯一变为“已发货”才写 `shipped-confirmed`；出现额外确认弹窗、超时、换页或证据不符均转人工且不重试。
7. 确认已发货后进入对应“联系ta”入口并重新快照，核对聊天 URL 的 `itemId`、`orderId`、唯一 textarea、唯一“发 送”按钮及 `message-receipts`；再调用零参数 `prepare_xianyu_fulfillment`。工具缺失或失败立即暂停，绝不索要、读取或复述卡密。
8. 准备成功后原样调用 `xianyu-fulfillment.execute-intent`。发送后由网关强制重新快照；仅当回执数恰好增加 1 且最新状态为“未读/已读”时回填 `sent`。不明确时暂停且不重发。
9. 只有非秘密测试占位内容才可使用 `compose-test-message` / `send-test-message`；真实履约不得降级到测试工具。

## 结果格式

用简短检查表回报：目标订单（脱敏）、平台状态证据、订单号一致性、当前阶段、下一步或停止原因。不要复述完整买家标识、收货信息或消息秘密。
