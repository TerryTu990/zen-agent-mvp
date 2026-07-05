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
  /** 激活 pack（ADR-013）：origin 精确 + 最长 location 前缀命中的唯一 pack；null = 无 pack 命中（仅基座）。legacy 快照恒为 "default"。 */
  packId: string | null;
  /** 激活 pack 的 semver；packId=null 时为 null。 */
  packVersion: string | null;
  /** null = 激活 pack 的 featureIdRules 无命中（或无 pack），仅装配稳定基座（fail-safe）。 */
  featureId: string | null;
  /** registry/legacy 根版本（区别于 pack 独立版本 packVersion）。 */
  snapshotVersion: string;
}

export interface ComposeInput {
  sessionId: string;
  /** 激活 pack；null = 仅基座（skills/docs/工具面均为空）。取自 resolveFeature 判定，装配对 agent 透明。 */
  packId: string | null;
  featureId: string | null;
}

export interface SkillAsset {
  id: string;
  content: string;
}

/**
 * 每轮换出的装配产物：稳定基座 + 功能块 + pack 作用域 skills + 工具白名单 + docs 索引（装配对 agent 透明）。
 * skills/docsIndex 收敛到激活 pack；packId=null 时均为空/null。
 */
export interface ComposeResult {
  snapshotVersion: string;
  /** 激活 pack（ADR-013）；null = 仅基座。 */
  packId: string | null;
  packVersion: string | null;
  systemPrompt: string;
  /** features/<id>/feature.md；无功能命中时为 null。 */
  featureRules: string | null;
  /** features/<id>/facts.md；无功能命中时为 null。 */
  facts: string | null;
  /** 激活 pack 的 skills（pack 作用域，非全局）。 */
  skills: SkillAsset[];
  tools: ToolDefinition[];
  /** 激活 pack 的 docs/ 渐进披露索引（frontmatter 标题+摘要）；docs/ 为空或无 pack 时为 null。 */
  docsIndex: string | null;
}

export interface InjectionBlock {
  kind: 'system-prompt' | 'feature-rules' | 'facts' | 'skill' | 'docs-index';
  id?: string;
  bytes: number;
}

/** 注入自省：与 compose 同源产出，供审计 assembly 事件与调试查看。 */
export interface InjectionDescription {
  snapshotVersion: string;
  /** 激活 pack；null = 仅基座。 */
  packId: string | null;
  featureId: string | null;
  blocks: InjectionBlock[];
  toolIds: string[];
}

/** pack docs 正文按需读取（渐进披露的 pack_doc 内建工具后端）：只读当前激活 pack 的 docs/。 */
export interface ReadPackDocInput {
  /** 当前激活 pack（网关注入，agent 不可跨 pack 指定——只读当前激活 pack 的 docs/）。 */
  packId: string | null;
  /** docs/ 内相对路径（如 "guide.md"）；路径穿越出 docs/ → fail-closed 拒读。 */
  docPath: string;
}

export interface ReadPackDocResult {
  ok: boolean;
  /** ok=true 时的正文（单次截断上限内）。 */
  content?: string;
  /** true = 正文超单次上限被截断。 */
  truncated?: boolean;
  /** ok=false 时的失败原因（不含敏感路径细节）。 */
  error?: string;
}

export interface AssemblyPort {
  resolveFeature(input: ResolveFeatureInput): Promise<ResolveFeatureResult>;
  compose(input: ComposeInput): Promise<ComposeResult>;
  describeInjection(input: ComposeInput): Promise<InjectionDescription>;
  /** 读当前激活 pack 的 docs/ 单篇正文；只可读该 pack、路径穿越 fail-closed、单次截断上限。 */
  readPackDoc(input: ReadPackDocInput): Promise<ReadPackDocResult>;
  /** 全 pack 工具并集（toolgate fail-closed 判定的工具闭集来源，U7）；跨 pack 按 toolId 去重。 */
  allTools(): Promise<ToolDefinition[]>;
}

// ---- ToolGatePort（③工具执行层：唯一决策点 + 代执行指令签发/回收）----

/** dom 代操作的判定上下文（adr-011）：网关自最近一次 snapshot-report 提取，toolgate 据此校验 ref 与围栏。 */
export interface DomGateContext {
  /** 最近快照的元素 ref 闭集：步骤引用越出即 deny。 */
  refs: string[];
  /** 快照页 URL 路径：不在 DomAdapter.pathPrefixes 围栏内即 deny。 */
  path: string;
}

export interface GateDecisionInput {
  sessionId: string;
  toolCallId: string;
  toolId: string;
  params: JsonObject;
  claims: IdentityClaims;
  /** dom 工具必需（缺失即 deny：未观察不操作）；http/server 工具忽略。 */
  domContext?: DomGateContext;
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
  /** dom 工具必需：签发是治理终点，签名前独立重校验（不依赖 decide 已通过的假设，U7）。 */
  domContext?: DomGateContext;
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

/** 任务级 HITL 授权登记：dom 工具 hitl 获批后记 grant，同任务后续批次 decide 直接放行（adr-011 一任务一确认）。 */
export interface HitlGrantInput {
  sessionId: string;
  toolId: string;
  /** agent 声明的任务标题（params.task）：授权作用域即用户在确认卡上看到并批准的这个任务。 */
  task: string;
}

export interface ToolGatePort {
  decide(input: GateDecisionInput): Promise<GateDecision>;
  /**
   * 登记任务级授权（仅 dom 工具语义）：同 (sessionId,toolId,task) 的后续 decide 放行，
   * 滑动 TTL 过期 / exec-result=user-stopped 吊销后回到 hitl。
   */
  grantHitl(input: HitlGrantInput): Promise<void>;
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
