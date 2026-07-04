# order-detail 功能事实

## 页面构成

- 页面标题：`#page-title`（"订单详情"）
- 详情定义列表：`#order-detail`，含 订单号 `#order-id` / 状态 `#order-status` / 金额 `#order-amount`
- 返回链接：`#link-back`，回到订单列表页（`order-list.html`）
- URL 参数 `orderId` 即当前展示的订单号

## 状态语义

- 与订单列表一致：`待发货` 可取消、`已完成` 不可取消
- 取消订单的操作入口在订单列表页，本页不提供

## 操作 API

- 无（本功能不配置工具）
