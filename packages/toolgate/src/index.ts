import { createHmac, randomUUID } from 'node:crypto';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import { isDomTool } from '@zen-agent/contracts';
import type {
  DomExecRequest,
  DomGateContext,
  DomStep,
  DomToolDefinition,
  ExecInstructionFrame,
  ExecRequest,
  GateDecision,
  GateDecisionInput,
  IssueExecInstructionInput,
  JsonObject,
  JsonValue,
  Observation,
  ToolDefinition,
  ToolGatePort,
  AcceptExecResultInput,
} from '@zen-agent/contracts';

export interface ToolGateOptions {
  /** 分级判定的工具定义闭集：id 不在集内或 riskTier 未知一律 deny（fail-closed，U7）。 */
  tools: ToolDefinition[];
  /** 代执行指令签名密钥；server 经 env 注入，MUST NOT 落日志/审计（ZA-C-SEC-01/02）。 */
  signingSecret: string;
  /** 一次性指令存活毫秒数，默认 60000。 */
  ttlMs?: number;
  /** 时钟注入点（默认 Date.now），仅测试用于驱动 ttl；内部参数，非端口。 */
  now?: () => number;
  /**
   * server 通道凭证解析：ref→真值；真值 MUST NOT 落日志/审计/Context（SEC-01/02），
   * 由组装层运行时注入、不写进 toolgate。缺省或解析不到按未配置处理（executeServer 返回 credential-unresolved）。
   */
  resolveCredential?: (ref: string) => string | undefined;
  /** fetch 注入点，仅测试用于替身；默认全局 fetch。 */
  fetchImpl?: typeof fetch;
}

const DEFAULT_TTL_MS = 60000;

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

/** ②-a 已实现的 dom 动作；navigate/waitFor 契约保留、命中即拒（锚点=②-b 跨导航续跑）。 */
const IMPLEMENTED_DOM_ACTIONS = new Set(['click', 'fill', 'select', 'read', 'scroll', 'highlight']);
const RESERVED_DOM_ACTIONS = new Set(['navigate', 'waitFor']);
const MAX_DOM_STEPS = 20;
const READ_NAME_PATTERN = /^[\w-]{1,64}$/;

/**
 * dom 批次 fail-closed 校验（U7）：动作闭集、ref 出自最近快照、fill/select 有值、read 有键名、
 * 快照页路径在围栏内。通过则返回只含已知字段的净化步骤（剥离 LLM 幻觉出的多余键，签名精确覆盖将执行内容）；
 * 任一不过返回 reason 字符串（不含实参值，SEC-04）。
 */
function validateDomSteps(
  tool: DomToolDefinition,
  params: JsonObject,
  domContext: DomGateContext | undefined,
): { steps: DomStep[] } | { reason: string } {
  if (domContext === undefined) return { reason: 'dom-context-missing' };
  if (!tool.adapter.pathPrefixes.some((prefix) => domContext.path.startsWith(prefix))) {
    return { reason: 'fence-violation' };
  }
  const raw = params['steps'];
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_DOM_STEPS) {
    return { reason: 'invalid-steps' };
  }
  const refs = new Set(domContext.refs);
  const steps: DomStep[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return { reason: 'invalid-step-shape' };
    }
    const { action, ref, value, name } = item as Record<string, JsonValue>;
    if (typeof action !== 'string') return { reason: 'invalid-step-shape' };
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
  const now = options.now ?? Date.now;
  const store = new InMemoryNonceStore();

  const toolsById = new Map<string, ToolDefinition>();
  const paramsValidators = new Map<string, ValidateFunction>();
  const resultValidators = new Map<string, ValidateFunction>();
  const ajv = new Ajv2020({ strict: true });
  for (const tool of options.tools) {
    toolsById.set(tool.id, tool);
    paramsValidators.set(tool.id, ajv.compile(tool.params));
    resultValidators.set(tool.id, ajv.compile(tool.resultSchema));
  }

  function deny(reason: string): GateDecision {
    return { verdict: 'deny', reason };
  }

  return {
    async decide(input: GateDecisionInput): Promise<GateDecision> {
      // fail-closed 判定链：任一前置不过即 deny，reason 只述依据、不含实参值（U7 / SEC-04）。
      const tool = toolsById.get(input.toolId);
      if (!tool) return deny('unknown-tool');
      if (!KNOWN_RISK_TIERS.has(tool.riskTier)) return deny('unknown-risk-tier');
      // 通道闸 fail-closed：闭集两值都已实现（client 代执行 / server 直调）；显式列举，未来枚举扩张时新通道默认被拒而非静默降级（U3/U7）。
      if (tool.execution !== 'client' && tool.execution !== 'server')
        return deny('channel-not-implemented');
      const validateParams = paramsValidators.get(input.toolId);
      if (!validateParams || !validateParams(input.params)) return deny('invalid-params');
      if (!input.claims.hostUserId) return deny('identity');
      if (tool.riskTier === 'forbidden') return deny('forbidden');
      if (isDomTool(tool)) {
        const validated = validateDomSteps(tool, input.params, input.domContext);
        if ('reason' in validated) return deny(validated.reason);
      }
      return { verdict: tool.riskTier === 'hitl' ? 'hitl' : 'allow' };
    },

    async issueExecInstruction(input: IssueExecInstructionInput): Promise<ExecInstructionFrame> {
      const tool = toolsById.get(input.toolId);
      if (!tool) throw new Error(`issueExecInstruction 前提破坏：未知 toolId`);
      let request: ExecRequest | DomExecRequest;
      if (isDomTool(tool)) {
        // 签发是治理终点：签名前独立重校验，不依赖 decide 已通过的假设（U7 fail-closed）。
        const validated = validateDomSteps(tool, input.params, input.domContext);
        if ('reason' in validated) throw new Error(`dom 批次校验未过：${validated.reason}`);
        request = { kind: 'dom', steps: validated.steps };
      } else {
        const adapter = tool.adapter;
        // 渲染上下文＝工具实参 + 已验签身份字段；身份后置覆盖，防工具经同名 param 冒充身份（如伪造 hostUserId）。
        const ctx: JsonObject = {
          ...input.params,
          hostUserId: input.claims.hostUserId,
          tenant: input.claims.tenant,
          sub: input.claims.sub,
        };
        request = {
          method: adapter.method,
          url: renderTemplate(adapter.urlTemplate, ctx, encodeURIComponent),
          ...(adapter.headers ? { headers: renderHeaders(adapter.headers, ctx) } : {}),
          ...(adapter.bodyTemplate !== undefined
            ? { body: renderBody(adapter.bodyTemplate, ctx) }
            : {}),
        };
      }
      const nonce = randomUUID();
      const signature = computeExecSignature(options.signingSecret, {
        nonce,
        ttl: ttlMs,
        toolCallId: input.toolCallId,
        request: request as unknown as JsonValue,
      });
      store.put(nonce, {
        toolId: input.toolId,
        toolCallId: input.toolCallId,
        issuedAt: now(),
        ttl: ttlMs,
        consumed: false,
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
        return { toolCallId: record.toolCallId, ok: false, content: null, error: 'timeout' };
      }
      store.markConsumed(result.nonce);
      if (!result.ok) {
        return {
          toolCallId: record.toolCallId,
          ok: false,
          content: null,
          error: result.error ?? 'exec-failed',
        };
      }
      // 不采信客户端上报原文：唯有过服务端 resultSchema 校验才回喂 agent（U7）。
      const validateResult = resultValidators.get(record.toolId);
      const body = result.body ?? null;
      if (!validateResult || !validateResult(body)) {
        return { toolCallId: record.toolCallId, ok: false, content: null, error: 'invalid-result' };
      }
      return { toolCallId: record.toolCallId, ok: true, content: body };
    },

    async executeServer(input: IssueExecInstructionInput): Promise<Observation> {
      const tool = toolsById.get(input.toolId);
      if (!tool) throw new Error('executeServer 前提破坏：未知 toolId');
      if (tool.execution !== 'server') throw new Error('executeServer 前提破坏：非 server 通道');
      const adapter = tool.adapter;
      // 渲染上下文＝实参 + 已验签身份（身份后置覆盖防冒充）+ 解析出的凭证；凭证真值仅参与本次请求构造，不落任何返回/日志。
      const ctx: JsonObject = {
        ...input.params,
        hostUserId: input.claims.hostUserId,
        tenant: input.claims.tenant,
        sub: input.claims.sub,
      };
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
        response = await doFetch(renderTemplate(adapter.urlTemplate, ctx, encodeURIComponent), {
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
