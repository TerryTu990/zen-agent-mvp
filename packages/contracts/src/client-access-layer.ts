/**
 * C3 客户端接入层类型——权威在 schemas/client-access-layer.schema.json，本文件为其手写同构投影。
 * codegen 引入锚点 = 契约首次进入高频变更期；在此之前改 schema 须同步手改本文件。
 * 五能力与帧闭集不随客户端形态变（U5）；所有帧 JSON 可序列化（U1）。
 */
import type { JsonObject, JsonValue } from './json.js';
import type { HttpMethod } from './tool-definition.js';

/** 五能力闭集（U5）：任何客户端形态实现同一组能力。 */
export type ClientCapability =
  | 'identity'
  | 'context-report'
  | 'conversation-hitl'
  | 'page-action'
  | 'delegated-execution';

export type HitlDecisionValue = 'approve' | 'reject';

export type ToolCardStatus = 'running' | 'succeeded' | 'failed';

/** 页面动作闭集：不含填表/替点等 DOM 自动化（D9，锚点=标准版后按真实需求评估）。 */
export type GuideActionKind = 'highlight' | 'scroll-to';

// ---- 上行帧（客户端 → 网关，HTTP）----

export interface ContextReportFrame {
  type: 'context-report';
  sessionId: string;
  url: string;
  title?: string;
  /** 客户端推断值仅供参考；权威判定在服务端 manifest.featureIdRules。 */
  featureId?: string;
  /** 白名单快照：仅含功能配置允许采集的字段。 */
  snapshot?: JsonObject;
}

export interface UserMessageFrame {
  type: 'user-message';
  sessionId: string;
  text: string;
}

export interface HitlDecisionFrame {
  type: 'hitl-decision';
  sessionId: string;
  hitlId: string;
  decision: HitlDecisionValue;
  comment?: string;
}

export interface ExecResultFrame {
  type: 'exec-result';
  sessionId: string;
  /** 关联 exec-instruction，服务端一次性核销（U7）。 */
  nonce: string;
  ok: boolean;
  status?: number;
  body?: JsonValue;
  error?: string;
}

export type UpstreamFrame =
  | ContextReportFrame
  | UserMessageFrame
  | HitlDecisionFrame
  | ExecResultFrame;

// ---- 下行帧（网关 → 客户端，SSE）----

export interface TextDeltaFrame {
  type: 'text-delta';
  sessionId: string;
  delta: string;
}

export interface ToolCardFrame {
  type: 'tool-card';
  sessionId: string;
  toolCallId: string;
  toolId: string;
  status: ToolCardStatus;
  /** 面向用户的已脱敏摘要；不下发完整 params/body。 */
  summary?: string;
  /** UI 分组用调用模式（纯展示）：client 用户会话代执行 / server 服务端直调 / mcp 客户端 MCP 调用。 */
  mode?: 'client' | 'server' | 'mcp';
}

export interface HitlRequestFrame {
  type: 'hitl-request';
  sessionId: string;
  hitlId: string;
  toolCallId?: string;
  toolId: string;
  /** 本次调用实参：用户须看到真实将发生什么。 */
  params: JsonObject;
  reason?: string;
}

/** 服务端已定值的最终请求，客户端不做模板求值。 */
export interface ExecRequest {
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  body?: JsonValue;
}

export interface ExecInstructionFrame {
  type: 'exec-instruction';
  sessionId: string;
  nonce: string;
  /** 自签发起的存活毫秒数，过期作废（U7）。 */
  ttl: number;
  /** 对 {nonce,ttl,toolCallId,request} 规范化序列的签名，插件执行前校验完整性。 */
  signature: string;
  toolCallId: string;
  request: ExecRequest;
}

export interface GuideActionFrame {
  type: 'guide-action';
  sessionId: string;
  action: GuideActionKind;
  /** 未命中时客户端静默降级为文字说明，不中断会话。 */
  selector: string;
  message?: string;
}

export type DownstreamFrame =
  | TextDeltaFrame
  | ToolCardFrame
  | HitlRequestFrame
  | ExecInstructionFrame
  | GuideActionFrame;

export type ClientAccessFrame = UpstreamFrame | DownstreamFrame;
