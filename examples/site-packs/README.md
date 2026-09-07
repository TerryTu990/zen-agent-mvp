# examples/site-packs — 已下线的站点包

生产快照 `assets/` 只装通用包 generic-web；本目录保存曾上线、现已从生产 registry 下线的站点包，
作为完整可装配的快照根供测试与评测继续覆盖平台机制（订单识别、per-task / every-call HITL 等）。

| pack | 站点 | 说明 |
|---|---|---|
| `xianyu-seller` | 闲鱼卖家 PC 端 | 数据导航、订单识别、消息页受控发送、周期自动扫描 |
| `yinxiang` | 印象笔记网页版 | 把外部网页读到的内容整理成笔记 |

重新上架 = 把 pack 目录移回 `assets/packs/` 并登记进 `assets/manifest.json`（registry 只加载已登记的 pack）。

## 履约工作流已随 R-4 退役

`xianyu-fulfillment.execute-intent` / `xianyu-shipping.execute-intent` 两个有界履约工具、
其 `authorization.preparation` 声明与 `skills/fulfill-xianyu-order/` 已随 adr-026 一并删除
（核心契约不再有 `authorization` 字段与履约端口）。
等价能力需以普通 adapter 声明重建：dom / http 工具 + `riskTier: 'hitl'`（对外不可撤回动作加
`hitlMode: 'every-call'`）+ `adapter.snapshotEvidence` 证据配方 + `feature.md` 的操作前后比对规则，
额度与去重写进 pack 规则或站点自有服务端。见 `../../docs/adr/adr-026-retire-vertical-fulfillment-from-core.md`。
