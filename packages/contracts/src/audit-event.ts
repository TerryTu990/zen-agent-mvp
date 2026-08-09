/**
 * C5 审计事件类型——权威在 schemas/audit-event.schema.json，本文件为其手写同构投影。
 * codegen 引入锚点 = 契约首次进入高频变更期；在此之前改 schema 须同步手改本文件。
 * schema 独立于 sink（U6）：MVP jsonl → 标准版 DB 只换落点不换本结构。
 */
import type { RiskTier, ToolExecution } from './tool-definition.js';
import type { HitlDecisionValue } from './client-access-layer.js';
import type { UserConfigSubject, UserOverlay } from './user-overlay.js';

export type AuditEventType =
  | 'session-start'
  | 'session-end'
  | 'assembly'
  | 'tool-decision'
  | 'hitl-verdict'
  | 'tool-execution'
  | 'user-config-write';

export type GateVerdict = 'allow' | 'hitl' | 'deny';

export type ExecutionOutcome = 'ok' | 'error' | 'timeout' | 'invalid-result' | 'skipped';

export type ClientKind = 'extension' | 'sdk' | 'shell';

/**
 * 事件落点页标注（adr-023）：handle 为会话作用域不透明页面句柄（消费方禁解析内部结构，U5）；
 * origin 为该页 origin，URL 不可解析时省略。additive 扩展（U6），旧消费方可忽略。
 */
export interface AuditPageRef {
  handle: string;
  origin?: string;
}

interface AuditEventBase {
  eventId: string;
  /** ISO 8601 date-time。 */
  ts: string;
  sessionId: string;
  /** 取值 = identity-claims.hostUserId。 */
  userId?: string;
  tenant?: string;
  /** 会话激活的站点包（ADR-013）；无 pack 命中或 legacy 缺省时省略。 */
  packId?: string;
  /** 激活 pack 的 semver；随 packId 一同记录。 */
  packVersion?: string;
  featureId?: string;
  /** 本事件所属自动回合（C3 user-message.automationRunId）；人工回合缺省。 */
  automationRunId?: string;
  /** 发起该自动回合的自动化标识：pack 声明的 automation id（adr-019）或用户自建 watch id（adr-021）；人工回合缺省。 */
  automationId?: string;
  /** 本事件涉及的工作区页面（adr-023）：D1 于 tool-decision/hitl-verdict/tool-execution 以活跃页填充；定向落地（D2/D3）后为目标页。状态表无句柄时省略。 */
  page?: AuditPageRef;
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
    /** 本轮 compose 定格的 L2 overlay revision；与 user-config-write 事件互证（R4）。缺省 = 无 L2 参与。 */
    userConfigRevision?: string;
    /** true = 本轮 overlay 取自最近一次成功读取的缓存（读失败降级）；缺省 = 新鲜读取。 */
    userConfigStale?: true;
    /** L2 读失败且无缓存的拆分降级标注（rules/facts fail-open + 工具面全 forbidden，U7）；缺省 = 无降级。 */
    userConfigDegraded?: 'fail-open-closed';
    /** L2 越界引用（toolId 已不在激活 pack 工具闭集）逐条失效清单；缺省 = 无。 */
    invalidRefs?: string[];
    /** true = 激活 pack 被用户 enabled:false 关停而回落仅基座；缺省 = 非关停回落。 */
    packDisabled?: true;
    /** 被关停的 packId（随 packDisabled 一同记录）：关停轮事件顶层 packId 已回落缺省，追溯「哪个 pack 被关停」只此一处。 */
    disabledPackId?: string;
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
    /** 本轮判定所依据的 L2 定格 revision：与 assembly / user-config-write 事件同值互证（R4）；缺省=无 L2 参与或 degraded。 */
    userConfigRevision?: string;
    /** L2 读失败且无缓存的降级轮标注：与 assembly 事件同值互证；缺省=无降级。 */
    userConfigDegraded?: 'fail-open-closed';
    /** L2 收紧后的本轮生效分级（riskTier 为静态定义值）；缺省=无 L2 收紧、生效值即静态值。 */
    effectiveTier?: RiskTier;
    /**
     * 本轮由只读自动化模板发起、工具面被平台强制收窄为只读（adr-021，R7 无人值守底线）的判定归因：
     * 越界工具请求以 verdict=deny 落此标注，是「无人值守不执行写操作」的机械可检证据；缺省=非只读强制轮。
     */
    unattendedReadOnly?: true;
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

/** L2 用户配置写入事件（adr-014 §5）：记录写后完整 overlay 快照（落 sink 前已按 SEC-01 脱敏）。 */
export interface UserConfigWriteEvent extends AuditEventBase {
  type: 'user-config-write';
  data: {
    subject: UserConfigSubject;
    /** 写后 overlay 内容 hash；assembly/tool 决策事件的 userConfigRevision 与此互证（R4）。 */
    revision: string;
    /** 写后全量 overlay（脱敏后）。 */
    overlay: UserOverlay;
    /** teach = 对话草稿经 config-decision 确认写入；panel = 配置中心面板结构化编辑。 */
    origin: 'teach' | 'panel';
  };
}

export type AuditEvent =
  | SessionStartEvent
  | SessionEndEvent
  | AssemblyEvent
  | ToolDecisionEvent
  | HitlVerdictEvent
  | ToolExecutionEvent
  | UserConfigWriteEvent;
