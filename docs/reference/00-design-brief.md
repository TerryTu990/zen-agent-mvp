# zen-agent-mvp 设计基准（Design Brief · SSOT v2）

> **v2 全面重写**（2026-08-04，Terry 裁决）：产品定位从「ToB 宿主系统的嵌入式功能辅助」换轨为
> 「可被用户塑形的浏览器 agent harness」。v1（2026-07-04 奠基版及其勘误）原文见 git 历史。
> 本文件仍是设计基准 SSOT：与后续产物冲突时以本文件 + Terry 裁决为准；实现细节的事实权威在代码与各 `.schema.json`。
>
> **叙事权威分工**：产品形态（信任阶梯/配置四层/形态规则 R1-R9/产品表面）见
> `../plans/2026-08-04-product-form-definition.md`；产品分期（P 线）见
> `../plans/2026-08-04-generic-extension-productization.md`；pack/L2/存储契约方案见
> `../plans/2026-08-04-site-pack-and-user-config-tech-plan.md`。
> 本文件管：定位宗旨、系统边界、架构不变量（U1-U8）、契约清单、决策索引、验收基准。

## 1. 项目定位与宗旨

**可被用户塑形的浏览器 agent harness**（「浏览器 agent 的 Claude Code / AI 时代的 Tampermonkey」）：
在任意站点上叠加 agent，按用户所在站点/功能（`packId`/`featureId`）动态装配规则、知识、工具面与
自动化，提供四档能力（信任阶梯）：

1. **功能讲解**（看）——基于 pack 事实的有据回答，配置未覆盖明确拒答
2. **UI 引导**（指）——高亮/滚动定位目标元素，锚点失配如实降级
3. **受控代执行**（做）——分级判定 + HITL + 一次性签名指令 + 审计
4. **自动化**（托管）——pack/用户声明的周期与事件触发任务，需确认项收口到人

**宗旨基准**（一切复杂度须能自证，两问皆答不上不引入）：**如何让 agent 更准确地辅助用户使用
当前站点，或让用户在治理边界内更自由地塑形这种辅助**。塑形自由不得以松动治理边界（§3/§4）为代价。

**差异化三件套**（单点「可定制」窗口有限，护城河在组合）：站点级 harness（pack）×
可托付的执行治理 × 中立与所有权（BYOK 多模型、配置纯数据可导出）。

参照系：机制层复用 zen-flux-mvp 已验证模式（装配三元组、tool_call 门禁、HITL 卡片、旁路审计、
provider 插拔、eval 纪律），只复制模式与契约、不共享代码。

## 2. 产品形态与版本演进

产品演进沿两条正交线：**P 线**（产品形态：P1 内核归一 → P2 品牌回归 → P2.5 透明性+L2 →
P3 商店合规 → P3.5 teach+分享 → P4 托管服务）与 **S 线**（架构：S1 服务端直调 → S2 配置中心 →
S3 多形态客户端 → S4 七系统拆分+状态外置）。关键维度的现状与终态：

| 维度 | 现状（MVP，生产在跑） | 终态（标准版） |
|---|---|---|
| 客户端形态 | Chrome 插件（side panel，adr-015） | 插件 / 嵌入 SDK / 浏览器壳，同一接入层契约（U5） |
| 能力 | 四档信任阶梯全部落地（自动化为 pack 声明式，adr-018/019） | 同左 + 配置后台化 + 灰度 |
| 工具执行通道 | client 代执行 + server 直调 + dom 可见步进（adr-010/011）三通道 | 同左，通道恒为工具定义的配置维度（U3） |
| 配置 | git 文件：registry（manifest.json）+ `packs/<packId>/`（adr-013/020）；pack 三来源（官方/社区/自建）契约统一 | S2 配置中心产出同构快照，消费端零改动（U4） |
| 用户层 | L2 用户覆盖层契约已裁决（adr-014），P2.5 落地 | 同契约，存储按触发条件外置 |
| 身份 | C2 短期 JWT；匿名自动登录（安装 id → 激活端点签发，adr-022）；渐进绑定：匿名 → P4 平台账号（Google 首发，正式投产前置条件） | 完整身份联邦（匿名 + 平台账号两签发形态并存，iss 区分） |
| 部署/多租户 | 模块化单体、单租户；多租户模型已裁决（共享内容+租户指针，adr-020） | 三级扩展：垂直 → 会话亲和水平复制 → S4 七系统拆分 |
| 会话 | 标签组会话、可跨站点（adr-012/013）；上下文治理 P0-P2 | 状态外置、SSE 集群 |
| HITL | 分级挂起 + 卡片确认 + 任务级授权（adr-016） | 同左 + pending 持久化跨端恢复 |
| 评测 | 六维度纪律（ZA-EVAL：讲解/引导/工具/HITL/拒答/自动化），官方 pack 强制 | 评测门内置发布流程 |

## 3. 七系统与职责边界（速览）

| # | 系统 | 职责 | MVP 落点 | 标准版落点 |
|---|---|---|---|---|
| ① | 客户端接入层 | 身份获取、上下文上报、会话 UI+HITL 卡片、页面动作（高亮/dom 步进）、代执行 | apps/extension | 三形态同一契约 |
| ② | 会话网关 | 验签、会话生命周期、装配调用（pack/featureId→注入，每轮换出）、agent loop、SSE | apps/server | 独立服务，状态外置 |
| ③ | 工具执行层 | **唯一决策点**（分级+身份校验+L2 收紧终值，fail-closed）+ 多通道执行器 + observation 规整回喂 | packages/toolgate | 独立服务 |
| ④ | LLM 接入层 | provider 白名单插拔、密钥托管、配额、故障切换 | packages/llm-port | 独立服务 |
| ⑤ | 配置中心 | registry + pack 管理、L2 用户覆盖层存取（UserConfigStore）、版本化快照发布 | git 文件 + `.za/user-config/` | 独立后台系统 |
| ⑥ | 身份联邦 | 短期 JWT 签发/验签/透传；两签发形态（匿名 / P4 平台账号，adr-022）；平台零特权、不存宿主凭证 | 网关内验签模块 + 匿名激活签发 | 独立/复用 IAM + 平台账号服务 |
| ⑦ | 观测审计 | record-only 旁路事件流（脱敏落盘）、操作审计、质量指标 | packages/audit → `.za/events.jsonl` | 独立服务 + DB |

**边界铁律**：装配对 agent 透明、治理不可被对话内容改变（已升格 U8）；决策永远服务端、客户端
零治理判定（U7）；审计永远旁路、故障不进控制流（U6）。

## 4. 平滑升级不变量（红线，落 `.claude/rules/ZA-WHERE.md`）

- **U1** 端口跨模块只传 JSON 可序列化值——拆服务时端口→RPC 不改契约。
- **U2** 模块间禁直接 import：只经 `@zen-agent/contracts` 类型 + 端口注入；组装唯一在 `apps/server`（依赖 lint 固化）。
- **U3** 工具定义含 `execution` 通道闭集；未实现通道保留枚举、fail-closed 拒绝不降级。
- **U4** 配置双源（adr-014）：L1 = 版本化不可变快照，文件布局与配置中心产出物**同构**（升级=换生产端
  不换消费端）；L2 = subject 维度运行期覆盖层，经 UserConfigStore 端口读写、revision（内容 hash）可追溯，
  显式排除在同构与不可变约束之外，自带只收紧/可审计/可追溯三约束；「旁门配置源」判定 = 快照布局之外
  且非 UserConfigStore 端口的配置源。
- **U5** 客户端接入层契约五能力不随形态变：身份获取 / 上下文上报 / 会话 UI+HITL / 页面动作 / 代执行。
- **U6** 审计事件 schema 独立于落点（jsonl → DB 只换 sink 不换 schema）；审计故障不进控制流。
- **U7** 决策（分级矩阵/HITL/L2 收紧合并）永远服务端 fail-closed；代执行指令一次性签名（nonce+ttl）；
  结果经服务端 schema 校验后才回喂 agent；存储故障不得导致治理放宽。
- **U8** **装配与治理对对话免疫**：装配注入与各层治理配置（L0 基座 / L1 pack / L2 收紧）MUST NOT
  被对话内容或模型输出直接改变；对话→配置的唯一通路是显式确认写入通道（草稿 → 用户确认 → 校验入库，
  adr-014）；治理注入每轮全量重建，结构上不参与历史压缩与记忆。

## 5. 契约清单（各出 `.schema.json` + 契约文档，schema 为准）

- **C1 工具定义**（`tool-definition`）：`{id, featureIds[], description, params, execution 闭集, riskTier('auto'|'hitl'|'forbidden'), adapter, resultSchema, authorization(含 preparation, adr-019)}`；pack v2 字段见 adr-020。
- **C2 身份契约**（`identity-claims`）：claims 闭集 `{sub, tenant, roles[], hostUserId, iss, exp}`；`iss` 区分签发形态（adr-022 后为匿名 / P4 平台账号两种）；平台零特权。
- **C3 客户端接入层**（`client-access-layer`）：五能力 + 消息帧闭集（上行 context-report / user-message / hitl-decision / exec-result；下行 text-delta / tool-card / hitl-request / exec-instruction / guide-action / dom 步进帧族）；P2.5-c 增 `config-draft`/`config-decision`（加法）。
- **C4 配置快照**（`config-snapshot`）：registry（`manifest.json{version, packs[]}`，演进含 source/hash/租户清单）+ `packs/<packId>/{pack.json, features/<id>/{feature.md, facts.md, tools.json}, skills/, docs/, eval/}`；纯数据（ZA-C-AGENT-03）。
- **C5 审计事件**（`audit-event`）：全链路事件结构，落盘前脱敏；P2.5-a 增 `user-config-write` 类型与 `userConfigRevision` 字段。
- **C6 模块端口**（TS 类型）：`AssemblyPort / ToolGatePort / LlmPort / AuditPort`（+P2.5-b `UserConfigStore`），全部满足 U1。
- **C7 用户覆盖层**（`user-overlay`，adr-014，P2.5-a 落地）：subject 键控、`"*"` 全局作用域、rules/facts/restrictions/packConfig/preferences；只收紧表达力（ZA-C-AGENT-04）。

## 6. 关键决策索引（详见 `docs/adr/`）

D1 插件优先 · D2 客户端代执行优先 · D3 决策与执行分离 · D4 模块化单体 · D5 复制 zen-flux 模式不共享代码 ·
D6 SSE 而非 WS · D7 配置先文件后 UI · D8 讲解质量第一 · D9 MVP 不做 DOM 自动化（被 D11 取代）·
D10（adr-010）server 通道与 credentialRef · D11（adr-011）可见页面代操作（dom 步进）·
D12（adr-012）会话=标签组 · D13（adr-013）站点包与跨站任务组 ·
**D14（adr-014）用户级配置层**：L2 契约、渐进绑定身份（§1 身份形态经 adr-022 修订）、故障语义拆分、U4/U8 配套 ·
D15（adr-015）Chrome side panel · D16（adr-016）有界履约授权 · D17（adr-017）飞书卡片库存 ·
D18（adr-018）周期履约触发 · D19（adr-019）pack 声明式 preparation 与自动化 ·
**D20（adr-020）pack 契约 v2**：三来源、capabilities/configSchema、registry 指针、多租户共享内容模型、存储矩阵 ·
D21（adr-021）用户自建自动化触发器 ·
**D22（adr-022）匿名自动登录**：安装 id → 短期 JWT、hostUserId 哈希派生、删手填令牌与 demo-token、Google 登录为投产前置条件。

## 7. 治理体系（两层，速查入口 `CLAUDE.md`）

- **开发期**：`.claude/rules/ZA-*.md`（COMMON 四类 + WHERE U1-U8 + AGENT 运行期边界 + EVAL 六维评测）
  + hooks 三件套（secret-guard / bash-guard / verify-on-stop）。
- **运行期**：`assets/`——system-prompt 基座（`ZA-SYS-*`）+ registry + packs（`ZA-FEAT-*`，仅约束
  本仓官方制品）；MUST NOT 进开发会话（ZA-C-AGENT-01）；pack 纯数据（ZA-C-AGENT-03）；
  L2 只收紧（ZA-C-AGENT-04）。

## 8. 目录现状

```
zen-agent-mvp/
├── CLAUDE.md / README.md
├── docs/{reference/, adr/（D1-D22）, plans/, design/（产品设计稿+UI 规范）, research/, roadmap.md}
├── .claude/{rules/, hooks/, skills/, settings.json}
├── packages/{contracts, assembly, toolgate, llm-port, audit, fulfillment, card-inventory}
├── apps/{server, extension}
├── assets/{system-prompt.md, manifest.json, packs/<packId>/…}
├── examples/host-demo/
└── .za/{events.jsonl, sessions/, user-config/（P2.5）, …}   # 运行态，gitignore
```

## 9. 验收基准

- **MVP 验收（v1 §9）已达成**：闲鱼生产闭环（讲解/引导/HITL 代执行/自动化 + 全链路脱敏审计）。
- **平台恒定验收**（任何阶段不豁免）：`pnpm -r build` + 串行 test 绿；依赖 lint（U2）；改 assets/
  过六维评测（ZA-EVAL）；审计脱敏抽查。
- **分期验收**：以 P 线各期验收基准为准（P1 已了结：核心 grep 无 xianyu、第二消费方零核心改动）。
- **完整产品验收（P4，北极星）**：新用户安装 → Google 登录/试用 → 在目标站点零手工配置完成
  一次讲解与一次 HITL 代执行 → 在配置中心完成一次个人定制（L2）并在注入透明视图中看到它生效。

## 10. 当前阶段范围声明

奠基期（治理+契约+骨架）与 P1（内核归一）已完成。当前阶段 = **P2.5 契约先行**
（C7 user-overlay + pack v2 字段 + C3/C5/C6 扩展，见技术方案 §5），随后 P2.5-b/c 实施与 P2 品牌回归。
本文件修订纪律：定位/铁律/不变量级变更 MUST 经 Terry 裁决并同步 `.claude/rules/` 与 CLAUDE.md，
一般演进以 ADR 增补、按需回写本文件。
