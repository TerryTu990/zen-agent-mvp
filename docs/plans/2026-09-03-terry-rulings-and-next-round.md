# 2026-09-03 八项裁决与下一轮工作序列

> 承接 `../reviews/2026-09-03-optimization-delivery-report.md` §6 的「待 Terry 裁决清单（8 项）」。
> Terry 已就八项全部作出裁决，本文是裁决原文 + 由裁决派生的影响面与下一轮工作序列。
> 裁决即生效：交付报告 §6、优化方案 §4、adr-025 §决策待定项均已改指本文。

## 1. 八项裁决

### R-1 R8 拒答边界 → 改为「事实边界」

**裁决**：采纳 adr-025 建议的改写方向。R8 由「配置未覆盖 MUST 明确拒答并指引安装 pack」
改为「站点功能的陈述 MUST 以 pack 事实与页面证据为准；未覆盖时 MUST 如实说明未能确认、
MUST NOT 臆造站点行为；与站点无关的通用请求不受此限」。

**连带生效**：SSOT §1 信任阶梯第 1 档措辞、`docs/design/ui-style-guide.md` §5/§7 的拒答气泡改事实边界提示、
`assets/system-prompt.md` 的 ZA-SYS-04 与 ZA-SYS-01 张力（原第 7 项待裁决随此条一并解决）、
adr-025 转 accepted。

**代价（Terry 已知悉）**：「敢答什么」的边界比拒答模式模糊；改基座措辞必须同步维护 mock-llm 探针字面。

### R-2 注入透明视图 → 四行摘要即终态

**裁决**：面板上下文条内的「本页生效」折叠块（站点包 / 功能 / 站点包工具 / 我的配置 revision
四行 + 配置中心入口）为 R4「来源可追溯」的终态载体，不重建 `11454c4` 删除的注入清单抽屉。

**连带生效**：改写产品形态文档 R4 的互证条款与北极星验收措辞到该粒度，不再指向已删除的抽屉。

### R-3 ZA_GENERIC_ALLOWLIST → 整个删除

**裁决**：删除该部署级站点准入名单。generic 兜底包在任何 http/https 页面无条件激活。

**判据**：该 env 缺省为空即「generic 兜底永不激活」，与 2026-09-03 起的通用助手定位直接矛盾；
`release/remote/env.example:59` 的 `ZA_GENERIC_ALLOWLIST=*` 是注释行，即开箱即用状态下
任何未装站点包的网页上都不注入页面工具面。

**删除面**：`ZA_GENERIC_ALLOWLIST` env、`parseGenericAllowlist`、`genericAllowlistAdmits`、
网关 generic 准入分支及其测试、`03-configuration.md` / `04-deployment.md` 条目、`env.example` 行。
静默页冷启动的 `open_url` 不再要求名单含 `*`（静默页本身仍不激活 generic 包——那是协议判定，不随本条变）。

**必须配套（见 R-8）**：本名单挡的从来不是隐私（内容脚本是 `<all_urls>` 全站注入，删除它不新增暴露面），
但删除后「银行页/内网别让 agent 介入」将没有任何开关。用户级站点黑名单因此从「本轮不做」提为下一轮必做。

### R-4 垂直履约语义 → 全部移出核心契约

**裁决**：`CardInventoryPort` / `FulfillmentCoordinatorPort` 退出 C6 端口清单；
`'shipment'|'delivery'`、「发货」按钮标签等电商语义不留在 toolgate。
今后垂直能力一律在各站点 pack 的 `tools.json` adapter 中声明，走与其他工具相同的通用通路。

**影响面（下一轮设计时逐项确认）**：`packages/contracts/src/ports.ts` 端口定义与 C6 文档三处口径、
toolgate 履约方法、`prepare.*` 工具面生成逻辑（现由 `fulfillmentProductKeys` 非空驱动）、
`packages/card-inventory`（10 例）与 `packages/fulfillment`（8 例）大概率整包退役、
`ZA_FULFILLMENT_POLICIES_JSON` / `ZA_FULFILLMENT_PRODUCT_KEYS_JSON` 两个 env 随之退场。

**与 R-3 的合流**：三个 L0 env 全部退场后，U4 双源模型（L1 快照 + L2 UserConfigStore）自动恢复干净，
**原第 3 项待裁决的「L0 运营者配置豁免」不必再在 SSOT 中开设**——这个结果优于原推荐的开豁免方案。

### R-5 快捷指令库 → 进产品形态，下一轮做

**裁决**：L1 站点包声明 `quickActions` + L2 用户自建，面板呈现为一排可点的常用指令。
定位为「用户塑形」主线上成本最低的一格，同时是新用户识别「这个站点能干什么」的入口。

### R-6 BYOK 与会话历史 → 分开排期

**裁决**：**会话历史列表进 P3.5**（无安全前置、用户感知强：现在关闭面板即丢失当轮对话）；
**BYOK 留 P4**，与第 1 条 secret 保险库合并裁决——两者是同一个问题：
SEC-02「平台零特权、不存用户凭证」之下，用户密钥的存储形态未定，不是写代码能绕过的。

### R-7 ZA-SYS-04 与 ZA-SYS-01 的张力 → 随 R-1 解决

见 R-1 连带生效项。

### R-8 未做项锚点 → 接受，三条提前

**裁决**：方案 §3 的十条锚点整体接受，其中三条提前到下一轮：

| 条目 | 原锚点 | 新安排 | 提前理由 |
|---|---|---|---|
| 用户级站点黑名单 / 站点权限档 | 首个外部用户试用前 | **下一轮必做** | R-3 删除 L0 白名单后用户侧无任何开关，不做即真空 |
| 不可信内容结构化定界 | 下一轮改基座措辞时 | **下一轮，与 R-1 合并** | 两者都改 `assets/system-prompt.md`，合并一轮共用一次全量评测 |
| 权限最小化注入 | P3 商店合规 | **下一轮** | 与站点黑名单是同一个隐私面；含「自动激活改点击激活」的交互变更 |

其余七条锚点不变：secret 保险库（待存储形态裁决）、注入检测器与参数污点（定界落地后仍失守时）、
限流与并发上限（对外部署前）、批准项签名与审计事件树（HITL 持久化 / S4 审计独立服务）、
pack 风险声明面（P3.5 pack 分发上线）、红队用例生成与动作级判据（注入评测维度建立后 / dom 场景量足够时）。

## 2. 下一轮工作序列

裁决之间存在依赖，按下列次序推进代价最低。

| 序 | 批次 | 内容 | 依赖 |
|---|---|---|---|
| 0 | N0 | `test:e2e:sidepanel` **重新开立为「不稳定门」专项**：同一 commit 上既有 14 次全绿、也有 3/3 红（401 阶段）；先前「误判、实为绿」的结论已更正。已顺带修好该脚本的启动回退缺陷 | 无 |
| 1 | N1 | **已交付**（2026-09-04，`4b1dc55`）：R8 改事实边界（product-form / SSOT §1 / UI 规范 / adr-025 落地），基座 ZA-SYS-04 随之改写并补探针；不可信内容结构化定界（L0 kind 闭集 + 每会话随机定界串 + 输入侧剥同形串 + 采集侧无损消毒），评测 97 场景 ×3。补遗（`6005adb`）：区内只留页面数据 JSON、同形串剥离下沉到序列化前并收窄定界串形状、摘要块补告诫、可疑句式加锚点 + 审计按类别去重 | — |
| 2 | N2 | **已交付**（2026-09-04）：删 `ZA_GENERIC_ALLOWLIST` 全链路 + L2 站点黑名单。主批 + 六轮修复，最终以两条不变量收敛：SD（命中页对服务端完全惰性：一份判定 + 三处出口）与 ST（停止为一处权威状态，所有页面副作用路径执行前必查）。9 条 minor 按收口规则登记为锚点（交付报告 §5） | — |
| 3 | N3 | **已交付**（2026-09-04，`4728e69`）：card-inventory / fulfillment 整包退役，C1 删 authorization + preparation 原语，C6 回到五端口，toolgate 删履约方法与「发货」标签闭集，server 删 prepare 引擎与全部 ZA_FULFILLMENT_*/ZA_FEISHU_* env（U4 恢复干净），xianyu-seller 示例包降级为普通 adapter 声明，adr-026。补遗：release/ 履约 env 与飞书冒烟退场（契约测试改为反向守卫，其字面即为保留的唯一命中）、DomGateContext 三个只写字段删除（其透传用例随之删除，用例 −1 非回归）、示例包升版、ADR 索引回填 | — |
| 4 | N4 | **已交付**（2026-09-04，`c96b548`）：R4 条文与北极星改写为「本页生效」块；快捷指令库——L1 `capabilities.quickActions` + L2 `quickActions`/`disabledQuickActions`，C3 user-message 加 `quickActionId`/`selectionText`，服务端展开只进用户轮，chips 与右键一份数据两入口，配置中心个人定制页。补遗（`b2b3622`）：chips 改经无会话投影端点取数（面板打开不建会话）、展开移入回合内绑本轮 compose 生效 pack、右键兜底项常驻 | — |
| 5 | N5 | **已交付**（2026-09-05，`b83d627`，adr-027）：manifest 删 `content_scripts`、host 权限降为可选；轨一手势/定向帧一次性注入（`sendActivate` 唯一出口，黑名单闸门在注入之前，content 幂等守卫）；轨二 L2 `grantedOrigins` ∩ 本机授权 − 黑名单 动态注册（确定性 id、对称注销、载荷恒为插件自带 `dist/content.js`）；`za.autoActivate` 删除，E2E 改用夹具；R9 加「需先授权站点」限定；不变量 IN 测试按触发源枚举，单测 1734 | — |
| — | 随批 | r2 的 12 条 partial 必修项，优先 `record_application` 进 describeInjection 与 L2 收紧面、复核/watch 快照同步 `domContext` | 无 |

P3.5 另计：会话历史列表（R-6）、pack 风险声明面与安装确认。
P4 另计：BYOK 与 secret 保险库（合并裁决存储形态后）。

## 3. 本文未决的事

- R-4 的具体迁移路径（两个包是整包退役还是降级为示例 pack 的适配器）留到 N3 出 ADR 时定。
- R-8 三条提前项与 r2 剩余 partial 项的轮次分配，视 N1/N2 实际工作量再切。
- 真实 LLM / 真实站点 E2E 仍 BLOCKED（凭证在 SEC-03 读禁区内），解除命令见交付报告 §2。
