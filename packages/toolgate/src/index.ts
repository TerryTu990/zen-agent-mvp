import { createHmac, randomUUID } from 'node:crypto';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import {
  isDomTool,
  SITE_NAVIGATE_PARAMS_SCHEMA,
  SITE_NAVIGATE_RESULT_SCHEMA,
  SITE_NAVIGATE_TOOL_ID,
} from '@zen-agent/contracts';
import type {
  DomExecRequest,
  DomGateContext,
  DomStep,
  DomToolDefinition,
  ExecInstructionFrame,
  ExecRequest,
  GateDecision,
  GateDecisionInput,
  HitlGrantInput,
  IdentityClaims,
  IssueExecInstructionInput,
  JsonObject,
  JsonValue,
  Observation,
  SiteDescriptor,
  ToolDefinition,
  ToolGatePort,
  ToolOwnership,
  AcceptExecResultInput,
} from '@zen-agent/contracts';

export interface ToolGateOptions {
  /** 分级判定的工具定义闭集：id 不在集内或 riskTier 未知一律 deny（fail-closed，U7）。 */
  tools: ToolDefinition[];
  /** 已安装带 site 围栏的 pack（ADR-013）：navigate 目标 URL 围栏校验用；缺省=无 site（navigate 恒越界拒）。 */
  sites?: SiteDescriptor[];
  /** 逐 pack 工具归属（未去重）：载入期命名空间纪律检测——跨 pack 同名 toolId 即 fail-closed 拒启（MVP 命名空间纪律）。 */
  toolOwnership?: ToolOwnership[];
  /** 代执行指令签名密钥；server 经 env 注入，MUST NOT 落日志/审计（ZA-C-SEC-01/02）。 */
  signingSecret: string;
  /** 一次性指令存活毫秒数，默认 60000。 */
  ttlMs?: number;
  /** 任务级 HITL 授权的滑动闲置过期毫秒数，默认 900000（15 分钟）。 */
  hitlGrantTtlMs?: number;
  /** 时钟注入点（默认 Date.now），仅测试用于驱动 ttl；内部参数，非端口。 */
  now?: () => number;
  /**
   * server 通道凭证解析：ref→真值；真值 MUST NOT 落日志/审计/Context（SEC-01/02），
   * 由组装层运行时注入、不写进 toolgate。缺省或解析不到按未配置处理（executeServer 返回 credential-unresolved）。
   */
  resolveCredential?: (ref: string) => string | undefined;
  /** fetch 注入点，仅测试用于替身；默认全局 fetch。 */
  fetchImpl?: typeof fetch;
  /** ADR-016：由服务端启动配置注入的、已由运营者预先批准的有界履约策略；客户端不可写。 */
  fulfillmentPolicies?: BoundedFulfillmentPolicy[];
}

/** JSON 可序列化的有界履约策略；accountId 对应已验签 claims.hostUserId，不采信 LLM 实参。 */
export interface BoundedFulfillmentPolicy {
  id: string;
  accountId: string;
  toolId: string;
  productIds: string[];
  validUntil: number;
  maxCodesPerOrder: number;
  dailyOrderLimit: number;
}

const DEFAULT_TTL_MS = 60000;
const DEFAULT_HITL_GRANT_TTL_MS = 900000;
/** 客户端解释器对用户点「停止」的约定错误串：命中即吊销本会话的全部任务授权。 */
const USER_STOPPED_ERROR = 'user-stopped';

/** 递归按键名升序序列化，使签名不受对象键序影响（防篡改稳定基线）。 */
function stableStringify(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k] as JsonValue)}`).join(',')}}`;
}

/** HMAC-SHA256（hex）over 稳定键序 JSON；同 secret 可复算校验，值/键改变则签名变。 */
export function computeExecSignature(secret: string, payload: JsonValue): string {
  return createHmac('sha256', secret).update(stableStringify(payload)).digest('hex');
}

/** 一次性 nonce 登记项：核销依据（一次性 + ttl，U7）。 */
interface NonceRecord {
  toolId: string;
  toolCallId: string;
  issuedAt: number;
  ttl: number;
  consumed: boolean;
  fulfillmentReservationKey?: string;
}

interface FulfillmentReservation {
  policyId: string;
  accountId: string;
  toolId: string;
  orderId: string;
  day: string;
  state: 'pending' | 'completed' | 'uncertain';
  expiresAt: number;
}

/**
 * nonce 登记存储抽象——MVP 进程内 Map；接口先行以便状态外置（Redis 等）。
 * 外置锚点 = S4 会话状态外置里程碑。
 */
interface NonceStore {
  put(nonce: string, record: NonceRecord): void;
  get(nonce: string): NonceRecord | undefined;
  markConsumed(nonce: string): void;
}

class InMemoryNonceStore implements NonceStore {
  private readonly records = new Map<string, NonceRecord>();
  put(nonce: string, record: NonceRecord): void {
    this.records.set(nonce, record);
  }
  get(nonce: string): NonceRecord | undefined {
    return this.records.get(nonce);
  }
  markConsumed(nonce: string): void {
    const record = this.records.get(nonce);
    if (record) record.consumed = true;
  }
}

const KNOWN_RISK_TIERS = new Set(['auto', 'hitl', 'forbidden']);

/** 已实现的 dom 动作（navigate 于 ADR-013 批次④启用，单步专走）；waitFor 契约保留、命中即拒。 */
const IMPLEMENTED_DOM_ACTIONS = new Set(['click', 'fill', 'select', 'read', 'scroll', 'highlight']);
const RESERVED_DOM_ACTIONS = new Set(['waitFor']);
const MAX_DOM_STEPS = 20;
const READ_NAME_PATTERN = /^[\w-]{1,64}$/;

/** 路径段前缀匹配（与装配层围栏语义一致）：'/' 匹配一切；'/console' 匹配 '/console' 与 '/console/...'。 */
function locationMatches(path: string, loc: string): boolean {
  if (loc === '/') return true;
  return path === loc || path.startsWith(`${loc}/`);
}

/**
 * dom 批次 fail-closed 校验（U7）：动作闭集、ref 出自最近快照、fill/select 有值、read 有键名、
 * 快照页路径在围栏内。通过则返回只含已知字段的净化步骤（剥离 LLM 幻觉出的多余键，签名精确覆盖将执行内容）；
 * 任一不过返回 reason 字符串（不含实参值，SEC-04）。
 */
/**
 * dom 批次 fail-closed 校验（U7）：动作闭集、ref 出自最近快照、fill/select 有值、read 有键名、
 * 快照页路径在围栏内。ADR-013 批次④补两项：
 *  1. navigate 步单步专走——含其他步即 invalid-params，免 ref、须带 url 且 url 落在某已安装 pack site 围栏内；
 *  2. site pack（packOrigin 有值）的非 navigate 批次，快照 origin 须 === 工具所属 pack origin（越界 origin-fence-violation）。
 * 通过则返回只含已知字段的净化步骤；任一不过返回 reason 字符串（不含实参值，SEC-04）。
 */
function validateDomSteps(
  tool: DomToolDefinition,
  params: JsonObject,
  domContext: DomGateContext | undefined,
  packOrigin: string | undefined,
  urlInFence: (url: string) => boolean,
): { steps: DomStep[] } | { reason: string } {
  // 任务标题必填：它是任务级 HITL 授权的作用域标识（用户批准的就是它），也是审计可读锚点。
  const task = params['task'];
  if (typeof task !== 'string' || task.trim() === '') return { reason: 'missing-task' };
  if (domContext === undefined) return { reason: 'dom-context-missing' };
  if (!tool.adapter.pathPrefixes.some((prefix) => domContext.path.startsWith(prefix))) {
    return { reason: 'fence-violation' };
  }
  const raw = params['steps'];
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_DOM_STEPS) {
    return { reason: 'invalid-steps' };
  }
  const hasNavigate = raw.some(
    (it) => it !== null && typeof it === 'object' && !Array.isArray(it) && (it as Record<string, JsonValue>)['action'] === 'navigate',
  );
  // navigate 语义即开新页：与其他步混批无意义，单步强制；也因此免除"快照 origin=pack origin"围栏。
  if (hasNavigate && raw.length !== 1) return { reason: 'invalid-params' };
  if (packOrigin !== undefined && !hasNavigate && domContext.origin !== packOrigin) {
    return { reason: 'origin-fence-violation' };
  }
  const refs = new Set(domContext.refs);
  const steps: DomStep[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return { reason: 'invalid-step-shape' };
    }
    const { action, ref, value, name, url } = item as Record<string, JsonValue>;
    if (typeof action !== 'string') return { reason: 'invalid-step-shape' };
    if (action === 'navigate') {
      // navigate 免 ref；url 须落在某已安装 pack 的 site 围栏内（origin 精确 + location 前缀），越界不签发。
      if (typeof url !== 'string' || url === '') return { reason: 'missing-navigate-url' };
      if (!urlInFence(url)) return { reason: 'fence-violation' };
      steps.push({ action: 'navigate', url });
      continue;
    }
    if (RESERVED_DOM_ACTIONS.has(action)) return { reason: `action-not-implemented:${action}` };
    if (!IMPLEMENTED_DOM_ACTIONS.has(action)) return { reason: 'unknown-action' };
    if (typeof ref !== 'string' || !refs.has(ref)) return { reason: 'ref-not-in-snapshot' };
    const step: DomStep = { action: action as DomStep['action'], ref };
    if (action === 'fill' || action === 'select') {
      if (typeof value !== 'string') return { reason: 'missing-value' };
      step.value = value;
    }
    if (action === 'read') {
      if (typeof name !== 'string' || !READ_NAME_PATTERN.test(name)) {
        return { reason: 'missing-read-name' };
      }
      step.name = name;
    }
    steps.push(step);
  }
  return { steps };
}

/** 把 {{name}} 占位替换为实参；encode 用于 URL 路径段转义，headers/body 传恒等函数。 */
function renderTemplate(
  template: string,
  params: JsonObject,
  encode: (raw: string) => string,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => encode(String(params[name] ?? '')));
}

function renderHeaders(
  headers: Record<string, string>,
  params: JsonObject,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = renderTemplate(value, params, (raw) => raw);
  }
  return out;
}

/** 递归代入 body 模板；仅字符串叶子做占位替换（非字符串原样保留）。 */
function renderBody(template: JsonValue, params: JsonObject): JsonValue {
  if (typeof template === 'string') return renderTemplate(template, params, (raw) => raw);
  if (Array.isArray(template)) return template.map((item) => renderBody(item, params));
  if (template !== null && typeof template === 'object') {
    const out: JsonObject = {};
    for (const [key, value] of Object.entries(template)) out[key] = renderBody(value, params);
    return out;
  }
  return template;
}

export function createToolGatePort(options: ToolGateOptions): ToolGatePort {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const grantTtlMs = options.hitlGrantTtlMs ?? DEFAULT_HITL_GRANT_TTL_MS;
  const now = options.now ?? Date.now;
  const store = new InMemoryNonceStore();
  // 任务级 HITL 授权：key=(sessionId,task) → 最近使用时刻（滑动 TTL）。同任务跨工具共享授权
  // （用户批准的是任务，不是某个工具）；进程内即可，随会话生命周期。
  const hitlGrants = new Map<string, number>();
  const grantKey = (sessionId: string, task: string): string => `${sessionId} ${task}`;
  /** 命中且未过滑动闲置期则续期并放行；过期即清除（回到 hitl）。 */
  const consumeGrant = (sessionId: string, task: string): boolean => {
    const key = grantKey(sessionId, task);
    const lastUsed = hitlGrants.get(key);
    if (lastUsed === undefined) return false;
    if (now() - lastUsed > grantTtlMs) {
      hitlGrants.delete(key);
      return false;
    }
    hitlGrants.set(key, now());
    return true;
  };
  /** 用户停止：吊销本会话全部任务授权（停止表达的是对自动执行整体的收回，不区分任务与工具）。 */
  const revokeGrants = (sessionId: string): void => {
    const prefix = `${sessionId} `;
    for (const key of hitlGrants.keys()) {
      if (key.startsWith(prefix)) hitlGrants.delete(key);
    }
  };

  // ADR-016：自动履约额度与订单占用只存在服务端 toolgate。decide 原子预占；结果不明确时标记
  // uncertain 并永久阻止该订单自动重试，防“没看见回执”演变成重复发货。
  const fulfillmentPolicies = options.fulfillmentPolicies ?? [];
  const fulfillmentReservations = new Map<string, FulfillmentReservation>();
  const reservationByCall = new Map<string, string>();
  const callKey = (sessionId: string, toolCallId: string): string => `${sessionId}\0${toolCallId}`;
  const dayKey = (timestamp: number): string => new Date(timestamp).toISOString().slice(0, 10);
  const fulfillmentPolicyIds = new Set<string>();
  for (const policy of fulfillmentPolicies) {
    if (
      policy.id.trim() === '' ||
      fulfillmentPolicyIds.has(policy.id) ||
      policy.accountId.trim() === '' ||
      policy.toolId.trim() === '' ||
      policy.productIds.length === 0 ||
      new Set(policy.productIds).size !== policy.productIds.length ||
      !Number.isFinite(policy.validUntil) ||
      !Number.isInteger(policy.maxCodesPerOrder) ||
      policy.maxCodesPerOrder < 1 ||
      !Number.isInteger(policy.dailyOrderLimit) ||
      policy.dailyOrderLimit < 1
    ) {
      throw new Error(`有界履约策略 ${policy.id || '<empty>'} 非法，拒绝启动`);
    }
    fulfillmentPolicyIds.add(policy.id);
  }

  const expirePendingReservations = (): void => {
    for (const reservation of fulfillmentReservations.values()) {
      if (reservation.state === 'pending' && now() > reservation.expiresAt) {
        reservation.state = 'uncertain';
      }
    }
  };

  const reserveBoundedFulfillment = (
    tool: ToolDefinition,
    input: GateDecisionInput,
  ): { allowed: boolean; reason?: string } => {
    const mapping = tool.authorization;
    if (mapping?.kind !== 'bounded-fulfillment') return { allowed: false };
    expirePendingReservations();
    const accountId = input.claims.hostUserId;
    const productId = input.params[mapping.productIdParam];
    const orderId = input.params[mapping.orderIdParam];
    const quantity = input.params[mapping.quantityParam];
    if (
      typeof accountId !== 'string' ||
      typeof productId !== 'string' ||
      typeof orderId !== 'string' ||
      orderId.trim() === '' ||
      typeof quantity !== 'number' ||
      !Number.isInteger(quantity) ||
      quantity < 1
    ) {
      return { allowed: false, reason: 'bounded-policy-input-missing' };
    }
    const eligible = fulfillmentPolicies.filter(
      (policy) =>
        policy.accountId === accountId &&
        policy.toolId === tool.id &&
        policy.validUntil >= now() &&
        policy.productIds.includes(productId) &&
        quantity <= policy.maxCodesPerOrder,
    );
    if (eligible.length !== 1) {
      return { allowed: false, reason: eligible.length === 0 ? 'bounded-policy-miss' : 'bounded-policy-ambiguous' };
    }
    const policy = eligible[0]!;
    const today = dayKey(now());
    const reservationKey = `${policy.id}\0${orderId}`;
    if (fulfillmentReservations.has(reservationKey)) {
      return { allowed: false, reason: 'bounded-order-already-used' };
    }
    const usedToday = [...fulfillmentReservations.values()].filter(
      (reservation) => reservation.policyId === policy.id && reservation.day === today,
    ).length;
    if (usedToday >= policy.dailyOrderLimit) {
      return { allowed: false, reason: 'bounded-daily-limit' };
    }
    fulfillmentReservations.set(reservationKey, {
      policyId: policy.id,
      accountId,
      toolId: tool.id,
      orderId,
      day: today,
      state: 'pending',
      expiresAt: now() + ttlMs,
    });
    reservationByCall.set(callKey(input.sessionId, input.toolCallId), reservationKey);
    return { allowed: true };
  };

  const toolsById = new Map<string, ToolDefinition>();
  const paramsValidators = new Map<string, ValidateFunction>();
  const resultValidators = new Map<string, ValidateFunction>();
  const ajv = new Ajv2020({ strict: true });
  for (const tool of options.tools) {
    toolsById.set(tool.id, tool);
    paramsValidators.set(tool.id, ajv.compile(tool.params));
    resultValidators.set(tool.id, ajv.compile(tool.resultSchema));
  }
  // 内建跨站导航工具（ADR-013 渐进披露）：不在 options.tools 闭集内，专路裁决/签发；此处只备其入/出参校验器。
  const siteNavigateParamsValidator = ajv.compile(SITE_NAVIGATE_PARAMS_SCHEMA);
  const siteNavigateResultValidator = ajv.compile(SITE_NAVIGATE_RESULT_SCHEMA);

  // 命名空间纪律（ADR-013 批次②遗留）：跨 pack 同名 toolId 载入期即 fail-closed 拒启——
  // 同一 toolId 归属两个不同 pack 会使门禁/审计的工具归属含糊，MVP 直接拒绝启动而非静默择一。
  const packOfTool = new Map<string, string>();
  for (const { packId, toolId } of options.toolOwnership ?? []) {
    const prior = packOfTool.get(toolId);
    if (prior !== undefined && prior !== packId) {
      throw new Error(`工具命名空间冲突：toolId ${toolId} 同时归属 pack ${prior} 与 ${packId}，拒启`);
    }
    packOfTool.set(toolId, packId);
  }

  const sites = options.sites ?? [];
  /** navigate 目标 URL 是否落在某已安装 pack 的 site 围栏内（origin 精确 + location 前缀）。 */
  const urlInFence = (url: string): boolean => {
    let origin: string;
    let path: string;
    try {
      const parsed = new URL(url);
      origin = parsed.origin;
      path = parsed.pathname;
    } catch {
      return false;
    }
    return sites.some((site) => site.origin === origin && site.locations.some((loc) => locationMatches(path, loc)));
  };

  /**
   * http/server 请求 URL 围栏（site pack，ADR-013）：相对路径由用户会话锚定 pack origin（恒在围栏内）；
   * 绝对 URL 的 origin 须 === 工具所属 pack origin，越界即拒（跨 origin 代发不签发）。legacy pack 不设围栏。
   */
  const httpUrlWithinFence = (renderedUrl: string, packOrigin: string | undefined): boolean => {
    if (packOrigin === undefined) return true;
    if (!/^https?:\/\//i.test(renderedUrl)) return true;
    try {
      return new URL(renderedUrl).origin === packOrigin;
    } catch {
      return false;
    }
  };

  /**
   * http/server 工具身份口径（ADR-013 U7 细化）：dom 工具在用户页面会话内执行、无 claims 注入面，
   * 只要求平台 JWT（网关已验签）——放行；http/server 工具须有宿主身份：
   *  - legacy pack（无 packOrigin）：沿用平台 claims.hostUserId；
   *  - site pack（有 packOrigin）：须有该 origin 的 claimsForOrigin 且 hostUserId 非空、未过期，否则 fail-closed。
   * 返回 deny 理由字符串，或 null（通过）。
   */
  const checkIdentity = (
    tool: ToolDefinition,
    input: { claims: IdentityClaims; packOrigin?: string; claimsForOrigin?: IdentityClaims },
  ): string | null => {
    if (isDomTool(tool)) return null;
    if (input.packOrigin === undefined) {
      return input.claims.hostUserId ? null : 'identity';
    }
    const site = input.claimsForOrigin;
    if (!site || !site.hostUserId) return `该站点身份缺失（${input.packOrigin}）`;
    if (typeof site.exp === 'number' && site.exp * 1000 <= now()) {
      return `该站点身份已过期（${input.packOrigin}）`;
    }
    return null;
  };

  /** http/server 渲染与围栏所用宿主身份：site pack 用 claimsForOrigin，legacy 用平台 claims。 */
  const httpIdentity = (input: {
    claims: IdentityClaims;
    packOrigin?: string;
    claimsForOrigin?: IdentityClaims;
  }): IdentityClaims => {
    if (input.packOrigin !== undefined) {
      if (input.claimsForOrigin === undefined) throw new Error('签发前提破坏：site pack 缺 claimsForOrigin');
      return input.claimsForOrigin;
    }
    return input.claims;
  };

  function deny(reason: string): GateDecision {
    return { verdict: 'deny', reason };
  }

  /** 一次性签名并登记 nonce（U7）：签名精确覆盖将执行的 {nonce,ttl,toolCallId,request}，客户端执行前校验完整性。 */
  function signInstruction(
    input: IssueExecInstructionInput,
    request: ExecRequest | DomExecRequest,
  ): ExecInstructionFrame {
    const nonce = randomUUID();
    const signature = computeExecSignature(options.signingSecret, {
      nonce,
      ttl: ttlMs,
      toolCallId: input.toolCallId,
      request: request as unknown as JsonValue,
    });
    const fulfillmentReservationKey = reservationByCall.get(callKey(input.sessionId, input.toolCallId));
    store.put(nonce, {
      toolId: input.toolId,
      toolCallId: input.toolCallId,
      issuedAt: now(),
      ttl: ttlMs,
      consumed: false,
      ...(fulfillmentReservationKey !== undefined ? { fulfillmentReservationKey } : {}),
    });
    return {
      type: 'exec-instruction',
      sessionId: input.sessionId,
      nonce,
      ttl: ttlMs,
      signature,
      toolCallId: input.toolCallId,
      request,
    };
  }

  return {
    async decide(input: GateDecisionInput): Promise<GateDecision> {
      // 内建跨站导航（ADR-013 渐进披露）：不在工具闭集内，专路裁决——参数不过即 deny；
      // 目标 URL 须落在某已安装 pack 的 site 围栏内（跨站允许别 pack origin，但必须已安装），否则 fence-violation。
      // 带 task 且该任务已获批 → 放行（导航是任务的一步，共享任务级授权）；无 task 或未获批仍 hitl。
      if (input.toolId === SITE_NAVIGATE_TOOL_ID) {
        if (!siteNavigateParamsValidator(input.params)) return deny('invalid-params');
        const url = input.params['url'];
        if (typeof url !== 'string' || !urlInFence(url)) return deny('fence-violation');
        const navTask = input.params['task'];
        if (typeof navTask === 'string' && consumeGrant(input.sessionId, navTask)) {
          return { verdict: 'allow' };
        }
        return { verdict: 'hitl' };
      }
      // fail-closed 判定链：任一前置不过即 deny，reason 只述依据、不含实参值（U7 / SEC-04）。
      const tool = toolsById.get(input.toolId);
      if (!tool) return deny('unknown-tool');
      if (!KNOWN_RISK_TIERS.has(tool.riskTier)) return deny('unknown-risk-tier');
      // 通道闸 fail-closed：闭集两值都已实现（client 代执行 / server 直调）；显式列举，未来枚举扩张时新通道默认被拒而非静默降级（U3/U7）。
      if (tool.execution !== 'client' && tool.execution !== 'server')
        return deny('channel-not-implemented');
      const validateParams = paramsValidators.get(input.toolId);
      if (!validateParams || !validateParams(input.params)) return deny('invalid-params');
      // 身份口径按 adapter 形态分派（ADR-013）：dom 只要求平台 JWT，http/server 要求宿主 claims（site pack 按 per-origin）。
      const identityDenial = checkIdentity(tool, input);
      if (identityDenial !== null) return deny(identityDenial);
      if (tool.riskTier === 'forbidden') return deny('forbidden');
      if (isDomTool(tool)) {
        const validated = validateDomSteps(tool, input.params, input.domContext, input.packOrigin, urlInFence);
        if ('reason' in validated) return deny(validated.reason);
      }
      // 任务级授权（跨工具共享）：带 task 且同会话该任务已获批未闲置过期 → 放行（一任务一确认）。
      // 复用判定必须在 dom 步骤校验之后——已授权任务的非法批次仍 deny（U7 fail-closed）；
      // every-call 工具跳过复用查询（对外不可撤回动作次次单独确认，不复用授权）。
      const grantTask = input.params['task'];
      if (
        tool.riskTier === 'hitl' &&
        tool.hitlMode !== 'every-call' &&
        typeof grantTask === 'string' &&
        consumeGrant(input.sessionId, grantTask)
      ) {
        return { verdict: 'allow' };
      }
      // ADR-016：every-call 对自由文本仍次次确认；只有声明了 bounded-fulfillment 且本次调用
      // 完整命中服务端预批准策略时才自动放行。decide 同步完成订单预占，日限额并发下不超卖。
      if (tool.riskTier === 'hitl' && tool.authorization?.kind === 'bounded-fulfillment') {
        const bounded = reserveBoundedFulfillment(tool, input);
        if (bounded.allowed) return { verdict: 'allow' };
        return { verdict: 'hitl', ...(bounded.reason !== undefined ? { reason: bounded.reason } : {}) };
      }
      return { verdict: tool.riskTier === 'hitl' ? 'hitl' : 'allow' };
    },

    async grantHitl(input: HitlGrantInput): Promise<void> {
      hitlGrants.set(grantKey(input.sessionId, input.task), now());
    },

    async issueExecInstruction(input: IssueExecInstructionInput): Promise<ExecInstructionFrame> {
      // 内建跨站导航：签发是治理终点，签名前独立重校验（参数 + 目标围栏），构造一次性 navigate dom 指令。
      if (input.toolId === SITE_NAVIGATE_TOOL_ID) {
        if (!siteNavigateParamsValidator(input.params)) {
          throw new Error('site_navigate 签发前提破坏：参数校验未过');
        }
        const url = String(input.params['url'] ?? '');
        if (!urlInFence(url)) throw new Error('site_navigate 签发拒绝：目标 URL 越出已安装站点围栏');
        return signInstruction(input, { kind: 'dom', steps: [{ action: 'navigate', url }] });
      }
      const tool = toolsById.get(input.toolId);
      if (!tool) throw new Error(`issueExecInstruction 前提破坏：未知 toolId`);
      let request: ExecRequest | DomExecRequest;
      if (isDomTool(tool)) {
        // 签发是治理终点：签名前独立重校验，不依赖 decide 已通过的假设（U7 fail-closed）。
        const validated = validateDomSteps(tool, input.params, input.domContext, input.packOrigin, urlInFence);
        if ('reason' in validated) throw new Error(`dom 批次校验未过：${validated.reason}`);
        request = { kind: 'dom', steps: validated.steps };
      } else {
        const adapter = tool.adapter;
        // 渲染上下文＝工具实参 + 已验签身份字段；身份后置覆盖，防工具经同名 param 冒充身份（如伪造 hostUserId）。
        // site pack 用 per-origin 身份（httpIdentity），legacy 用平台 claims。
        const idc = httpIdentity(input);
        const ctx: JsonObject = {
          ...input.params,
          hostUserId: idc.hostUserId,
          tenant: idc.tenant,
          sub: idc.sub,
        };
        const url = renderTemplate(adapter.urlTemplate, ctx, encodeURIComponent);
        if (!httpUrlWithinFence(url, input.packOrigin)) {
          throw new Error(`签发拒绝：请求 URL 越出 pack ${input.packOrigin} 围栏`);
        }
        request = {
          method: adapter.method,
          url,
          ...(adapter.headers ? { headers: renderHeaders(adapter.headers, ctx) } : {}),
          ...(adapter.bodyTemplate !== undefined
            ? { body: renderBody(adapter.bodyTemplate, ctx) }
            : {}),
        };
      }
      return signInstruction(input, request);
    },

    async acceptExecResult(input: AcceptExecResultInput): Promise<Observation> {
      const { result } = input;
      const record = store.get(result.nonce);
      if (!record) return { toolCallId: '', ok: false, content: null, error: 'unknown-nonce' };
      // 一次性防重放优先于超时：已核销一律 replayed，即便本已超时（U7）。
      if (record.consumed) {
        return { toolCallId: record.toolCallId, ok: false, content: null, error: 'replayed' };
      }
      if (now() - record.issuedAt > record.ttl) {
        store.markConsumed(result.nonce);
        if (record.fulfillmentReservationKey !== undefined) {
          const reservation = fulfillmentReservations.get(record.fulfillmentReservationKey);
          if (reservation?.state === 'pending') reservation.state = 'uncertain';
        }
        return { toolCallId: record.toolCallId, ok: false, content: null, error: 'timeout' };
      }
      store.markConsumed(result.nonce);
      if (!result.ok) {
        if (record.fulfillmentReservationKey !== undefined) {
          const reservation = fulfillmentReservations.get(record.fulfillmentReservationKey);
          if (reservation?.state === 'pending') reservation.state = 'uncertain';
        }
        // 用户点停止＝收回自动执行授权：吊销本会话全部任务 grant，后续批次回到 hitl。
        if (result.error === USER_STOPPED_ERROR) revokeGrants(input.sessionId);
        return {
          toolCallId: record.toolCallId,
          ok: false,
          content: null,
          error: result.error ?? 'exec-failed',
        };
      }
      // 不采信客户端上报原文：唯有过服务端 resultSchema 校验才回喂 agent（U7）。内建 site_navigate 用其专属结果校验器。
      const validateResult =
        record.toolId === SITE_NAVIGATE_TOOL_ID
          ? siteNavigateResultValidator
          : resultValidators.get(record.toolId);
      const body = result.body ?? null;
      if (!validateResult || !validateResult(body)) {
        if (record.fulfillmentReservationKey !== undefined) {
          const reservation = fulfillmentReservations.get(record.fulfillmentReservationKey);
          if (reservation?.state === 'pending') reservation.state = 'uncertain';
        }
        return { toolCallId: record.toolCallId, ok: false, content: null, error: 'invalid-result' };
      }
      if (record.fulfillmentReservationKey !== undefined) {
        const reservation = fulfillmentReservations.get(record.fulfillmentReservationKey);
        if (reservation?.state === 'pending') reservation.state = 'completed';
      }
      return { toolCallId: record.toolCallId, ok: true, content: body };
    },

    async executeServer(input: IssueExecInstructionInput): Promise<Observation> {
      const tool = toolsById.get(input.toolId);
      if (!tool) throw new Error('executeServer 前提破坏：未知 toolId');
      if (tool.execution !== 'server') throw new Error('executeServer 前提破坏：非 server 通道');
      const adapter = tool.adapter;
      // 渲染上下文＝实参 + 已验签身份（身份后置覆盖防冒充）+ 解析出的凭证；凭证真值仅参与本次请求构造，不落任何返回/日志。
      // site pack 用 per-origin 身份，legacy 用平台 claims。
      const idc = httpIdentity(input);
      const ctx: JsonObject = {
        ...input.params,
        hostUserId: idc.hostUserId,
        tenant: idc.tenant,
        sub: idc.sub,
      };
      const targetUrl = renderTemplate(adapter.urlTemplate, ctx, encodeURIComponent);
      if (!httpUrlWithinFence(targetUrl, input.packOrigin)) {
        return { toolCallId: input.toolCallId, ok: false, content: null, error: 'fence-violation' };
      }
      if (adapter.credentialRef !== undefined) {
        const credential = options.resolveCredential?.(adapter.credentialRef);
        if (credential === undefined) {
          return { toolCallId: input.toolCallId, ok: false, content: null, error: 'credential-unresolved' };
        }
        // adapter 模板以 {{credential}} 占位注入（如 "Authorization": "Bearer {{credential}}"）。
        ctx.credential = credential;
      }
      const headers = adapter.headers ? renderHeaders(adapter.headers, ctx) : {};
      const bodyValue = adapter.bodyTemplate !== undefined ? renderBody(adapter.bodyTemplate, ctx) : undefined;
      if (bodyValue !== undefined && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
        headers['content-type'] = 'application/json';
      }
      const doFetch = options.fetchImpl ?? fetch;
      let response: Response;
      try {
        response = await doFetch(targetUrl, {
          method: adapter.method,
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
          ...(bodyValue !== undefined ? { body: JSON.stringify(bodyValue) } : {}),
        });
      } catch {
        return { toolCallId: input.toolCallId, ok: false, content: null, error: 'exec-failed' };
      }
      let body: JsonValue = null;
      try {
        body = (await response.json()) as JsonValue;
      } catch {
        body = null;
      }
      // 不采信宿主原文：唯有过服务端 resultSchema 校验才回喂 agent（U7）。非 2xx 且无有效结果体归 exec-failed。
      const validateResult = resultValidators.get(input.toolId);
      if (!validateResult || !validateResult(body)) {
        const error = response.ok ? 'invalid-result' : 'exec-failed';
        return { toolCallId: input.toolCallId, ok: false, content: null, error };
      }
      return { toolCallId: input.toolCallId, ok: true, content: body };
    },
  };
}
