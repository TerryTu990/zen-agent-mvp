import type { JsonObject, LlmChatRequest, LlmPort, LlmStreamEvent } from '@zen-agent/contracts';

export interface LlmPortOptions {
  /** provider 白名单：白名单外的 provider（含 model 的 `<provider>/` 前缀）fail-closed 拒绝；密钥托管在实现侧、经环境变量注入。 */
  allowedProviders: string[];
  /** fetch 替身（测试注入用），缺省用全局 fetch。 */
  fetchImpl?: typeof fetch;
  /** 网络层瞬时失败重试一次前的退避毫秒，默认 300；测试注入 0 免等待。 */
  retryDelayMs?: number;
}

const DEFAULT_PROVIDER = 'openai-compatible';

interface ChatConfig {
  allowed: ReadonlySet<string>;
  fetchImpl: typeof fetch;
  retryDelayMs: number;
}

export function createLlmPort(options: LlmPortOptions): LlmPort {
  const config: ChatConfig = {
    allowed: new Set(options.allowedProviders),
    fetchImpl: options.fetchImpl ?? fetch,
    retryDelayMs: options.retryDelayMs ?? 300,
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

function doneError(error: string, errorKind?: 'invalid-tool-args'): LlmStreamEvent {
  return { kind: 'done', stopReason: 'error', error, ...(errorKind !== undefined ? { errorKind } : {}) };
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

  try {
    const response = await fetchWithOneRetry(config, `${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify(buildBody(model, request)),
      ...(signal !== undefined ? { signal } : {}),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      console.error(`[llm-port] 上游 ${response.status}：${detail.slice(0, 800)}`);
      yield doneError(`上游响应异常（HTTP ${response.status}）`);
      return;
    }
    if (!response.body) {
      yield doneError('上游响应无正文');
      return;
    }

    const toolCalls = new Map<number, ToolCallDraft>();
    let finishReason: string | null = null;
    let sawDone = false;
    let usage: LlmUsage | undefined;
    for await (const data of sseDataLines(response.body)) {
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
      yield doneError('上游流意外中断');
      return;
    }
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
          yield doneError(`工具调用实参非法（${name || `#${index}`}）`, 'invalid-tool-args');
          return;
        }
        yield {
          kind: 'tool-call',
          toolCallId: draft.id ?? `tool-call-${index}`,
          name: wireNames.get(draft.name) ?? draft.name,
          params,
        };
      }
      yield { kind: 'done', stopReason: 'tool-call', ...(usage !== undefined ? { usage } : {}) };
      return;
    }
    yield { kind: 'done', stopReason: 'end', ...(usage !== undefined ? { usage } : {}) };
  } catch (err) {
    yield doneError(`上游请求失败（${err instanceof Error ? err.name : 'unknown'}）`);
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

function buildBody(model: string, request: LlmChatRequest): JsonObject {
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
  }
  return body;
}

async function* sseDataLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
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
