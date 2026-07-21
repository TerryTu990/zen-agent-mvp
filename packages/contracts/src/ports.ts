/**
 * C6 模块端口——模块间唯一的调用契约（U2：禁直接 import 实现，只经本类型 + 端口注入，组装唯一在 apps/server）。
 *
 * 不变量（U1）：四端口方法的出入参全部 JSON 可序列化——拆服务时端口 → RPC 不改契约。
 * LlmPort 的 AsyncIterable 是流式 RPC（SSE 等）的进程内投影，逐个产出的事件本体仍 JSON 可序列化。
 */
import type { JsonObject, JsonValue } from './json.js';
import type { ToolDefinition } from './tool-definition.js';
import type { IdentityClaims } from './identity-claims.js';
import type {
  ExecInstructionFrame,
  ExecResultFrame,
  SnapshotElement,
  SnapshotEvidence,
} from './client-access-layer.js';
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
  /** true = 激活的是 generic 兜底 pack（无站点 pack 命中）：网关 MUST 按服务端准入名单以活跃页 origin 二次判定（不过即按 packId=null 仅基座，fail-closed）；缺省 = 站点/legacy pack 或无 pack。 */
  generic?: boolean;
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
  /**
   * 已安装站点索引（渐进披露第一层，跨功能稳定）：列出平台可辅助的全部带 site 的 pack（用途+可达 URL），
   * 当前激活 pack 标注（当前）。仅 ≥2 个带 site 的 pack 时非 null（单 site/legacy 无跨站意义 → null）。
   */
  sitesIndex: string | null;
}

export interface InjectionBlock {
  kind: 'system-prompt' | 'sites-index' | 'feature-rules' | 'facts' | 'skill' | 'docs-index';
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

/** 已安装带 site 围栏的 pack 描述（ADR-013 任务组）：per-origin 身份路由与 navigate 越界校验的依据；legacy 无 site 的 pack 不列入。 */
export interface SiteDescriptor {
  packId: string;
  /** 精确匹配的页面 origin（scheme://host[:port]）。 */
  origin: string;
  /** claims.tenant → origin 路由键；缺省=该 pack 不参与 per-origin 身份路由（宿主身份回退平台 claims）。 */
  tenant?: string;
  /** 已归一路径前缀围栏（'/' 表整站）。 */
  locations: string[];
}

/** 工具→归属 pack 登记（未去重，逐 pack 列出）：toolgate 载入期据此建立命名空间纪律、检测跨 pack 同名 toolId。 */
export interface ToolOwnership {
  packId: string;
  toolId: string;
}

export interface AssemblyPort {
  resolveFeature(input: ResolveFeatureInput): Promise<ResolveFeatureResult>;
  compose(input: ComposeInput): Promise<ComposeResult>;
  describeInjection(input: ComposeInput): Promise<InjectionDescription>;
  /** 读当前激活 pack 的 docs/ 单篇正文；只可读该 pack、路径穿越 fail-closed、单次截断上限。 */
  readPackDoc(input: ReadPackDocInput): Promise<ReadPackDocResult>;
  /** 全 pack 工具并集（toolgate fail-closed 判定的工具闭集来源，U7）；跨 pack 按 toolId 去重。 */
  allTools(): Promise<ToolDefinition[]>;
  /** 已安装带 site 围栏的 pack 列表（ADR-013）：per-origin 身份路由 + navigate 围栏校验用。 */
  listSites(): Promise<SiteDescriptor[]>;
  /** 逐 pack 列出工具归属（未去重）：toolgate 载入期命名空间纪律检测用。 */
  listToolOwnership(): Promise<ToolOwnership[]>;
}

// ---- ToolGatePort（③工具执行层：唯一决策点 + 代执行指令签发/回收）----

/** dom 代操作的判定上下文（adr-011）：网关自最近一次 snapshot-report 提取，toolgate 据此校验 ref 与围栏。 */
export interface DomGateContext {
  /** 最近快照的元素 ref 闭集：步骤引用越出即 deny。 */
  refs: string[];
  /** 快照页 URL 路径：不在 DomAdapter.pathPrefixes 围栏内即 deny。 */
  path: string;
  /** 快照页 origin（ADR-013）：site pack 的非 navigate dom 步须 === 工具所属 pack origin，越界即 deny。 */
  origin?: string;
  /** 当前快照完整 URL：有界履约意图必须与其精确绑定，防在另一订单聊天页复用。 */
  url?: string;
  /** 快照所属 content script 页面生命周期，防快照后切页/刷新再执行。 */
  pageInstanceId?: string;
  /** 最近快照元素的最小语义，用于有界履约固定校验输入框与发送按钮。 */
  elements?: SnapshotElement[];
  /** 最近快照按 pack 配方生成的结构化证据；服务端可信准备器只消费闭集统计，不读取消息正文。 */
  evidence?: Record<string, SnapshotEvidence>;
}

export interface PrepareFulfillmentIntentInput {
  /** 库存写入前由 toolgate 原子预留策略/订单/日额度所得的一次性票据；缺失不得登记 intent。 */
  authorizationId: string;
  accountId: string;
  toolId: string;
  productId: string;
  orderId: string;
  quantity: number;
  pageUrl: string;
  /** 可信连接器绑定的页面生命周期；必须与执行前最近快照一致。 */
  pageInstanceId: string;
  /** 可信连接器只提交语义字段；toolgate 固定构造恰好一组 fill→click。 */
  messageRef: string;
  sendRef: string;
  message: string;
  receiptEvidenceId: string;
  receiptBaselineCount: number;
  receiptSuccessStatuses: string[];
  expiresAt: number;
}

export interface PreauthorizeFulfillmentInput {
  accountId: string;
  toolId: string;
  productId: string;
  orderId: string;
  quantity: number;
  pageUrl: string;
  expiresAt: number;
}

export interface PreauthorizeFulfillmentResult {
  authorizationId: string;
}

export interface PrepareFulfillmentIntentResult {
  intentId: string;
}

export interface ConfirmFulfillmentReceiptInput {
  sessionId: string;
  toolCallId: string;
  pageUrl: string;
  pageInstanceId: string;
  evidence: Record<string, SnapshotEvidence>;
}

export interface ConfirmFulfillmentReceiptResult {
  confirmed: boolean;
  state: 'completed' | 'uncertain';
}

/**
 * ADR-013 任务组：工具所属激活 pack 的 site 上下文（网关按激活 pack 计算传入）。
 * packOrigin 缺省=legacy 无 site pack（沿用平台 claims 身份、不校 origin 围栏）。
 */
interface PackScopeInput {
  /** 工具所属激活 pack 的 origin 围栏：站点 pack = site.origin；generic pack = 网关以活跃页 origin 填充；有值即启用 origin 围栏 + per-origin 身份口径。 */
  packOrigin?: string;
  /**
   * packOrigin 对应的宿主身份：tenant'd pack 取 per-origin 路由 claims（缺失/过期即 fail-closed），
   * no-tenant site pack 由网关回退为平台 claims。http/server 工具据此渲染与校验；dom 工具不用。
   */
  claimsForOrigin?: IdentityClaims;
}

export interface GateDecisionInput extends PackScopeInput {
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

export interface IssueExecInstructionInput extends PackScopeInput {
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

/** 任务级 HITL 授权登记：hitl 获批后记 grant，同会话同任务的后续调用（跨工具）decide 直接放行（一任务一授权）。 */
export interface HitlGrantInput {
  sessionId: string;
  /** agent 声明的任务标题（params.task）：授权作用域即用户在确认卡上看到并批准的这个任务。 */
  task: string;
}

export interface ToolGatePort {
  /** 插件经已鉴权 SSE 响应取得的 Ed25519 SPKI 公钥；仅用于指令验签。 */
  getExecVerificationKey(): Promise<{ algorithm: 'Ed25519'; publicKey: string }>;
  /** 库存写前原子校验并占住策略、订单和日额度；失败不得触达库存。 */
  preauthorizeFulfillment(input: PreauthorizeFulfillmentInput): Promise<PreauthorizeFulfillmentResult>;
  /** 库存/intent 准备失败时释放尚未转执行态的预授权。 */
  releaseFulfillmentAuthorization(authorizationId: string): Promise<void>;
  /** 仅供 apps/server 内可信连接器调用；不暴露为模型工具或客户端 API。 */
  prepareFulfillmentIntent(input: PrepareFulfillmentIntentInput): Promise<PrepareFulfillmentIntentResult>;
  /** DOM 执行成功后，以发送后新快照回执确认最终交付；未精确增加 1 一律 uncertain。 */
  confirmFulfillmentReceipt(input: ConfirmFulfillmentReceiptInput): Promise<ConfirmFulfillmentReceiptResult>;
  decide(input: GateDecisionInput): Promise<GateDecision>;
  /**
   * 登记任务级授权：同 (sessionId,task) 的后续 decide 放行（跨工具共享，every-call 工具除外），
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

// ---- CardInventoryPort（飞书只承担轻量库存账本；卡密不得进入模型/审计/日志）----

export type CardInventoryStatus = 'available' | 'reserved' | 'sent' | 'manual';

export type CardInventoryError =
  | 'inventory-unavailable'
  | 'inventory-empty'
  | 'inventory-ambiguous'
  | 'inventory-paused'
  | 'inventory-write-failed'
  | 'inventory-invalid-record';

export interface ReserveCardInput {
  productKey: string;
  orderId: string;
}

export type ReserveCardResult =
  | {
      ok: true;
      cardId: string;
      /** 仅在服务端履约编排内短暂流转；MUST NOT 进入模型、审计或日志。 */
      cardSecret: string;
      status: 'reserved';
      reused: boolean;
    }
  | {
      ok: true;
      cardId: string;
      status: 'sent' | 'manual';
      reused: true;
    }
  | { ok: false; error: CardInventoryError };

export interface BeginCardDeliveryInput {
  cardId: string;
  orderId: string;
}

export interface SettleCardInput {
  cardId: string;
  orderId: string;
  status: 'sent' | 'manual';
  note?: string;
}

export type SettleCardResult =
  | { ok: true }
  | { ok: false; error: CardInventoryError };

export interface CardInventoryPort {
  /** 同订单优先复用；否则领取一条 available 并先写 reserved。单执行器串行前提见实施计划。 */
  reserve(input: ReserveCardInput): Promise<ReserveCardResult>;
  /** 在浏览器副作用前持久化 attempt 闩锁；重启后看到该闩锁只能转人工，不得重发。 */
  beginDelivery(input: BeginCardDeliveryInput): Promise<SettleCardResult>;
  /** 页面回执明确后写 sent；任何不明确结果写 manual。 */
  settle(input: SettleCardInput): Promise<SettleCardResult>;
}

export interface PrepareCardFulfillmentInput {
  accountId: string;
  toolId: string;
  productId: string;
  productKey: string;
  orderId: string;
  quantity: number;
  pageUrl: string;
  pageInstanceId: string;
  messageRef: string;
  sendRef: string;
  receiptEvidenceId: string;
  receiptBaselineCount: number;
  receiptSuccessStatuses: string[];
  expiresAt: number;
}

export type PrepareCardFulfillmentResult =
  | { ok: true; intentId: string }
  | {
      ok: false;
      error:
        | CardInventoryError
        | 'already-sent'
        | 'manual-review'
        | 'fulfillment-paused'
        | 'unsupported-quantity'
        | 'authorization-denied'
        | 'intent-registration-failed';
    };

export interface SettleCardFulfillmentInput {
  intentId: string;
  outcome: 'sent' | 'manual';
  note?: string;
}

export type SettleCardFulfillmentResult =
  | { ok: true }
  | { ok: false; error: CardInventoryError | 'unknown-intent' | 'outcome-conflict' };

export interface FulfillmentCoordinatorPort {
  /** 先由 toolgate 原子占住授权/额度，再领取卡密并登记不向模型暴露正文的一次性 intent。 */
  prepare(input: PrepareCardFulfillmentInput): Promise<PrepareCardFulfillmentResult>;
  /** toolgate 放行后、浏览器指令签发前写入不可重放的发送尝试闩锁。 */
  beginDelivery(intentId: string): Promise<SettleCardFulfillmentResult>;
  /** 闲鱼回执闭环后回填库存终态；失败必须阻断后续自动处理。 */
  settle(input: SettleCardFulfillmentInput): Promise<SettleCardFulfillmentResult>;
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
  | {
      kind: 'done';
      stopReason: 'end' | 'tool-call' | 'error';
      error?: string;
      /** 错误类别（stopReason=error 时可选）：invalid-tool-args=模型产出的实参 JSON 非法/截断，可回喂重试自愈。 */
      errorKind?: 'invalid-tool-args';
      /** 上游返回 token 用量时透传（缺省=上游未报，消费侧回退字符近似估算）。 */
      usage?: { inputTokens: number; outputTokens: number };
    };

export interface LlmPort {
  chat(request: LlmChatRequest): AsyncIterable<LlmStreamEvent>;
}

// ---- AuditPort（⑦观测审计：record-only 旁路）----

export interface AuditPort {
  /** 旁路铁律：实现不抛异常、失败仅本地日志，故障不进控制流；事件已由调用方脱敏。 */
  record(event: AuditEvent): void;
}
