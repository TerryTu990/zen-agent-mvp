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
  /** 发起本自动回合的自动化 id；服务端据此定位只读模板并强制该轮工具面（缺失则整条只读强制不可达）。 */
  automationId?: string;
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
  /** 页面正文纯文本，仅 includeText 请求时采集；未请求或页面无正文一律缺席（空串非法）。 */
  text?: string;
  /** true=text 仅为正文前缀（客户端已截断）；缺省/false=完整。text 缺席时本字段不得出现。 */
  textTruncated?: boolean;
  evidence?: Record<string, SnapshotEvidence>;
}

export type GroupPageStatus = 'active' | 'background' | 'silent';

/** 任务组成员页条目：handle 为会话作用域不透明句柄——服务端只作等值比对，禁解析内部结构（U5）。 */
export interface GroupPageEntry {
  handle: string;
  url: string;
  /** 客户端截断后的页面标题（≤120 字符，schema 硬约束）；缺省 = 无标题。 */
  title?: string;
  /** active=当前活跃成员；background=content 会话端口在场的非活跃成员；silent=入组但无 content script 交互保证。 */
  status: GroupPageStatus;
}

/**
 * 任务组页面清单上报（adr-023 D1）：组内成员页全量列表，服务端以每帧整体重建组页面状态表
 * （无增量语义）。清单是数据不是指令（U8）：只驱动状态表与清单注入，不改变任何治理判定。
 */
export interface GroupPagesFrame {
  type: 'group-pages';
  sessionId: string;
  pages: GroupPageEntry[];
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
  | GroupPagesFrame
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

/**
 * HITL 卡目标页展示（adr-023 D3）：服务端自组页面状态表组装并消毒（U8），插件只渲染不判定。
 * 仅定向到非活跃页时下发；缺省 = 副作用落在当前活跃页，不加目标页措辞。
 */
export interface HitlPageDisplay {
  title?: string;
  origin?: string;
}

export interface HitlRequestFrame {
  type: 'hitl-request';
  sessionId: string;
  hitlId: string;
  toolCallId?: string;
  toolId: string;
  params: JsonObject;
  reason?: string;
  targetPage?: HitlPageDisplay;
  /** navigate 类调用（open_url/site_navigate/单步 navigate 批次）的目标 URL：卡正文 MUST 呈现，服务端已消毒。 */
  targetUrl?: string;
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
  /** Ed25519 对 {sessionId,nonce,issuedAt,expiresAt,ttl,toolCallId,targetPage?,request} 规范化序列的签名（targetPage 取本帧 page 值）：定向落点同受签名保护，篡改即验签失败。 */
  signature: string;
  toolCallId: string;
  /**
   * 定向副作用目标成员页句柄（adr-023 D3）：会话作用域不透明字符串，客户端只作等值比对单播成员（U5）。
   * 缺省=现活跃页路由语义（含 fail-safe 回退链）逐字节不变；有值时句柄成员不可达则不投递，禁改投其他成员。
   */
  page?: string;
  request: ExecRequest | DomExecRequest;
}

export interface GuideActionFrame {
  type: 'guide-action';
  sessionId: string;
  action: GuideActionKind;
  /** 与 ref 二选一：CSS 选择器（pack 登记锚点）。 */
  selector?: string;
  /** 与 selector 二选一：最近一次快照的元素 ref（generic 兜底站点无登记锚点时用）。 */
  ref?: string;
  message?: string;
  /**
   * 定向引导目标成员页句柄（adr-023 D3）：语义同 exec-instruction.page；纯引导无副作用，无签名面。缺省=活跃页路由。
   * 预留未接线——服务端不填充本字段，引导恒落活跃页；接线锚点＝出现「引导用户查看组内非活跃页元素」的真实场景时。
   */
  page?: string;
}

export interface SnapshotRequestFrame {
  type: 'snapshot-request';
  sessionId: string;
  requestId: string;
  /** 定向观察目标（adr-023 D2）：任务组页面清单句柄，不透明、只作等值反查单播；缺省 = 组内活跃页。 */
  page?: string;
  /** 缺省 false：正文体量大，只在需要阅读页面内容的那一轮开启；开启不改变任何治理判定。 */
  includeText?: boolean;
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
