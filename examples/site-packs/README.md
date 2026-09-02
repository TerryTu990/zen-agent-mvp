# examples/site-packs — 已下线的站点包

生产快照 `assets/` 只装通用包 generic-web；本目录保存曾上线、现已从生产 registry 下线的站点包，
作为完整可装配的快照根供测试与评测继续覆盖平台机制（订单识别、受控履约、per-task HITL 等）。

| pack | 站点 | 说明 |
|---|---|---|
| `xianyu-seller` | 闲鱼卖家 PC 端 | 数据导航、订单识别、飞书卡密预占与受控发货、周期自动扫描 |
| `yinxiang` | 印象笔记网页版 | 把外部网页读到的内容整理成笔记 |

重新上架 = 把 pack 目录移回 `assets/packs/` 并登记进 `assets/manifest.json`（registry 只加载已登记的 pack）。
