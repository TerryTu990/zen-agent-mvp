# order-list 功能事实

## 页面构成

- 页面标题：`#page-title`（"订单列表"）
- 刷新按钮：`#btn-refresh`，重新拉取当前列表
- 订单表格：`#order-table`，列为 订单号 / 状态 / 金额 / 操作
- 订单号列内链接跳转订单详情页（`order-detail.html?orderId=<订单号>`）
- 每行"取消订单"按钮：`.btn-cancel`；已完成订单该按钮为禁用态

## 状态语义

- `待发货`：可取消
- `已完成`：不可取消

## 操作 API

- 取消订单：`POST /api/orders/{orderId}/cancel`，以用户会话身份发起，
  成功返回 `{ "ok": true, "orderId": "<订单号>" }`；对应工具 `order-list.cancel-order`。
