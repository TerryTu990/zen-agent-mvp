# adr-022: 匿名自动登录（安装 id → 短期 JWT）

## 状态

提议（2026-08-06，Terry 裁决；**修订 adr-014 §1 的三签发形态表**——签发形态收敛为两种：
当前匿名自动登录 → P4 Google 账号；了结「通用插件默认身份」的形态待定）

## 背景

设计基准 SSOT v2（2026-08-04）把定位从「ToB 宿主系统的嵌入式功能辅助」换轨为「可被用户塑形的
通用浏览器 agent」。adr-014 §1 的三签发形态表建立在旧定位上，其中两种在新定位下已无立足点：

- **ToB 宿主签发**：宿主系统内嵌形态在产品上不存在，也就没有签发方；
- **匿名密钥对（公钥指纹为 hostUserId，可签名请求）**：从未实现，且其防伪造收益在当前阶段无对应资产。

现状事实与目标之间的差距：插件 `identity.ts` 的 `getToken()` 只读手填的
`chrome.storage.local['za.token']`，无值即抛错；另有 `provisionToken()` 走 ToB 遗留的
`POST /demo-token`（env 门控的演示自签端点）。配置中心与 options 页把「访问令牌」暴露为必填项。
产品目标是**插件装上就能用，用户一个字都不用填**——手填令牌与这条目标直接冲突。

服务端验签面（`apps/server/src/auth.ts`：HS256 + iss 白名单 + C2 claims 闭集
`{sub, tenant, roles, hostUserId, iss, exp}`）本身健全，本 ADR 不动它。

Terry 2026-08-06 裁决（本 ADR 的最高口径）：当前所有插件一律自动匿名登录；访问控制后期再加；
正式投产必须上 Google 账号登录；除此之外的身份机制（密钥对、challenge-response、一次性 nonce、
TTL store、多形态优先级链）判定为过度设计，全部去掉。

## 决策

### 1. 签发形态收敛（对 adr-014 §1 的修订）

| 形态 | 签发方 | hostUserId | 状态 |
|---|---|---|---|
| 匿名自动登录 | 服务端激活端点（本 ADR） | 安装 id 的 SHA-256 派生标识 | **当前唯一形态** |
| 平台账号 | 平台身份服务（Google OIDC，adr-014 §1 绑定链路） | 平台账号 ID | P4；正式投产前置条件 |

删除的形态：ToB 宿主签发（无签发方）、管理员手填令牌（非形态，是缺省形态缺位的人工补丁）、
匿名密钥对 + challenge-response（见「被否方案」）。C2 claims 闭集与验签逻辑零改动，`iss` 仍是
形态区分位；本 ADR 只在 iss 白名单加一个值。

### 2. 安装 id（客户端持有型凭证）

- 插件首次运行 MUST 生成一个 122 位以上随机的安装 id（`crypto.randomUUID()` 即满足），存
  `chrome.storage.local['za.installId']`；后续运行复用同值。
- MUST NOT 引入密钥对、签名、IndexedDB 或任何额外持久化机制。
- 安装 id 是**持有型凭证**：MUST NOT 进入仓库、审计事件、日志、错误响应或测试夹具字面值
  （ZA-C-SEC-01/04）。

### 3. 激活端点

- `POST /v1/activation`，请求体 `{installId}`，响应 `{token, expiresAt, hostUserId}`。
- 端点 MUST 恒启用：无 env 门控、无开关；MUST NOT 要求 `Authorization`（安装 id 本身即凭证）。
- 路由 MUST 先于 verifier 判定（激活是取令牌的前置，不能被验签拦住）。
- 激活是**插件形态内部实现**：MUST NOT 成为 C3 消息帧型，MUST NOT 让接入层五能力或网关按客户端
  形态分支（U5）。

### 4. 身份派生

- `hostUserId = 'anon-' + base64url(SHA-256(installId))`；`sub` 与 `hostUserId` 同值；
  `tenant = 'anon'`；`roles = ['user']`；`iss = 'zen-agent-anon'`；有效期 24h。
- 服务端 MUST NOT 存储或记录 installId 原值——只使用其哈希；派生是纯函数，不需要任何映射表。
- 响应 `expiresAt` 与载荷 `exp` 同值同单位（epoch 秒）；契约以 2100 年为上界作单位守卫，
  发毫秒会被契约当场判错。
- 匿名 iss 由服务端在组装时无条件并入验签白名单：签发方与验签方同属一个进程，
  运维的 `ZA_JWT_ISS_ALLOWLIST` 只管外部签发方，MUST NOT 出现「服务端签出自己随即拒绝的令牌」。

### 5. 令牌生命周期

- token 存 `chrome.storage.local['za.anonToken']`；过期或收到 401 时以同一 installId 重新激活。
- 缓存与退避状态一律按服务端地址归属：换地址即换签发方（secret 可能不同），旧地址的令牌一律
  视为未命中，一台服务端连不上也 MUST NOT 连累另一台（「改对地址即刻可用」）。
- 重新激活 SHOULD 退避 + 单飞（复用插件内既有写法）；MUST NOT 形成重试风暴。
- 会话作废条件由侦听 `za.token` 改为侦听 `za.installId` 变更（换身份 = 换 installId）；
  该分支 MUST 同时作废已缓存令牌（内存 + 落盘），在途激活的旧身份结果 MUST NOT 回写缓存。

### 6. 失败语义（fail-closed，U7）

- 令牌不合法（签名/iss/exp/claims 任一不满足）一律拒绝：无降级分支、无匿名兜底、无客户端本地放行。
- 激活是唯一未鉴权的收体入口，故请求体有固定字节上界（声明值与实收值都查，超限即 413），
  未鉴权方 MUST NOT 能让服务端缓冲任意大的载荷。
- 激活失败时插件如实报错并停在未登录态，MUST NOT 伪造本地身份继续会话。
- 面向客户端的错误消息 MUST NOT 含 installId、token 或 JWT 原文（ZA-C-SEC-04）。

### 7. 删除面

- 客户端：`za.token` 的全部读取路径、配置中心「访问令牌」输入框与保存链路、`options.html` 对应
  字段与 `options.ts` 相关分支——全删。存量 `za.token` 键不写迁移或清理代码（不再被任何路径读取，
  留着无害；简洁优先）。
- 服务端：`demo-token.ts`、其 gateway 路由、`ServerOptions.demoToken`、`main.ts` 接线与
  `ZA_DEMO_TOKEN_ENABLED` 全删；`issAllowlist` 默认值由 `'zen-agent-demo'` 改为 `'zen-agent-anon'`，
  并同步 `docker-compose.yml`、`release/remote/env.example`、`docs/reference/03-configuration.md`、
  `docs/reference/04-deployment.md`。
- 发布链路：`release/README.md`、两份 release SKILL.md 与 `release/build-extension.sh` 的
  「管理员签发令牌 → 用户选项页粘贴」接入流程全删，改为「身份零配置」。`release/remote/sign-token.sh`
  连同 `deploy-server.sh` 对它的同步一并删除：它以验签白名单首项为 `iss` 可签出任意 `hostUserId`
  的可用令牌，与「只留一条路」相悖；运维应急场景由匿名激活覆盖，不保留备用签发入口。

### 8. E2E 身份预置

- 默认零预置：脚本不再写入任何令牌，插件自行激活。
- 需要控制或切换身份的用例预置 `za.installId`。
- 「无效令牌 → 401」用例预置一个伪造的 `za.anonToken` 触发 401 路径。
- `serve-acceptance.mjs` 去掉 demo-token 启用与自签令牌打印。

## 理由

- **单路径即最优**：目标「一个字都不用填」只允许一条取令牌的路。删除手填与 demo-token 后，
  客户端身份链路只剩「有 installId → 换 token → 用」，401 语义、文档、E2E 各一份（HOW-02）。
- **为何接受「无持有证明」**：谁拿到安装 id 谁就能冒充——这是明确权衡后的裁决，不是疏漏。
  安装 id 只存本地、只经 HTTPS 发往服务端、122 位以上随机不可枚举；当前阶段匿名 subject 名下
  没有付费、配额或跨设备资产，冒充收益接近零；真正的身份强度由 P4 Google 登录提供，投产前必须上。
  可核查项是「不可枚举 / 不落盘 / 不进日志」三条，形态本身不再重开。
- **为何 installId 必须哈希后再当 hostUserId**：hostUserId 会出现在
  `.za/user-config/<tenant>/<hostUserId>.json` 的文件名、审计事件与日志/错误路径中。裸用 installId
  等于把 bearer 凭证摊到磁盘和日志上（SEC-01/04）。SHA-256 单向且定长，base64url 落在文件名安全
  字符集内（`user-config-store` 的 percent-encode 分段仍是兜底，不构成依赖）。`anon-` 前缀为匿名
  subject 保留命名空间，避免 P4 账号 subject 与之碰撞。
- **验签面零改动**：身份形态演进只动签发侧，验签仍是同一段代码同一决策点（U7）；本 ADR 对 auth.ts
  的全部影响就是 iss 白名单多一个值。
- **业界参照**：VS Code machineId、Obsidian 本地优先 + 可选账号、Chrome 扩展安装态标识——
  「匿名本地标识起步、按需升级账号」是已验证范式；持有证明由账号体系而非自造挑战协议提供。

## 被否方案

- **密钥对 + challenge-response（出题作答、一次性 nonce、TTL store、多形态优先级链）**：裁定为过度
  设计。收益是防冒充，但当前没有可被冒充夺取的资产；成本是插件侧密钥持久化与签名、服务端 nonce
  存储与时钟窗口、全套 E2E 改造，且同等强度在 P4 由 Google 登录一次性获得。adr-014 §1「否决裸
  UUID：不可防伪造」的判据随本 ADR 收敛为「哈希后使用」，而非升级为密钥对。
- **裸 UUID 直接当 hostUserId**：bearer 凭证会进入 user-config 文件名、审计事件、日志与错误响应，
  等于把凭证写盘（SEC-01/04）。
- **保留手填令牌作兜底**：两条路径并存意味着双份 401 语义、双份文档、双份 E2E；更致命的是只要
  配置项还留在界面上，用户就会撞见并以为必须填，与「一个字都不用填」直接冲突。需要指定身份的
  真实场景（E2E、多身份调试）由预置 `za.installId` 完全覆盖。
- **保留 `/demo-token` 改名沿用**：该端点语义是 ToB 演示自签（env 门控 + 宿主 claims 形状），
  与匿名激活的恒启用、无门控、哈希派生不同；沿用会把已删形态的假设带进新路径。
- **服务端存 installId → hostUserId 映射表**：要求存储持有型凭证，且派生是纯函数、无需映射。

## 后果

- **正面**：安装即可用，配置面从「必填令牌」降到零；服务端删掉一个 env 门控端点与一条 ToB 遗留
  路径；E2E 不再预置凭证，身份切换语义单一化为「换 installId」。
- **负面**：无持有证明（上文已知取舍）；单一路径无兜底——激活端点故障时，已缓存 token 可扛到
  24h 过期，超期即全量阻断；匿名 subject 与设备绑定，换设备或清空 storage 即新身份，其 L2 overlay
  在 P4 迁移通道就位前会被孤立。
- **对 adr-014 的影响面**：仅 §1 形态表被修订；§2-§8（L2 契约、合并判定、装配链路、写入通道、
  存储故障语义、记忆防线）与 C2/C7 契约零改动。
- **实施映射**：客户端（installId 生成 + 激活调用 + token 缓存刷新 + 删手填面）→ 服务端
  （激活端点 + 派生 + iss 默认值 + 删 demo-token）→ E2E/文档同步。

### deferral 登记

| 项 | 触发锚点 | 状态 |
|---|---|---|
| Google 账号登录（OIDC，绑定链路见 adr-014 §1） | **正式投产前置条件**：面向真实用户投产（托管服务开放 / 商店正式发行）前 MUST 完成；实施期 P4 | 未了结 |
| 访问控制与用量配额（按 subject 限量） | P4 托管服务启动时，或匿名激活出现滥用信号（激活量异常）时 | 未了结 |
| 跨设备同步与 subject 迁移（匿名 overlay 归并入账号 subject） | Google 登录上线时（adr-014 §1 渐进绑定） | 未了结 |
| 「重置身份」按钮 | 与 subject 迁移同批（Google 登录上线后）——在此之前重置会孤立该 subject 的 L2 overlay | 未了结 |
| tenant'd pack 的 per-origin 宿主身份随宿主签发形态一并失效：`claimsByOrigin` 再无写入方，`site.tenant` 声明的 pack（`examples/acceptance/packs/codeflow-console` 的 `{{hostUserId}}` http 工具）恒被 toolgate 拒；`packScope`/`setOriginClaims` 的 tenant 分支暂留未删 | pack 契约清理批次，或 Google 登录上线后重新定义站点级身份注入 | 未了结 |
