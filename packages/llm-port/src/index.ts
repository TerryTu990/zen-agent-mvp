import type {
  JsonObject,
  LlmChatRequest,
  LlmErrorKind,
  LlmPort,
  LlmStreamEvent,
} from '@zen-agent/contracts';

/**
 * 分层超时上限（毫秒）：任一项缺省即该层不启用——三项全缺省时本模块不建任何计时器、
 * 不组合任何取消信号，行为与无超时基线严格等价。
 */
export interface LlmTimeouts {
  /** 整段调用（含流式读取）的绝对上限。 */
  totalMs?: number;
  /** 请求发出到收到首个响应字节的上限。 */
  firstChunkMs?: number;
  /** 相邻响应字节之间的静默上限（每收到一片即重置）。 */
  idleMs?: number;
}

export interface LlmPortOptions {
  /** provider 白名单：白名单外的 provider（含 model 的 `<provider>/` 前缀）fail-closed 拒绝；密钥托管在实现侧、经环境变量注入。 */
  allowedProviders: string[];
  /** fetch 替身（测试注入用），缺省用全局 fetch。 */
  fetchImpl?: typeof fetch;
  /** 网络层瞬时失败重试一次前的退避毫秒，默认 300；测试注入 0 免等待。 */
  retryDelayMs?: number;
  /** 缺省时按 env `ZA_LLM_TIMEOUT_MS` / `ZA_LLM_FIRST_CHUNK_MS` / `ZA_LLM_IDLE_MS` 取值（非正整数视为未设）。 */
  timeouts?: LlmTimeouts;
  /** 缺省 true：有 tools 的请求体声明 `parallel_tool_calls:false`；置 false 则不声明，兼容不支持该字段的上游。 */
  declareParallelToolCalls?: boolean;
}

const DEFAULT_PROVIDER = 'openai-compatible';

interface ChatConfig {
  allowed: ReadonlySet<string>;
  fetchImpl: typeof fetch;
  retryDelayMs: number;
  timeouts: LlmTimeouts;
  declareParallelToolCalls: boolean;
}

/** env 超时值解析：非正整数（含 0、负数、非数字、空串）一律视为未设置，不启用该层。 */
function envTimeout(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function resolveTimeouts(options: LlmPortOptions): LlmTimeouts {
  if (options.timeouts !== undefined) return options.timeouts;
  return {
    ...(envTimeout('ZA_LLM_TIMEOUT_MS') !== undefined ? { totalMs: envTimeout('ZA_LLM_TIMEOUT_MS')! } : {}),
    ...(envTimeout('ZA_LLM_FIRST_CHUNK_MS') !== undefined
      ? { firstChunkMs: envTimeout('ZA_LLM_FIRST_CHUNK_MS')! }
      : {}),
    ...(envTimeout('ZA_LLM_IDLE_MS') !== undefined ? { idleMs: envTimeout('ZA_LLM_IDLE_MS')! } : {}),
  };
}

export function createLlmPort(options: LlmPortOptions): LlmPort {
  const config: ChatConfig = {
    allowed: new Set(options.allowedProviders),
    fetchImpl: options.fetchImpl ?? fetch,
    retryDelayMs: options.retryDelayMs ?? 300,
    timeouts: resolveTimeouts(options),
    declareParallelToolCalls: options.declareParallelToolCalls ?? true,
  };
  const active = new Map<string, AbortController>();
  return {
    chat(request) {
      if (request.requestId === undefined) return chatStream(config, request);
      const controller = new AbortController();
      active.set(request.requestId, controller);
      return trackedChatStream(config, request, controller.signal, () => {
        if (active.get(request.requestId!) === controller) active.delete(request.requestId!);
      });
    },
    cancel(requestId) {
      active.get(requestId)?.abort();
    },
  };
}

async function* trackedChatStream(
  config: ChatConfig,
  request: LlmChatRequest,
  signal: AbortSignal,
  cleanup: () => void,
): AsyncGenerator<LlmStreamEvent> {
  try {
    yield* chatStream(config, request, signal);
  } finally {
    cleanup();
  }
}

function doneError(error: string, errorKind?: LlmErrorKind): LlmStreamEvent {
  return { kind: 'done', stopReason: 'error', error, ...(errorKind !== undefined ? { errorKind } : {}) };
}

/** 上下文超长的上游措辞特征（各家 OpenAI 兼容网关措辞不一，取共有关键片段）。 */
const CONTEXT_OVERFLOW_RE =
  /context[_ ]length|context window|maximum context|too many tokens|prompt is too long|输入过长|上下文/i;
/** 配额耗尽与单纯限流在同一 429 上区分：前者需人去充值，后者稍后重试即可。 */
const QUOTA_RE = /insufficient_quota|quota|billing|credit|欠费|余额/i;

/**
 * 上游非 2xx 分类：只据状态码与响应体特征给出类别与面向调用方的文案。
 * 文案 MUST NOT 携带响应体原文、URL 查询串或任何凭证形态，只含状态类别与配置键名（SEC-04）。
 */
function classifyHttpFailure(status: number, detail: string): { kind?: LlmErrorKind; text: string } {
  if (status === 401 || status === 403) {
    return { kind: 'auth', text: `上游拒绝身份凭证（HTTP ${status}）：请检查 ZA_LLM_API_KEY` };
  }
  if (status === 429) {
    return QUOTA_RE.test(detail)
      ? { kind: 'quota', text: '上游配额已耗尽（HTTP 429）' }
      : { kind: 'rate-limit', text: '上游限流（HTTP 429）' };
  }
  if ((status === 400 || status === 413) && CONTEXT_OVERFLOW_RE.test(detail)) {
    return { kind: 'context-overflow', text: `上游拒绝：上下文超出模型窗口（HTTP ${status}）` };
  }
  if (status === 404) {
    return { kind: 'endpoint-invalid', text: `上游端点不存在（HTTP ${status}）：请检查 ZA_LLM_BASE_URL` };
  }
  return { text: `上游响应异常（HTTP ${status}）` };
}

/** fetch reject 分类：URL 不可解析＝配置错误，其余归传输层。 */
function classifyFetchFailure(err: unknown): { kind?: LlmErrorKind; text: string } {
  const name = err instanceof Error ? err.name : 'unknown';
  const message = err instanceof Error ? err.message : '';
  if (/parse url|invalid url/i.test(message)) {
    return { kind: 'endpoint-invalid', text: '上游端点地址不可解析：请检查 ZA_LLM_BASE_URL' };
  }
  return { kind: 'transport', text: `上游请求失败（${name}）` };
}

type TimeoutLayer = 'total' | 'first-chunk' | 'idle';

/**
 * 分层超时闸：三层上限全缺省时 create 返回 null——调用侧据此走零计时器、零信号组合的基线路径。
 * 到点即 abort 组合信号；触发层别只用于如实报错，不改变收口方式。
 */
interface TimeoutGate {
  signal: AbortSignal;
  /** 收到响应字节时调用：清首字节上限、按 idleMs 重新起表。 */
  onActivity(): void;
  /** 触发的层别；null=未因超时收口（用户取消或正常结束）。 */
  firedLayer(): TimeoutLayer | null;
  dispose(): void;
}

function createTimeoutGate(timeouts: LlmTimeouts, userSignal?: AbortSignal): TimeoutGate | null {
  const { totalMs, firstChunkMs, idleMs } = timeouts;
  if (totalMs === undefined && firstChunkMs === undefined && idleMs === undefined) return null;
  const controller = new AbortController();
  let fired: TimeoutLayer | null = null;
  let total: ReturnType<typeof setTimeout> | undefined;
  let stage: ReturnType<typeof setTimeout> | undefined;
  const fire = (layer: TimeoutLayer): void => {
    fired ??= layer;
    controller.abort();
  };
  const arm = (ms: number | undefined, layer: TimeoutLayer): void => {
    if (stage !== undefined) clearTimeout(stage);
    stage = undefined;
    if (ms === undefined) return;
    stage = setTimeout(() => fire(layer), ms);
    stage.unref?.();
  };
  if (totalMs !== undefined) {
    total = setTimeout(() => fire('total'), totalMs);
    total.unref?.();
  }
  // 首字节上限缺省时用空闲上限起表：静默上限从请求发出即计，否则「一个字节都不来」将无人看管。
  arm(firstChunkMs ?? idleMs, firstChunkMs !== undefined ? 'first-chunk' : 'idle');
  return {
    signal:
      userSignal !== undefined
        ? AbortSignal.any([userSignal, controller.signal])
        : controller.signal,
    onActivity: () => arm(idleMs, 'idle'),
    firedLayer: () => fired,
    dispose: () => {
      if (total !== undefined) clearTimeout(total);
      if (stage !== undefined) clearTimeout(stage);
    },
  };
}

interface ToolCallDraft {
  id?: string;
  name: string;
  args: string;
}

interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * 从流帧解析上游 token 用量（OpenAI `stream_options.include_usage` 末帧：choices 空、带 usage）。
 * 字段缺失/类型不符 → undefined，由消费侧回退字符近似（usage 是可选透传，非硬要求）。
 */
function parseUsage(data: string): LlmUsage | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (typeof payload !== 'object' || payload === null) return undefined;
  const usage = (payload as { usage?: unknown }).usage;
  if (typeof usage !== 'object' || usage === null) return undefined;
  const { prompt_tokens, completion_tokens } = usage as {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
  };
  if (typeof prompt_tokens !== 'number' || typeof completion_tokens !== 'number') return undefined;
  return { inputTokens: prompt_tokens, outputTokens: completion_tokens };
}

/**
 * 一切失败路径（白名单/env 缺失/上游 4xx/断流/实参非法）不抛异常，
 * 统一以 done error 事件收尾；错误文案只含键名与状态类别，不含 env 值（SEC-04）。
 */
async function* chatStream(
  config: ChatConfig,
  request: LlmChatRequest,
  signal?: AbortSignal,
): AsyncGenerator<LlmStreamEvent> {
  let provider = DEFAULT_PROVIDER;
  let model = request.model;
  if (model !== undefined) {
    const slash = model.indexOf('/');
    if (slash > 0) {
      provider = model.slice(0, slash);
      model = model.slice(slash + 1);
    }
  }
  if (!config.allowed.has(provider)) {
    yield doneError(`provider 不在白名单：${provider}`);
    return;
  }
  model ??= process.env['ZA_LLM_MODEL'];
  if (!model) {
    yield doneError('未指定 model 且 ZA_LLM_MODEL 未设置');
    return;
  }
  const baseUrl = process.env['ZA_LLM_BASE_URL'];
  if (!baseUrl) {
    yield doneError('ZA_LLM_BASE_URL 未设置');
    return;
  }

  // OpenAI 函数名合法集 ^[a-zA-Z0-9_-]+$ 不含点；toolId 以点分命名空间（<featureId>.<tool>），
  // 出网前点替换为 '__'、tool-call 回程还原，平台内部命名不变。映射冲突 fail-closed。
  const wireNames = new Map<string, string>();
  for (const tool of request.tools ?? []) {
    const wire = toWireName(tool.name);
    const existing = wireNames.get(wire);
    if (existing !== undefined && existing !== tool.name) {
      yield doneError(`工具名出网映射冲突：${existing} / ${tool.name}`);
      return;
    }
    wireNames.set(wire, tool.name);
  }

  // 三层超时全缺省时 gate 为 null：不建控制器、不建计时器、signal 原样透传（与基线严格等价）。
  const gate = createTimeoutGate(config.timeouts, signal);
  const effectiveSignal = gate?.signal ?? signal;
  // 响应正文已开读：此后的异常是断流，与「连不上/端点错」分列（用户取消另判，不属上游失败）。
  let streaming = false;
  try {
    const response = await fetchWithOneRetry(config, `${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify(buildBody(model, request, config)),
      ...(effectiveSignal !== undefined ? { signal: effectiveSignal } : {}),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      console.error(`[llm-port] 上游 ${response.status}：${detail.slice(0, 800)}`);
      const failure = classifyHttpFailure(response.status, detail);
      yield doneError(failure.text, failure.kind);
      return;
    }
    if (!response.body) {
      yield doneError('上游响应无正文');
      return;
    }

    streaming = true;
    const toolCalls = new Map<number, ToolCallDraft>();
    let finishReason: string | null = null;
    let sawDone = false;
    let usage: LlmUsage | undefined;
    for await (const data of sseDataLines(response.body, gate?.onActivity)) {
      if (data === '[DONE]') {
        sawDone = true;
        break;
      }
      const parsedUsage = parseUsage(data);
      if (parsedUsage !== undefined) usage = parsedUsage;
      const choice = parseChoice(data);
      if (choice === null) continue;
      if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;
      const delta = choice.delta;
      if (typeof delta?.content === 'string' && delta.content.length > 0) {
        yield { kind: 'text-delta', delta: delta.content };
      }
      if (Array.isArray(delta?.tool_calls)) mergeToolCallDeltas(toolCalls, delta.tool_calls);
    }

    if (!sawDone && finishReason === null) {
      yield doneError('上游流意外中断', 'stream-interrupted');
      return;
    }
    // 输出长度上限截断：本轮回答不完整，消费侧据此如实告知用户（R6），不当作正常收尾。
    const truncated = finishReason === 'length' ? ({ truncated: true } as const) : {};
    if (toolCalls.size > 0) {
      for (const [index, draft] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
        const params = parseToolParams(draft.args);
        if (params === null) {
          const name = wireNames.get(draft.name) ?? draft.name;
          // 诊断只落服务端本地日志且不含实参内容（SEC-01：arguments 可能携带密钥等敏感值）：
          // finish_reason=length + 大 args.length 即截断；否则为坏 JSON。
          console.error(
            `[llm-port] 工具实参非法：name=${name} finish_reason=${finishReason ?? 'null'} args.length=${draft.args.length}`,
          );
          yield {
            kind: 'done',
            stopReason: 'error',
            error: `工具调用实参非法（${name || `#${index}`}）`,
            errorKind: 'invalid-tool-args',
            invalidToolCall: { toolCallId: draft.id ?? `tool-call-${index}`, name },
          };
          return;
        }
        yield {
          kind: 'tool-call',
          toolCallId: draft.id ?? `tool-call-${index}`,
          name: wireNames.get(draft.name) ?? draft.name,
          params,
        };
      }
      yield { kind: 'done', stopReason: 'tool-call', ...truncated, ...(usage !== undefined ? { usage } : {}) };
      return;
    }
    yield { kind: 'done', stopReason: 'end', ...truncated, ...(usage !== undefined ? { usage } : {}) };
  } catch (err) {
    const layer = gate?.firedLayer() ?? null;
    if (layer !== null) {
      yield doneError(`上游响应超时（${layer}）`, 'timeout');
      return;
    }
    if (signal?.aborted === true) {
      yield doneError(`上游请求失败（${err instanceof Error ? err.name : 'unknown'}）`);
      return;
    }
    if (streaming) {
      yield doneError('上游流意外中断', 'stream-interrupted');
      return;
    }
    const failure = classifyFetchFailure(err);
    yield doneError(failure.text, failure.kind);
  } finally {
    gate?.dispose();
  }
}

/**
 * 网络层瞬时失败（fetch reject，如连接类 TypeError）退避后重试一次；
 * HTTP 错误响应（4xx/5xx）已是上游业务语义，原样返回、不重试。
 */
async function fetchWithOneRetry(
  config: ChatConfig,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await config.fetchImpl(url, init);
  } catch (cause) {
    if (init.signal?.aborted) throw cause;
    await new Promise((resolve) => setTimeout(resolve, config.retryDelayMs));
    return config.fetchImpl(url, init);
  }
}

/** OpenAI 兼容端点函数名不允许点；点分 toolId 出网替换为 '__'（当前 toolId 文法小写+连字符，无原生 '__'，可逆） */
function toWireName(name: string): string {
  return name.replace(/\./g, '__');
}

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const apiKey = process.env['ZA_LLM_API_KEY'];
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
  return headers;
}

function buildBody(model: string, request: LlmChatRequest, config: ChatConfig): JsonObject {
  const body: JsonObject = {
    model,
    stream: true,
    // 请求上游在流末追加 token 用量帧（choices 为空、带 usage）；上游不支持时静默忽略、无 usage 帧。
    stream_options: { include_usage: true },
    messages: request.messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.toolCallId !== undefined ? { tool_call_id: m.toolCallId } : {}),
      ...(m.toolCalls !== undefined && m.toolCalls.length > 0
        ? {
            tool_calls: m.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function',
              function: { name: toWireName(tc.name), arguments: JSON.stringify(tc.params) },
            })),
          }
        : {}),
    })),
  };
  if (request.tools !== undefined && request.tools.length > 0) {
    body['tools'] = request.tools.map((t) => ({
      type: 'function',
      function: { name: toWireName(t.name), description: t.description, parameters: t.params },
    }));
    // 每轮至多一个调用：与「逐个过 toolgate/HITL」的串行治理一致，也免除并行调用被截断的风险。
    // 上游对无 tools 的请求拒绝该字段，故只在有工具面时声明。
    if (config.declareParallelToolCalls) body['parallel_tool_calls'] = false;
  }
  return body;
}

async function* sseDataLines(
  body: ReadableStream<Uint8Array>,
  onActivity?: () => void,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    onActivity?.();
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (line.startsWith('data:')) yield line.slice(5).trim();
    }
  }
}

interface ChunkChoice {
  finish_reason?: string | null;
  delta?: {
    content?: unknown;
    tool_calls?: unknown[];
  };
}

function parseChoice(data: string): ChunkChoice | null {
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null) return null;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first: unknown = choices[0];
  if (typeof first !== 'object' || first === null) return null;
  return first as ChunkChoice;
}

function mergeToolCallDeltas(drafts: Map<number, ToolCallDraft>, deltas: unknown[]): void {
  for (const item of deltas) {
    if (typeof item !== 'object' || item === null) continue;
    const { index, id, function: fn } = item as {
      index?: unknown;
      id?: unknown;
      function?: { name?: unknown; arguments?: unknown };
    };
    const key = typeof index === 'number' ? index : 0;
    const draft = drafts.get(key) ?? { name: '', args: '' };
    if (typeof id === 'string') draft.id = id;
    if (typeof fn?.name === 'string') draft.name += fn.name;
    if (typeof fn?.arguments === 'string') draft.args += fn.arguments;
    drafts.set(key, draft);
  }
}

function parseToolParams(args: string): JsonObject | null {
  try {
    const parsed: unknown = JSON.parse(args === '' ? '{}' : args);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as JsonObject;
  } catch {
    return null;
  }
}
