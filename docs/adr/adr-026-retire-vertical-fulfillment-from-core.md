# adr-026: 垂直履约语义退出核心契约——垂直能力只在站点 pack 的 tools.json adapter 中声明

## 状态

已接受（2026-09-04，Terry 裁决 R-4，见 `../plans/2026-09-03-terry-rulings-and-next-round.md`）。

## 背景

首个垂直域（闲鱼卖家「发货 + 发卡密」）在 adr-016..019 的落地过程中把业务语义固化进了平台核心契约：

- **C6 模块端口**多出 `CardInventoryPort`（飞书轻量库存账本）与 `FulfillmentCoordinatorPort`（卡密履约编排），
  端口清单由五端口变七端口；`ToolGatePort` 上另挂六个履约方法（预授权、意图登记、回执确认）。
- **C1 工具定义**多出 `authorization: BoundedFulfillmentAuthorization`，其 `workflow` 是电商闭集
  `'shipment' | 'delivery'`；其下 `preparation`（adr-019）是一整套声明式意图准备原语。
- **toolgate** 因此持有履约策略、订单日额度、预占状态机，并把「发货」按钮标签写成了判定闭集。
- **server** 因此有 `prepare-intent.ts` 引擎、`prepare.<toolId>` 工具面生成、库存回填分支，
  以及 `ZA_FULFILLMENT_*` / `ZA_FEISHU_CARD_*` / `ZA_FEISHU_PROFILE` / `ZA_LARK_CLI_PATH` 组装配置。

adr-019 曾以「pack 声明式 preparation」把站点硬编码从核心挪进 pack 声明，但 `workflow` 闭集、
服务端 shipment/delivery 分支与两个业务端口仍留在核心。真泛化的锚点原定为「第二个履约站点 pack 接入时」，
该锚点始终未到达：全仓只有一个垂直域在用这套抽象，两个包与一层契约因此只服务于一个站点。
这既违反 ZA-C-META-01（复杂度须能自证），也让 U4「快照是唯一事实源」需要为 `fulfillment` 双源开豁免。

## 决策

**垂直履约语义全部移出核心契约。今后垂直能力一律在各站点 pack 的 `tools.json` adapter 中声明。**

1. **两包整包退役**：删除 `packages/card-inventory` 与 `packages/fulfillment`，
   连同 workspace 引用与 `apps/server` 的依赖声明。
2. **C6 回到五端口**：`AssemblyPort / ToolGatePort / LlmPort / AuditPort / UserConfigStore`。
   `ToolGatePort` 只保留通用治理面（判定、批准复核、任务级授权、签发/核销、server 直调）。
3. **C1 删 `authorization`**：`BoundedFulfillmentAuthorization`、`IntentPreparation` 及其参数源/元素绑定/
   证据原语一并删除；`tool-definition.schema.json` 与 `pack.schema.json` 的 `additionalProperties: false`
   使得任何仍声明 `authorization` 或 `capabilities.preparation` 的制品在载入期即被拒。
4. **toolgate 只留通用治理**：删履约端口方法、策略/额度/预占状态机与「发货」按钮标签闭集。
   `riskTier` 分级、HITL（含 `hitlMode: 'every-call'`）、nonce 一次性与定向签发语义**不变**。
5. **server 删履约装配**：`prepare-intent.ts`、`prepare.<toolId>` 工具面、库存回填分支与相关 env 解析全部移除。
6. **示例包降级**：`xianyu-seller` 的 `xianyu-fulfillment.execute-intent` 与 `xianyu-shipping.execute-intent`
   两个有界工具删除；该功能余下的两个工具（`compose-test-message` / `send-test-message`）本就是普通
   dom + `hitl` 声明，原样保留，功能因此以纯 adapter 声明形态存续。
   依赖准备器的 `skills/fulfill-xianyu-order/` 删除。

## 后果

**契约面**：C6 端口清单与 C1 字段闭集收窄，两者都是**破坏性**变更——外部 pack 若声明 `authorization`
或 `capabilities.preparation` 将载入期拒载。仓内无此类制品。

**U4 恢复干净**：`fulfillment` 曾是快照之外的第二个业务事实源，本次退役后 U4 不再需要 L0 豁免。

**用例数下降**（基线 1619 → 1549，−70，逐条去向）：

| 去向 | 条数 | 原因 |
|---|---|---|
| `packages/card-inventory/test/index.test.ts` | −10 | 整包退役 |
| `packages/fulfillment/test/index.test.ts` | −8 | 整包退役 |
| `packages/contracts/test/schemas.test.ts` | −7 | 3 条 `authorization`/`preparation` 合法工具样例 + 4 条其非法形态拒收样例；另有 1 条改写为「声明 `authorization` 即被拒」的契约闭合用例（替换，不计增减） |
| `packages/assembly/test/index.test.ts` | −3 | preparation 跨字段完整性拒载 |
| `packages/assembly/test/pack-v2-loading.test.ts` | −2 | `capabilities.preparation.workflows` 闭集交叉校验 |
| `packages/toolgate/test/index.test.ts` | −20 | ADR-016 有界履约整组 17 条 + 定向面 3 条 bounded 专属 |
| `apps/server/test/prepare-intent.test.ts` | −9 | 准备器引擎整文件 |
| `apps/server/test/server.test.ts` | −8 | 7 条履约端到端 + 1 条 adr-019 第二 pack 接入验收 |
| `apps/server/test/directed-exec.test.ts` | −2 | bounded 工具不支持定向的两条 |
| `apps/server/test/generic.test.ts` | −1 | `parseFulfillmentProductKeys` |

`packages/contracts/test/pack-v2.test.ts` 用例数不变：一条 `capabilities.preparation.workflows` 形态非法
用例改写为「声明 `capabilities.preparation` 即被拒」。

**覆盖面损失**：`scripts/e2e/run-xianyu.mjs` 随之删除（其五个阶段全部是发货→卡密→回执闭环）。
该脚本顺带覆盖的两点——任务标签组命名为 Zen、知识附件正文进入真实 gateway→LLM 请求——**在本仓失去 E2E 覆盖**；
`pnpm test:e2e:xianyu` 与 `verify:phase3` 对它的引用一并移除。补覆盖锚点 = 下一次 E2E 门梳理。

**发布链路残余**：`release/remote/env.example`、`release/remote/activate-release.sh`、
`release/test/verify-release-contract.mjs` 仍带 `ZA_FEISHU_CARD_*` / `ZA_FULFILLMENT_GUIDE_URL` 条目与
`lark-cli` 冒烟分支；镜像内 `lark-cli` 与 `LARKSUITE_CLI_CONFIG_DIR` 卷同样保留。
它们已不被服务端读取。清理锚点 = 下一次可在 Linux 发布镜像内跑 `release/test/activate-release.behavior.sh`
（该脚本依赖 `flock`，开发机不可跑）时一并处理。

## 迁移路径：垂直能力今后怎么表达

站点 pack 在 `features/<id>/tools.json` 里用**普通工具声明**表达垂直动作，不再有平台侧业务分支：

- **动作本身**：`execution: 'client'` + `adapter.kind: 'dom'`（页面代操作）或 `ClientAdapter`/`ServerAdapter`
  （宿主 API）。业务参数写进工具自己的 `params`，由服务端按该 schema 校验。
- **风险闸门**：`riskTier: 'hitl'`；对外不可撤回的动作加 `hitlMode: 'every-call'`，每次单独确认、不复用任务级授权。
- **证据闭环**：`adapter.snapshotEvidence` 声明结构化证据配方，配合 `feature.md` 的规则要求
  agent「操作前后各取一次快照并比对」——回执判定由 agent 在治理边界内完成，不再由平台写死状态机。
- **额度与去重**：属站点业务约束，写进 pack 的 `feature.md` 规则或该站点自有服务端；平台不再持有订单键与日额度。

平台侧不为任何垂直域新增端口、字段或分支。若将来出现跨多个站点复用的共性需求，
先按 ZA-C-META-01 论证并另起 ADR，不得回填本次删除的形态。
