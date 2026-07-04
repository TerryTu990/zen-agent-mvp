# adr-010: API 调用形态收敛为二发起通道 × 权限正交，MCP 从模式中移除

## 状态

已接受（2026-07-05，Terry 裁定）

## 背景

demo 期曾把 `client / server / mcp` 三值并列为"调用模式"（`apiMode` 字段），造成认知错位：client/server 是**发起方式**（信任边界——API 认谁的身份），mcp 是**传输协议**——两者正交，不应同轴并列。Terry 澄清真实分类后收敛。

## 决策

前端支持的 API 调用形态与配置方式：

| 形态 | execution | 可见性 | 身份 | 适用 |
|---|---|---|---|---|
| ① 客户端 JS 调 API | `client` | 不可见 | 用户页面会话 | 默认主形态（adr-002） |
| ② 客户端 DOM 代操作 | `client`（adapter 区分） | **可见** | 用户页面会话 | 见 adr-011 |
| ③ 服务端调 API | `server` | 不可见 | 平台级凭证 | 窄例外：平台范围、无需用户身份语义 |

- **权限正交**：`riskTier: auto | hitl` 独立于形态，对三形态统一适用。
- **配置全部在服务端**：`assets/features/<id>/tools.json` 按工具声明 `execution` / `adapter` / `riskTier`；客户端零配置零判定（U7）。
- **展示分组直接取 `execution`**：`apiMode` 字段删除（与 execution 冗余）；tool-card 的 `mode ∈ {client, server}`。
- **MCP 从模式中删除**：含 demo 工具、本地边车、全部枚举（commit 0674bc6）。

## 理由

- 发起方式的本质是信任边界（用户会话 vs 平台凭证），传输协议对其正交；混轴造成"MCP 是第三种发起方式"的误解。
- 删 mcp 后 `apiMode ⊆ execution`，冗余字段徒增漂移面。
- MCP 当前无真实用例，属投机复杂度（META-01）。

## 被否方案

- **保留 apiMode 独立展示轴**：与 execution 完全重复。
- **MCP 作为第三模式**：范畴错误；一个 MCP 调用本身既可客户端发也可服务端发。

## 后果

- 正：一根轴（execution）承载发起方式，用户/配置者心智单一。
- 锚点：真要接外部 MCP 工具生态时，以 `adapter.kind: 'mcp'` 落入同轴（与 adr-011 的 `adapter` 判别式 union 同机制），不动架构。
