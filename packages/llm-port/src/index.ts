import type { JsonObject, LlmChatRequest, LlmPort, LlmStreamEvent } from '@zen-agent/contracts';

export interface LlmPortOptions {
  /** provider 白名单：白名单外的 provider（含 model 的 `<provider>/` 前缀）fail-closed 拒绝；密钥托管在实现侧、经环境变量注入。 */
  allowedProviders: string[];
}

const DEFAULT_PROVIDER = 'openai-compatible';

export function createLlmPort(options: LlmPortOptions): LlmPort {
  const allowed = new Set(options.allowedProviders);
  return {
    chat(request) {
      return chatStream(allowed, request);
    },
  };
}

function doneError(error: string): LlmStreamEvent {
  return { kind: 'done', stopReason: 'error', error };
}

interface ToolCallDraft {
  id?: string;
  name: string;
  args: string;
}

/**
 * 一切失败路径（白名单/env 缺失/上游 4xx/断流/实参非法）不抛异常，
 * 统一以 done error 事件收尾；错误文案只含键名与状态类别，不含 env 值（SEC-04）。
 */
async function* chatStream(
  allowed: ReadonlySet<string>,
  request: LlmChatRequest,
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
  if (!allowed.has(provider)) {
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

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify(buildBody(model, request)),
    });
    if (!response.ok) {
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
    for await (const data of sseDataLines(response.body)) {
      if (data === '[DONE]') {
        sawDone = true;
        break;
      }
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
          yield doneError(`工具调用实参非法（${draft.name || `#${index}`}）`);
          return;
        }
        yield {
          kind: 'tool-call',
          toolCallId: draft.id ?? `tool-call-${index}`,
          name: draft.name,
          params,
        };
      }
      yield { kind: 'done', stopReason: 'tool-call' };
      return;
    }
    yield { kind: 'done', stopReason: 'end' };
  } catch (err) {
    yield doneError(`上游请求失败（${err instanceof Error ? err.name : 'unknown'}）`);
  }
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
    messages: request.messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.toolCallId !== undefined ? { tool_call_id: m.toolCallId } : {}),
    })),
  };
  if (request.tools !== undefined && request.tools.length > 0) {
    body['tools'] = request.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.params },
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
