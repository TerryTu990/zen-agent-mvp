/**
 * C5 审计事件类型——权威在 schemas/audit-event.schema.json，本文件为其手写同构投影。
 * codegen 引入锚点 = 契约首次进入高频变更期；在此之前改 schema 须同步手改本文件。
 * schema 独立于 sink（U6）：MVP jsonl → 标准版 DB 只换落点不换本结构。
 */
import type { RiskTier, ToolExecution } from './tool-definition.js';
import type { HitlDecisionValue } from './client-access-layer.js';

export type AuditEventType =
  | 'session-start'
  | 'session-end'
  | 'assembly'
  | 'tool-decision'
  | 'hitl-verdict'
  | 'tool-execution';

export type GateVerdict = 'allow' | 'hitl' | 'deny';

export type ExecutionOutcome = 'ok' | 'error' | 'timeout' | 'invalid-result';

export type ClientKind = 'extension' | 'sdk' | 'shell';

interface AuditEventBase {
  eventId: string;
  /** ISO 8601 date-time。 */
  ts: string;
  sessionId: string;
  /** 取值 = identity-claims.hostUserId。 */
  userId?: string;
  tenant?: string;
  featureId?: string;
}

export interface SessionStartEvent extends AuditEventBase {
  type: 'session-start';
  data: {
    clientKind?: ClientKind;
    iss?: string;
  };
}

export interface SessionEndEvent extends AuditEventBase {
  type: 'session-end';
  data: {
    reason?: 'user-close' | 'timeout' | 'error';
  };
}

/** 装配事件：与 describeInjection 同源，只记 id 与摘要、不记注入全文。 */
export interface AssemblyEvent extends AuditEventBase {
  type: 'assembly';
  data: {
    snapshotVersion: string;
    /** null = featureIdRules 无命中、仅装配稳定基座。 */
    featureId?: string | null;
    toolIds: string[];
    skillIds: string[];
    rulesDigest?: string;
  };
}

export interface ToolDecisionEvent extends AuditEventBase {
  type: 'tool-decision';
  data: {
    toolCallId: string;
    toolId: string;
    riskTier: RiskTier;
    verdict: GateVerdict;
    /** 判定依据说明，不含实参值与敏感信息。 */
    reason?: string;
  };
}

export interface HitlVerdictEvent extends AuditEventBase {
  type: 'hitl-verdict';
  data: {
    hitlId: string;
    toolCallId?: string;
    decision: HitlDecisionValue;
  };
}

/** 执行结局事件：不记请求与响应体本身。 */
export interface ToolExecutionEvent extends AuditEventBase {
  type: 'tool-execution';
  data: {
    toolCallId: string;
    toolId: string;
    execution: ToolExecution;
    nonce?: string;
    outcome: ExecutionOutcome;
    status?: number;
    durationMs?: number;
  };
}

export type AuditEvent =
  | SessionStartEvent
  | SessionEndEvent
  | AssemblyEvent
  | ToolDecisionEvent
  | HitlVerdictEvent
  | ToolExecutionEvent;
