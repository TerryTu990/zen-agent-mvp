/**
 * C6 模块端口——模块间唯一的调用契约（U2：禁直接 import 实现，只经本类型 + 端口注入，组装唯一在 apps/server）。
 *
 * 不变量（U1）：四端口方法的出入参全部 JSON 可序列化——拆服务时端口 → RPC 不改契约。
 * LlmPort 的 AsyncIterable 是流式 RPC（SSE 等）的进程内投影，逐个产出的事件本体仍 JSON 可序列化。
 */
import type { JsonObject, JsonValue } from './json.js';
import type { ToolDefinition } from './tool-definition.js';
import type { IdentityClaims } from './identity-claims.js';
import type { ExecInstructionFrame, ExecResultFrame } from './client-access-layer.js';
import type { AuditEvent, GateVerdict } from './audit-event.js';

// ---- AssemblyPort（②会话网关 ← ⑤配置中心：featureId 定位 + 注入组合）----

export interface ResolveFeatureInput {
  url: string;
}

export interface ResolveFeatureResult {
  /** null = manifest.featureIdRules 无命中，仅装配稳定基座（fail-safe）。 */
  featureId: string | null;
  snapshotVersion: string;
}

export interface ComposeInput {
  sessionId: string;
  featureId: string | null;
}

export interface SkillAsset {
  id: string;
  content: string;
}

/** 每轮换出的装配产物：稳定基座 + 功能块 + skills + 工具白名单（装配对 agent 透明）。 */
export interface ComposeResult {
  snapshotVersion: string;
  systemPrompt: string;
  /** assets/features/<id>/feature.md；无功能命中时为 null。 */
  featureRules: string | null;
  /** assets/features/<id>/facts.md；无功能命中时为 null。 */
  facts: string | null;
  skills: SkillAsset[];
  tools: ToolDefinition[];
}

export interface InjectionBlock {
  kind: 'system-prompt' | 'feature-rules' | 'facts' | 'skill';
  id?: string;
  bytes: number;
}

/** 注入自省：与 compose 同源产出，供审计 assembly 事件与调试查看。 */
export interface InjectionDescription {
  snapshotVersion: string;
  featureId: string | null;
  blocks: InjectionBlock[];
  toolIds: string[];
}

export interface AssemblyPort {
  resolveFeature(input: ResolveFeatureInput): Promise<ResolveFeatureResult>;
  compose(input: ComposeInput): Promise<ComposeResult>;
  describeInjection(input: ComposeInput): Promise<InjectionDescription>;
}

// ---- ToolGatePort（③工具执行层：唯一决策点 + 代执行指令签发/回收）----

export interface GateDecisionInput {
  sessionId: string;
  toolCallId: string;
  toolId: string;
  params: JsonObject;
  claims: IdentityClaims;
}

/** 判定结果：分级矩阵 + 身份/实参校验，任一不过即 deny（fail-closed，U7）。 */
export interface GateDecision {
  verdict: GateVerdict;
  reason?: string;
}

export interface IssueExecInstructionInput {
  sessionId: string;
  toolCallId: string;
  toolId: string;
  params: JsonObject;
  /** 已验签身份：adapter 模板可经 {{hostUserId}} 等占位注入身份到请求头/URL/体（身份优先于 params，防工具冒充）。 */
  claims: IdentityClaims;
}

export interface AcceptExecResultInput {
  sessionId: string;
  result: ExecResultFrame;
}

/** 规整后的 observation：仅校验通过的结果才回喂 agent（U7）。 */
export interface Observation {
  toolCallId: string;
  ok: boolean;
  content: JsonValue;
  error?: string;
}

export interface ToolGatePort {
  decide(input: GateDecisionInput): Promise<GateDecision>;
  /** 前提：decide 已放行（allow 或 hitl 获批）。签发即登记一次性 nonce。 */
  issueExecInstruction(input: IssueExecInstructionInput): Promise<ExecInstructionFrame>;
  /** 核销 nonce、验 ttl、按 resultSchema 校验后规整；任一不过返回 ok=false 的 observation。 */
  acceptExecResult(input: AcceptExecResultInput): Promise<Observation>;
  /**
   * server 通道服务端直调：前提 decide 已放行。按 ServerAdapter 渲染请求、解析 credentialRef 注入凭证
   * （真值只存于本次请求构造，MUST NOT 落日志/审计/Context），响应体过 resultSchema 校验后规整为 observation。
   * 不经 nonce/客户端回传（那是 client 通道）；凭证解析不到时按未配置处理返回 ok=false。
   */
  executeServer(input: IssueExecInstructionInput): Promise<Observation>;
}

// ---- LlmPort（④LLM 接入层：provider 白名单插拔，密钥托管在实现侧）----

/** assistant 回合发起的工具调用回声；供回喂轮把 role:tool 观察关联到其发起调用（OpenAI 兼容 API 要求）。 */
export interface LlmToolCall {
  id: string;
  name: string;
  params: JsonObject;
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** role=tool 时关联的调用。 */
  toolCallId?: string;
  /** role=assistant 且本轮发起了工具调用时的回声；缺省=纯文本轮。 */
  toolCalls?: LlmToolCall[];
}

export interface LlmToolSpec {
  name: string;
  description: string;
  /** 内联 JSON Schema，来自 ToolDefinition.params。 */
  params: JsonObject;
}

export interface LlmChatRequest {
  /** 省略 = 实现侧默认 provider/model（白名单内）。 */
  model?: string;
  messages: LlmMessage[];
  tools?: LlmToolSpec[];
}

export type LlmStreamEvent =
  | { kind: 'text-delta'; delta: string }
  | { kind: 'tool-call'; toolCallId: string; name: string; params: JsonObject }
  | { kind: 'done'; stopReason: 'end' | 'tool-call' | 'error'; error?: string };

export interface LlmPort {
  chat(request: LlmChatRequest): AsyncIterable<LlmStreamEvent>;
}

// ---- AuditPort（⑦观测审计：record-only 旁路）----

export interface AuditPort {
  /** 旁路铁律：实现不抛异常、失败仅本地日志，故障不进控制流；事件已由调用方脱敏。 */
  record(event: AuditEvent): void;
}
