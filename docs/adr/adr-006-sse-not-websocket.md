# adr-006: 下行 SSE + 上行 HTTP，而非 WebSocket

## 状态

已接受（2026-07-04，源自架构对谈 D6）

## 背景

客户端与网关之间需要：下行流式（text-delta、tool-card、hitl-request、exec-instruction、guide-action）+ 上行离散请求（context-report、user-message、hitl-decision、exec-result）。候选：WebSocket 双工 vs SSE 下行 + HTTP 上行。

## 决策

C3 消息帧定为：下行 SSE 单向流，上行普通 HTTP 请求。

## 理由

- **流量形状本就不对称**：下行是连续流（token 流为主），上行是低频离散事件——双工通道解决的是不存在的问题。
- **负载均衡亲和**：SSE 是普通 HTTP 长响应，经过企业代理/网关/LB 的存活率显著高于 WS 升级握手；ToB 内网环境代理层复杂，这是决定性因素。
- **断线重连简单**：SSE 自带 Last-Event-ID 重连语义；上行 HTTP 天然无连接状态、易做幂等。
- **标准版扩展路径清晰**：网关无状态化后，SSE 集群化走 pub/sub 扇出（S4），比 WS 会话粘滞方案成熟。

## 被否方案

- **WebSocket**：双工能力冗余；代理穿透差；断线后双向状态恢复复杂；网关水平扩展需额外会话粘滞或消息总线，成本先付、收益没有。
- **HTTP 轮询**：token 流体验差（延迟/开销），直接排除。

## 后果

- 正：全链路都是普通 HTTP，可观测性、调试、企业网络兼容性最好。
- 负：真正需要双工的场景（无）不存在于当前能力清单；若未来出现（如客户端高频遥测流），届时单独评估，不预留。
- 负：SSE 单连接方向性要求上行消息自带会话关联（sessionId），已落 C3。
