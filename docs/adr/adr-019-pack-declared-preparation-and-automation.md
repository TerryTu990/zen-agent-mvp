# adr-019: pack 声明式 intent 准备与周期自动化（P1 去 xianyu 硬编码的契约扩展）

## 状态

提议（2026-08-04 初稿，P1「内核归一」的设计基准，待 Terry 复审；实施分批见「后果」）

## 背景

`main`（d9d51ed 起）的闲鱼硬编码清单已查实，集中三处；而 `packages/{toolgate,fulfillment,card-inventory,assembly}` 与 `contracts` 类型层经 grep 验证零 xianyu 引用——通用地基已在,缺的只是"站点知识进 pack 声明"的契约面：

1. **prepare 连接器**：`apps/server/src/xianyu-{fulfillment,shipping}.ts` 把站点知识写死在代码——origin/hash 路由、URL 参数名（itemId/orderId）、元素选择（唯一 textarea / label「发送」「发货」按钮）、证据规则 id、状态字面量（待发货/已发货）、订单编号标签匹配、45s intent 时效。
2. **gateway 分支**：`gateway.ts` 按 `featureId === 'xianyu-*'` 决定注入哪个 prepare 工具（L928-936）、按工具 id 字符串 `xianyu-shipping.execute-intent` 区分 shipment/delivery 执行流（L605）、写死自动扫描完成帧 toolId `'xianyu-auto-scan'`（L1608/1620）。
3. **extension 周期触发**：`xianyu-auto-scan.ts` 写死工作页路由、中文扫描提示词、完成帧 toolId；options/背景页文案闲鱼专属。

关键假设（实施前提）：prepare 原语闭集 v1 **只从上述两个既有连接器逆推**，不为想象中的站点超前设计（META-01/HOW-02）；`workflow: shipment|delivery` 闭集维持不变；C6 端口签名与 `PrepareCard*Input` 类型以 ports.ts 现状为准、目标零改动；LLM 工具名含点号已被现状消化（host toolId 即含点号直传 LlmToolSpec.name）。

## 决策

### 1. 执行流分支去字面量（无契约变更，先行批次）

`runExecSubflow` 的 `isShipment` 判据从 `tool.id === XIANYU_SHIPPING_EXECUTE_TOOL_ID` 改为 `tool.authorization?.workflow === 'shipment'`——信息本就在工具定义里。`XIANYU_SHIPPING_EXECUTE_TOOL_ID` 常量删除。

### 2. C1 扩展：`authorization.preparation`——prepare 工具由 pack 声明驱动

prepare 工具与 bounded-fulfillment 工具是 1:1 配套（prepare 产 opaque intentId，唯一喂给 `intentIdParam`），故声明挂在 `$defs/boundedFulfillmentAuthorization` 下新增可选 `preparation` 对象；**有声明才注入**。

- **注入规则通用化**（替换 featureId 分支）：当轮工具面存在带 `preparation` 的 bounded-fulfillment 宿主工具、且履约依赖已组装（fulfillment 端口 + productKeys 闭集非空，沿 adr-018 条件），网关为每个此类工具注入零参数 prepare 工具；名称派生 `prepare.<toolId>`，description 取 `preparation.description`（站点语义文案随 pack 走）。
- **原语闭集 v1**（语义全部 fail-closed：缺失/不唯一/不匹配即拒绝准备，与现 derive 行为逐条对齐）：

```jsonc
"preparation": {
  "description": "…",                    // 必填：prepare 工具面向 LLM 的描述
  "routes": ["/im"],                     // 激活页 hash 路由白名单；origin 恒取 pack.site.origin
  "params": {                            // 业务参数派生：只取可信 URL/快照，模型零参数（adr-016 不可扩张面）
    "orderId":   { "source": "hash-query", "name": "orderId", "pattern": "^[A-Za-z0-9_-]{1,128}$" },
    "productId": { "source": "hash-query", "name": "itemId" }
    //           | { "source": "element-href", "urlOrigin": "https://…", "urlPath": "/item", "queryParam": "id" }
  },
  "productParam": "productId",           // 经服务端 productKeys 闭集映射为库存 productKey 的参数名
  "elements": {                          // DOM ref 绑定：按 role[+label] 唯一命中，含 disabled 拒绝
    "messageRef": { "role": "textarea" },
    "sendRef":    { "role": "button", "label": "发送" }
  },
  "paramEvidence": {                     // 可选：参数-页面一致性证据（如订单编号回显）
    "param": "orderId", "roles": ["cell","td","dt","dd","span"], "labelPrefixes": ["订单编号"]
  },
  "evidence": { "rule": "order-shipment-status", "before": "待发货", "after": "已发货" },
  //             ↑ 必须引用同工具 adapter.snapshotEvidence 的 id，载入期校验存在；delivery 只填 rule
  "intentTtlMs": 45000                   // 1000..300000
}
```

- **通用引擎**：新 `apps/server/src/prepare-intent.ts` 解释声明，按 `workflow` 产出 `PrepareCardFulfillmentInput` / `PrepareCardShipmentInput`（端口与类型零改动）；`xianyu-{fulfillment,shipping}.ts` 删除，站点知识全量迁入 `assets/packs/xianyu-seller` 的 tools.json。引擎遇声明外形态一律拒绝——原语是闭集，不留表达式后门。
- 元素 label 匹配沿现 derive 的归一化语义（去空白比对）；`paramEvidence` 的前缀匹配吸收现「订单编号 / 订单编号: / 订单编号：」变体为「前缀 + 可选冒号分隔符」通用规则。

### 3. pack.json 扩展：`automations[]` + 描述符下发——周期触发由 pack 声明

```jsonc
"automations": [{
  "id": "xianyu-auto-scan",              // kebab 命名；载入期跨 pack 查重 fail-closed
  "prompt": "执行闲鱼自动履约扫描。…",     // 自动回合的用户侧提示词（纯数据）
  "workRoutes": ["#/seller-trade/order-manage", "#/im"],
  "executionPreference": "dom-only",
  "defaultPeriodMinutes": 5              // 1..60，extension 侧仍可由用户改
}]
```

- **服务端**：assembly 载入并校验；新增只读 `GET /v1/automation-descriptors`（平台 JWT 鉴权，输出各已装 pack 的 `{origin, automations[]}`）。自动回合完成帧 tool-card 的 toolId 改用 automation id（去掉 L1608/1620 字面量）；C3 上行 `auto-scan` 帧补可选 `automationId` 字段（加法兼容）供服务端关联。
- **extension**：alarm/组级单飞锁/SW 恢复/暂停规则全部按 automation id 通用化（逻辑不变，仅参数化）；工作页判定 = 描述符 origin + workRoutes；options 页由描述符渲染开关与周期。扩展启动与配置变更时拉取描述符,拉取失败保持关闭（fail-closed 不扫描）。
- **治理不变**：一单预算、run 状态机、完成帧广播全在服务端，与描述符内容无关（adr-018 语义原样保留）；描述符是展示/调度数据，不承载任何治理判定（U7）。

### 4. 兼容与迁移

- schema 变更全部为**可选字段新增**（tool-definition `preparation`、pack `automations`、C3 `automationId`），旧 pack/旧帧原样有效（U3/U4 加法路径）；无 `preparation` 的 bounded-fulfillment 工具不注入 prepare 工具，与现非闲鱼 featureId 行为一致。
- `xianyu-seller` pack 升 0.8.0：两个 execute-intent 工具补 `preparation`，pack.json 补 `automations`；改 assets 必跑该 pack eval（ZA-EVAL）。
- env `ZA_FULFILLMENT_PRODUCT_KEYS_JSON` 名称与结构不变（productId→productKey 本就通用），仅修 index.ts L91 注释；`GatewayDeps.fulfillmentProductKeys` 注释同步去闲鱼字样。

## 理由

- 判定基准（2026-08-04 产品规划 §1）：闲鱼诉求先表达为 pack 声明,不能表达才扩契约,最后才进核心——本设计把仅剩的三处硬编码全部收进前两层。
- 原语闭集从两个真实连接器逆推,每条原语都有现职责对应,答得上宗旨基准;闭集 + fail-closed 保住 adr-016 的核心防线（模型零参数、服务端可信取证）不因声明化而松动。
- pack 自治直接兑现 P1 验收「第二站点零核心改动」;声明是纯数据,同时满足 CWS 远程代码红线（P3 前置）。
- 业界参照：按声明驱动行为的原语闭集 = Chrome 扩展 declarativeNetRequest / Home Assistant 集成 manifest；能力描述符由服务端下发 = MCP tool listing。

## 被否方案

- **通用表达式 DSL**（JSONPath/脚本片段进 pack）：表达力开放导致治理面不可审计,且触碰 CWS 远程代码红线;宗旨基准答不上。
- **服务端连接器注册表**（pack 只声明 connector 名,derive 代码留 server）：新站点仍需改核心发版,P1 验收直接失败——只是把硬编码换个挂法。
- **prepare 建模为 `execution:'server'` 工具进 tools.json**：serverAdapter 语义是宿主 HTTP API 直调（U3 双通道）,intent 准备是治理动作、无 URL 语义;塞入会污染通道闭集,且 riskTier/adapter 字段全不适用。

## 后果

- 正：`apps/` 与 `packages/` 源码 grep 无 xianyu（测试 fixture 除外）；闲鱼能力全由 pack 0.8.0 承载；E2E（run-xianyu.mjs）验收口径不变。
- 负：`preparation` 是新契约面,新站点画像超出闭集时需契约 minor 迭代（刻意成本,换审计性）；新增一个只读描述符 endpoint,`reference/02-contracts.md` 需补记。
- 实施分批（每批独立可验证）：**①** 执行流分支去字面量（纯重构 + 现测试回归）；**②** C1 `preparation` + 通用引擎 + 删两个 xianyu 模块 + pack 0.8.0 迁移 + eval 回归；**③** pack `automations` + 描述符 endpoint + extension 通用化；**④** host-demo 改造为第二消费方作零改动验收 + 随③清理 auto-scan 相关文案（其余品牌文案属 P2）。
- 锚点：原语闭集不满足新站点时 → 契约 minor 扩集,不开表达式后门；pack 越出本仓分发时 → 签名与来源信任（承 adr-013 既有锚点）。
