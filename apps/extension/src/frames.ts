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
  messageId?: string;
  executionPreference?: ExecutionPreference;
  automationRunId?: string;
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
  href?: string;
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
  pageInstanceId?: string;
  title?: string;
  elements: SnapshotElement[];
  notices?: string[];
  evidence?: Record<string, SnapshotEvidence>;
}

export interface ConfigDecisionFrame {
  type: 'config-decision';
  sessionId: string;
  draftId: string;
  decision: 'accept' | 'reject';
}

export type UpstreamFrame =
  | ContextReportFrame
  | UserMessageFrame
  | HitlDecisionFrame
  | ExecResultFrame
  | SnapshotReportFrame
  | ConfigDecisionFrame;

export interface TextDeltaFrame {
  type: 'text-delta';
  sessionId: string;
  delta: string;
  priority?: 'safety';
}

export interface TurnCompleteFrame {
  type: 'turn-complete';
  sessionId: string;
  messageId?: string;
  idle: boolean;
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
  expectedPageUrl?: string;
  expectedPageInstanceId?: string;
}

export interface ExecInstructionFrame {
  type: 'exec-instruction';
  sessionId: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
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

/** L2 配置草稿卡（adr-014 teach 流，U8）：服务端产草稿，用户经 config-decision 显式确认后才落盘。 */
export interface ConfigDraftFrame {
  type: 'config-draft';
  sessionId: string;
  draftId: string;
  /** packId="*" 为全局作用域；featureId 缺省 = 整 pack 生效；title 为人读作用域标签（确认卡 chip）。 */
  scope: { packId: string; featureId?: string; title?: string };
  /** 拟写入的 overlay 片段（纯数据）；用户须看到真实将写入什么。 */
  change: JsonObject;
  /** 人读摘要（已脱敏），确认卡展示用。 */
  summary: string;
}

export type DownstreamFrame =
  | TextDeltaFrame
  | TurnCompleteFrame
  | ToolCardFrame
  | HitlRequestFrame
  | ExecInstructionFrame
  | GuideActionFrame
  | SnapshotRequestFrame
  | ConfigDraftFrame;
