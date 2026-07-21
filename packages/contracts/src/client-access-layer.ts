/**
 * C3 客户端接入层类型——权威在 schemas/client-access-layer.schema.json，本文件为其手写同构投影。
 * codegen 引入锚点 = 契约首次进入高频变更期；在此之前改 schema 须同步手改本文件。
 * 五能力与帧闭集不随客户端形态变（U5）；所有帧 JSON 可序列化（U1）。
 */
import type { JsonObject, JsonValue } from './json.js';
import type { HttpMethod, SnapshotEvidenceRule } from './tool-definition.js';

/** 五能力闭集（U5）：任何客户端形态实现同一组能力。 */
export type ClientCapability =
  | 'identity'
  | 'context-report'
  | 'conversation-hitl'
  | 'page-action'
  | 'delegated-execution';

export type HitlDecisionValue = 'approve' | 'reject';

export type ExecutionPreference =
  | 'auto'
  | 'dom-only'
  | 'prefer-client-api'
  | 'prefer-server-api';

export type ToolCardStatus = 'running' | 'succeeded' | 'failed';

/** 页面动作闭集（纯引导，无副作用）：填表/替点走 delegated-execution 的 dom 通道（adr-011），不入本闭集。 */
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
  /** 关联 exec-instruction，服务端一次性核销（U7）。 */
  nonce: string;
  ok: boolean;
  status?: number;
  body?: JsonValue;
  error?: string;
}

/** 页面可交互元素条目：ref 由客户端分配（za-N），仅当次快照内有效。 */
export interface SnapshotElement {
  ref: string;
  /** 元素角色：标签名，input 附类型（如 input:text）。 */
  role: string;
  /** 可读标签：aria-label / 文本 / placeholder，客户端截断。 */
  label: string;
  value?: string;
  disabled?: boolean;
}

/** 页面快照上报（dom 代操作的观察半程）：对应下行 snapshot-request 的 requestId。 */
export interface SnapshotReportFrame {
  type: 'snapshot-report';
  sessionId: string;
  requestId: string;
  url: string;
  /** content script 本次页面生命周期的随机标识；导航/刷新/切换标签页后变化。 */
  pageInstanceId?: string;
  title?: string;
  elements: SnapshotElement[];
  /** 页面当前可见的告警/校验/状态提示文本（客户端去重截断）：供 agent 识别表单校验等拦截性提示。 */
  notices?: string[];
  evidence?: Record<string, SnapshotEvidence>;
}

export interface SnapshotEvidence {
  count: number;
  latest: string;
}

export type UpstreamFrame =
  | ContextReportFrame
  | UserMessageFrame
  | HitlDecisionFrame
  | ExecResultFrame
  | SnapshotReportFrame;

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
  /** UI 分组用调用模式（纯展示，不承载判定）：client 用户会话代执行 / server 服务端直调。 */
  mode?: 'client' | 'server';
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

/**
 * dom 步骤动作闭集（adr-011）：navigate/waitFor 契约保留、②-a 未实现——
 * toolgate fail-closed 拒绝（锚点=②-b 跨导航续跑），对齐 U3"枚举保留、未实现拒绝"惯例。
 */
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
  /** 目标元素引用：必须取自最近一次 snapshot-report 的 ref（服务端签发前校验）。navigate 步免除。 */
  ref?: string;
  /** navigate 目标绝对 URL（ADR-013 批次④启用）：须落在某已安装 pack 的 site 围栏内，服务端签发前校验。 */
  url?: string;
  /** navigate 目标（同源路径，②-b 保留字段）。 */
  to?: string;
  /** fill/select 的输入值。 */
  value?: string;
  /** read 结果键名：exec-result.body.reads 按此键回传采集值。 */
  name?: string;
}

/** dom 代执行请求：服务端已校验的步骤批次，客户端闭集解释执行、不 eval 任意代码。 */
export interface DomExecRequest {
  kind: 'dom';
  steps: DomStep[];
  /** 有界副作用指令的机械执行围栏；客户端只做等值比较，不承担治理判定。 */
  expectedPageUrl?: string;
  expectedPageInstanceId?: string;
}

export interface ExecInstructionFrame {
  type: 'exec-instruction';
  sessionId: string;
  nonce: string;
  /** 服务端签发绝对时间与失效绝对时间；客户端在任何副作用前验签并验 expiresAt。 */
  issuedAt: number;
  expiresAt: number;
  /** 自签发起的存活毫秒数，过期作废（U7）。 */
  ttl: number;
  /** Ed25519 对 {sessionId,nonce,issuedAt,expiresAt,ttl,toolCallId,request} 规范化序列的签名。 */
  signature: string;
  toolCallId: string;
  request: ExecRequest | DomExecRequest;
}

export interface GuideActionFrame {
  type: 'guide-action';
  sessionId: string;
  action: GuideActionKind;
  /** 未命中时客户端静默降级为文字说明，不中断会话。 */
  selector: string;
  message?: string;
}

/** 页面快照请求：路由到组内活跃页，客户端以 snapshot-report 回传（requestId 关联）。 */
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

export type ClientAccessFrame = UpstreamFrame | DownstreamFrame;
