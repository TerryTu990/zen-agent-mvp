/**
 * C3 消息帧的插件侧镜像。SSOT = packages/contracts（schemas/client-access-layer.schema.json
 * 及其 TS 投影）；本包经 HTTP/SSE 与网关通信、零 @zen-agent 包依赖，故按 U5 契约手抄镜像——
 * 改契约须同步改本文件。
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type ClientCapability =
  | 'identity'
  | 'context-report'
  | 'conversation-hitl'
  | 'page-action'
  | 'delegated-execution';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type HitlDecisionValue = 'approve' | 'reject';
export type ExecutionPreference =
  | 'auto'
  | 'dom-only'
  | 'prefer-client-api'
  | 'prefer-server-api';
export type ToolCardStatus = 'running' | 'succeeded' | 'failed';
export type GuideActionKind = 'highlight' | 'scroll-to';

export interface ContextReportFrame {
  type: 'context-report';
  sessionId: string;
  url: string;
  title?: string;
  featureId?: string;
  snapshot?: JsonObject;
}

export interface UserMessageFrame {
  type: 'user-message';
  sessionId: string;
  text: string;
  executionPreference?: ExecutionPreference;
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
  nonce: string;
  ok: boolean;
  status?: number;
  body?: JsonValue;
  error?: string;
}

export interface SnapshotElement {
  ref: string;
  role: string;
  label: string;
  value?: string;
  disabled?: boolean;
}

export interface SnapshotEvidenceRule {
  id: string;
  itemSelector: string;
  statusSelector: string;
  statuses: string[];
}

export interface SnapshotEvidence {
  count: number;
  latest: string;
}

export interface SnapshotReportFrame {
  type: 'snapshot-report';
  sessionId: string;
  requestId: string;
  url: string;
  title?: string;
  elements: SnapshotElement[];
  notices?: string[];
  evidence?: Record<string, SnapshotEvidence>;
}

export type UpstreamFrame =
  | ContextReportFrame
  | UserMessageFrame
  | HitlDecisionFrame
  | ExecResultFrame
  | SnapshotReportFrame;

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
  summary?: string;
  mode?: 'client' | 'server';
}

export interface HitlRequestFrame {
  type: 'hitl-request';
  sessionId: string;
  hitlId: string;
  toolCallId?: string;
  toolId: string;
  params: JsonObject;
  reason?: string;
}

export interface ExecRequest {
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  body?: JsonValue;
}

export type DomStepAction =
  | 'navigate'
  | 'waitFor'
  | 'click'
  | 'fill'
  | 'select'
  | 'read'
  | 'scroll'
  | 'highlight';

export interface DomStep {
  action: DomStepAction;
  ref?: string;
  /** navigate 目标绝对 URL（ADR-013 批次④）：服务端签发前已校验落在某 pack site 围栏内。 */
  url?: string;
  to?: string;
  value?: string;
  name?: string;
}

export interface DomExecRequest {
  kind: 'dom';
  steps: DomStep[];
}

export interface ExecInstructionFrame {
  type: 'exec-instruction';
  sessionId: string;
  nonce: string;
  ttl: number;
  signature: string;
  toolCallId: string;
  request: ExecRequest | DomExecRequest;
}

export interface GuideActionFrame {
  type: 'guide-action';
  sessionId: string;
  action: GuideActionKind;
  selector: string;
  message?: string;
}

export interface SnapshotRequestFrame {
  type: 'snapshot-request';
  sessionId: string;
  requestId: string;
  evidenceRules?: SnapshotEvidenceRule[];
}

export type DownstreamFrame =
  | TextDeltaFrame
  | ToolCardFrame
  | HitlRequestFrame
  | ExecInstructionFrame
  | GuideActionFrame
  | SnapshotRequestFrame;
