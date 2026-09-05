import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { JsonObject, LlmStreamEvent } from '@zen-agent/contracts';
import { createLlmPort } from '../src/index.js';
import { startMockLlmProcess, type MockLlmHandle } from './helpers/mock-llm.js';

let mock: MockLlmHandle;
const envBackup: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'ZA_LLM_BASE_URL',
  'ZA_LLM_API_KEY',
  'ZA_LLM_MODEL',
  'ZA_LLM_TIMEOUT_MS',
  'ZA_LLM_FIRST_CHUNK_MS',
  'ZA_LLM_IDLE_MS',
] as const;

beforeAll(async () => {
  mock = await startMockLlmProcess();
  for (const key of ENV_KEYS) envBackup[key] = process.env[key];
});

afterAll(async () => {
  await mock.close();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = envBackup[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function pointAtMock(): void {
  process.env['ZA_LLM_BASE_URL'] = `http://127.0.0.1:${mock.port}/v1`;
  process.env['ZA_LLM_MODEL'] = 'mock-model';
  process.env['ZA_LLM_API_KEY'] = 'za-test-fake-key';
}

async function collect(events: AsyncIterable<LlmStreamEvent>): Promise<LlmStreamEvent[]> {
  const out: LlmStreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function textOf(events: LlmStreamEvent[]): string {
  return events
    .filter((e): e is Extract<LlmStreamEvent, { kind: 'text-delta' }> => e.kind === 'text-delta')
    .map((e) => e.delta)
    .join('');
}

function doneOf(events: LlmStreamEvent[]): Extract<LlmStreamEvent, { kind: 'done' }> {
  const last = events.at(-1);
  if (last?.kind !== 'done') throw new Error(`流未以 done 结束：${JSON.stringify(last)}`);
  return last;
}

const port = () => createLlmPort({ allowedProviders: ['openai-compatible'] });

describe('createLlmPort · openai-compatible 流式', () => {
  it('R1：facts 齐备时流式回取消事实，≥3 个 text-delta，done stopReason=end', async () => {
    pointAtMock();
    const events = await collect(
      port().chat({
        messages: [
          { role: 'system', content: '订单详情 事实：已完成订单不可取消' },
          { role: 'user', content: '这个订单还能取消吗' },
        ],
      }),
    );
    const deltas = events.filter((e) => e.kind === 'text-delta');
    expect(deltas.length).toBeGreaterThanOrEqual(3);
    expect(textOf(events)).toBe('根据本功能事实：已完成订单不可取消（其取消按钮为禁用态）。');
    expect(doneOf(events).stopReason).toBe('end');
  });

  it('R2：订单列表功能块命中时回列表页讲解', async () => {
    pointAtMock();
    const events = await collect(
      port().chat({
        messages: [
          { role: 'system', content: '订单列表 页面锚点 #order-table' },
          { role: 'user', content: '这个页面做什么用' },
        ],
      }),
    );
    expect(textOf(events)).toBe('这是订单列表页：可查看订单、进入详情、取消未发货订单。');
    expect(doneOf(events).stopReason).toBe('end');
  });

  it('R3：基座含通用助手定位时直接应答', async () => {
    pointAtMock();
    const events = await collect(
      port().chat({
        messages: [
          { role: 'system', content: '你是用户浏览器里的通用助手' },
          { role: 'user', content: '今天天气怎么样' },
        ],
      }),
    );
    expect(textOf(events)).toBe('MOCK-GENERAL-QA-HIT：这类通用请求可以直接回答。');
  });

  it('多条 system 消息拼接参与规则匹配', async () => {
    pointAtMock();
    const events = await collect(
      port().chat({
        messages: [
          { role: 'system', content: '订单详情' },
          { role: 'system', content: '事实：已完成订单不可取消' },
          { role: 'user', content: '这个订单还能取消吗' },
        ],
      }),
    );
    expect(textOf(events)).toBe('根据本功能事实：已完成订单不可取消（其取消按钮为禁用态）。');
  });
});

describe('createLlmPort · fail-closed 白名单', () => {
  it('白名单不含 openai-compatible → 只产出 done error，不泄 env 值', async () => {
    pointAtMock();
    const events = await collect(
      createLlmPort({ allowedProviders: [] }).chat({
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    expect(events).toHaveLength(1);
    const done = doneOf(events);
    expect(done.stopReason).toBe('error');
    expect(done.error).toBeTruthy();
    expect(done.error).not.toContain('za-test-fake-key');
  });

  it('请求 model 前缀 provider 越白名单 → done error', async () => {
    pointAtMock();
    const events = await collect(
      port().chat({
        model: 'other-provider/some-model',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    expect(events).toHaveLength(1);
    expect(doneOf(events).stopReason).toBe('error');
  });

  it('ZA_LLM_BASE_URL 未设置 → done error，错误文案只含键名', async () => {
    pointAtMock();
    delete process.env['ZA_LLM_BASE_URL'];
    const events = await collect(port().chat({ messages: [{ role: 'user', content: 'hi' }] }));
    const done = doneOf(events);
    expect(done.stopReason).toBe('error');
    expect(done.error).toContain('ZA_LLM_BASE_URL');
    expect(done.error).not.toContain('za-test-fake-key');
  });
});

describe('createLlmPort · 上游异常', () => {
  it('上游 4xx → done error 且不含响应体回显', async () => {
    pointAtMock();
    process.env['ZA_LLM_BASE_URL'] = `http://127.0.0.1:${mock.port}/v2`;
    const events = await collect(port().chat({ messages: [{ role: 'user', content: 'hi' }] }));
    const done = doneOf(events);
    expect(done.stopReason).toBe('error');
    expect(done.error).toContain('404');
  });

  it('连接被拒 → done error 不抛异常', async () => {
    pointAtMock();
    process.env['ZA_LLM_BASE_URL'] = 'http://127.0.0.1:9/v1';
    const events = await collect(port().chat({ messages: [{ role: 'user', content: 'hi' }] }));
    expect(doneOf(events).stopReason).toBe('error');
    expect(doneOf(events).error).not.toContain('za-test-fake-key');
  });

  it('流未收到 [DONE] 即中断 → done error', async () => {
    const { url, close } = await startSseServer((res) => {
      res.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '半截' }, finish_reason: null }] })}\n\n`,
      );
      setTimeout(() => res.destroy(), 10);
    });
    try {
      pointAtMock();
      process.env['ZA_LLM_BASE_URL'] = url;
      const events = await collect(port().chat({ messages: [{ role: 'user', content: 'hi' }] }));
      expect(textOf(events)).toBe('半截');
      expect(doneOf(events).stopReason).toBe('error');
    } finally {
      await close();
    }
  });
});

describe('createLlmPort · 网络瞬时失败重试', () => {
  const SSE_OK = [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '好' }, finish_reason: null }] })}`,
    'data: [DONE]',
    '',
  ].join('\n\n');

  function retryPort(fetchImpl: typeof fetch) {
    return createLlmPort({ allowedProviders: ['openai-compatible'], fetchImpl, retryDelayMs: 0 });
  }

  it('首次 fetch 抛 TypeError → 重试一次成功，流正常收尾', async () => {
    pointAtMock();
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      return new Response(SSE_OK, { status: 200 });
    };
    const events = await collect(
      retryPort(fetchImpl).chat({ messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(calls).toBe(2);
    expect(textOf(events)).toBe('好');
    expect(doneOf(events).stopReason).toBe('end');
  });

  it('连续两次网络失败 → 只重试一次，done error 如实收尾且不泄敏', async () => {
    pointAtMock();
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      throw new TypeError('fetch failed');
    };
    const events = await collect(
      retryPort(fetchImpl).chat({ messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(calls).toBe(2);
    const done = doneOf(events);
    expect(done.stopReason).toBe('error');
    expect(done.error).toContain('TypeError');
    expect(done.error).not.toContain('za-test-fake-key');
  });

  it('HTTP 错误响应不触发重试（上游业务语义不变）', async () => {
    pointAtMock();
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response('boom', { status: 500 });
    };
    const events = await collect(
      retryPort(fetchImpl).chat({ messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(calls).toBe(1);
    const done = doneOf(events);
    expect(done.stopReason).toBe('error');
    expect(done.error).toContain('500');
  });

  it('按 requestId 取消流式调用，AbortError 不触发网络重试', async () => {
    pointAtMock();
    let calls = 0;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const fetchImpl: typeof fetch = async (_url, init) => {
      calls += 1;
      started();
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    };
    const cancellable = retryPort(fetchImpl);
    const eventsPromise = collect(cancellable.chat({
      requestId: 'cancel-me',
      messages: [{ role: 'user', content: 'hi' }],
    }));
    await startedPromise;
    cancellable.cancel?.('cancel-me');
    const events = await eventsPromise;
    expect(calls).toBe(1);
    expect(doneOf(events)).toMatchObject({ stopReason: 'error', error: '上游请求失败（AbortError）' });
  });
});

describe('createLlmPort · tool_calls 增量聚合', () => {
  it('分片 arguments 聚合为单个 tool-call 事件，done stopReason=tool-call', async () => {
    const chunks = [
      {
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'get_order', arguments: '' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: '{"orderId":' } }] },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: '"o-1"}' } }] },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ];
    const { url, close } = await startSseServer((res) => {
      for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
    try {
      pointAtMock();
      process.env['ZA_LLM_BASE_URL'] = url;
      const events = await collect(port().chat({ messages: [{ role: 'user', content: 'hi' }] }));
      const toolCalls = events.filter(
        (e): e is Extract<LlmStreamEvent, { kind: 'tool-call' }> => e.kind === 'tool-call',
      );
      expect(toolCalls).toEqual([
        { kind: 'tool-call', toolCallId: 'call_1', name: 'get_order', params: { orderId: 'o-1' } },
      ]);
      expect(doneOf(events).stopReason).toBe('tool-call');
    } finally {
      await close();
    }
  });

  it('实参 JSON 截断 → done error 带 errorKind=invalid-tool-args、文案用还原后点分名', async () => {
    const chunks = [
      {
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  // 出网 wire name（__ 分隔）：错误文案须还原成点分 toolId。
                  function: { name: 'codeflow-token__page-operate', arguments: '{"task":"建令牌","st' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: 'length' }] },
    ];
    const { url, close } = await startSseServer((res) => {
      for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
    try {
      pointAtMock();
      process.env['ZA_LLM_BASE_URL'] = url;
      const events = await collect(
        port().chat({
          messages: [{ role: 'user', content: 'hi' }],
          tools: [
            { name: 'codeflow-token.page-operate', description: 'x', params: { type: 'object' } },
          ],
        }),
      );
      const done = doneOf(events);
      expect(done.stopReason).toBe('error');
      expect(done.errorKind).toBe('invalid-tool-args');
      expect(done.error).toContain('codeflow-token.page-operate');
      // 消费侧据此以同 toolCallId 回喂 role:tool 观测自纠，无须伪造用户消息。
      expect(done.invalidToolCall).toEqual({
        toolCallId: 'call_1',
        name: 'codeflow-token.page-operate',
      });
    } finally {
      await close();
    }
  });
});

describe('createLlmPort · 上游 usage 透传', () => {
  it('末帧带 usage（choices 空）→ done 事件透传 inputTokens/outputTokens', async () => {
    const chunks = [
      { choices: [{ index: 0, delta: { content: '好' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 1200, completion_tokens: 34, total_tokens: 1234 } },
    ];
    const { url, close } = await startSseServer((res) => {
      for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
    try {
      pointAtMock();
      process.env['ZA_LLM_BASE_URL'] = url;
      const events = await collect(port().chat({ messages: [{ role: 'user', content: 'hi' }] }));
      const done = doneOf(events);
      expect(done.stopReason).toBe('end');
      expect(done.usage).toEqual({ inputTokens: 1200, outputTokens: 34 });
    } finally {
      await close();
    }
  });

  it('上游无 usage 帧 → done 事件不含 usage 字段（缺省）', async () => {
    const chunks = [
      { choices: [{ index: 0, delta: { content: '好' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ];
    const { url, close } = await startSseServer((res) => {
      for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
    try {
      pointAtMock();
      process.env['ZA_LLM_BASE_URL'] = url;
      const events = await collect(port().chat({ messages: [{ role: 'user', content: 'hi' }] }));
      expect(doneOf(events).usage).toBeUndefined();
    } finally {
      await close();
    }
  });

  it('请求体带 stream_options.include_usage', async () => {
    let seenBody: unknown;
    const fetchImpl: typeof fetch = async (_url, init) => {
      seenBody = JSON.parse(String(init?.body ?? '{}'));
      return new Response(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '好' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
        { status: 200 },
      );
    };
    pointAtMock();
    await collect(
      createLlmPort({ allowedProviders: ['openai-compatible'], fetchImpl }).chat({
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    expect((seenBody as { stream_options?: unknown }).stream_options).toEqual({
      include_usage: true,
    });
  });
});

describe('createLlmPort · 点分 toolId 出网净化', () => {
  const TOOL_CALL_SSE = [
    `data: ${JSON.stringify({
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name: 'codeflow-token__page-operate', arguments: '{"task":"t"}' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })}`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}`,
    'data: [DONE]',
    '',
  ].join('\n\n');

  it('出网 tools 与 tool_calls 回声名点转 __，tool-call 事件还原点分名', async () => {
    pointAtMock();
    let seenBody: unknown;
    const fetchImpl: typeof fetch = async (_url, init) => {
      seenBody = JSON.parse(String(init?.body));
      return new Response(TOOL_CALL_SSE, { status: 200 });
    };
    const events = await collect(
      createLlmPort({ allowedProviders: ['openai-compatible'], fetchImpl }).chat({
        messages: [
          { role: 'user', content: '继续' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'prev_1', name: 'codeflow-token.get-token-key', params: {} }],
          },
          { role: 'tool', content: '{}', toolCallId: 'prev_1' },
        ],
        tools: [
          { name: 'codeflow-token.page-operate', description: 'd', params: { type: 'object' } },
          { name: 'site_navigate', description: 'd', params: { type: 'object' } },
        ],
      }),
    );
    const body = seenBody as {
      tools: Array<{ function: { name: string } }>;
      messages: Array<{ tool_calls?: Array<{ function: { name: string } }> }>;
    };
    expect(body.tools.map((t) => t.function.name)).toEqual([
      'codeflow-token__page-operate',
      'site_navigate',
    ]);
    const echo = body.messages.find((m) => m.tool_calls !== undefined);
    expect(echo?.tool_calls?.[0]?.function.name).toBe('codeflow-token__get-token-key');
    for (const t of body.tools) expect(t.function.name).toMatch(/^[a-zA-Z0-9_-]+$/);
    const toolCall = events.find(
      (e): e is Extract<LlmStreamEvent, { kind: 'tool-call' }> => e.kind === 'tool-call',
    );
    expect(toolCall?.name).toBe('codeflow-token.page-operate');
  });

  it('出网映射冲突 fail-closed（done error，不发请求）', async () => {
    pointAtMock();
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response('', { status: 200 });
    };
    const events = await collect(
      createLlmPort({ allowedProviders: ['openai-compatible'], fetchImpl }).chat({
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
          { name: 'a.b', description: 'd', params: { type: 'object' } },
          { name: 'a__b', description: 'd', params: { type: 'object' } },
        ],
      }),
    );
    expect(calls).toBe(0);
    const done = doneOf(events);
    expect(done.stopReason).toBe('error');
    expect(done.error).toContain('映射冲突');
  });
});

/** 永不结束的 SSE：连接建立后既不吐字节也不关闭，模拟上游挂起（连接半开/限流排队）。 */
function stallingFetch(options: { firstChunk?: string } = {}): typeof fetch {
  return async (_url, init) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          if (options.firstChunk !== undefined) {
            controller.enqueue(new TextEncoder().encode(options.firstChunk));
          }
          init?.signal?.addEventListener(
            'abort',
            () => controller.error(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
}

describe('createLlmPort · 分层超时（未配置即完全不启用）', () => {
  it('env 未设且无 timeouts、无 requestId → 请求 init 不带任何 signal（与基线严格等价）', async () => {
    pointAtMock();
    let seenInit: RequestInit | undefined;
    const fetchImpl: typeof fetch = async (_url, init) => {
      seenInit = init;
      return new Response(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '好' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
        { status: 200 },
      );
    };
    await collect(
      createLlmPort({ allowedProviders: ['openai-compatible'], fetchImpl }).chat({
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    expect(seenInit).toBeDefined();
    expect('signal' in (seenInit as object)).toBe(false);
  });

  it('env 未设 → 上游永不吐字节也不超时收尾（无空闲上限，基线行为）', async () => {
    pointAtMock();
    const events: LlmStreamEvent[] = [];
    const stalled = createLlmPort({
      allowedProviders: ['openai-compatible'],
      fetchImpl: stallingFetch(),
    });
    const drained = (async () => {
      for await (const event of stalled.chat({
        requestId: 'stall-baseline',
        messages: [{ role: 'user', content: 'hi' }],
      })) {
        events.push(event);
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(events).toHaveLength(0);
    // 只有用户取消能收口该流：证明挂起不是被任何超时计时器打断的。
    stalled.cancel('stall-baseline');
    await drained;
    expect(doneOf(events).errorKind).toBeUndefined();
  });

  it('timeouts.firstChunkMs：上游 200 但不吐首字节 → done error errorKind=timeout', async () => {
    pointAtMock();
    const events = await collect(
      createLlmPort({
        allowedProviders: ['openai-compatible'],
        fetchImpl: stallingFetch(),
        timeouts: { firstChunkMs: 60 },
      }).chat({ messages: [{ role: 'user', content: 'hi' }] }),
    );
    const done = doneOf(events);
    expect(done.stopReason).toBe('error');
    expect(done.errorKind).toBe('timeout');
    expect(done.error).not.toContain('za-test-fake-key');
  });

  it('timeouts.idleMs：首字节已到但随后静默 → done error errorKind=timeout', async () => {
    pointAtMock();
    const events = await collect(
      createLlmPort({
        allowedProviders: ['openai-compatible'],
        fetchImpl: stallingFetch({
          firstChunk: `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '半' }, finish_reason: null }] })}\n\n`,
        }),
        timeouts: { idleMs: 60 },
      }).chat({ messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(textOf(events)).toBe('半');
    expect(doneOf(events).errorKind).toBe('timeout');
  });

  it('timeouts.totalMs：整体上限到点即收口', async () => {
    pointAtMock();
    const events = await collect(
      createLlmPort({
        allowedProviders: ['openai-compatible'],
        fetchImpl: stallingFetch(),
        timeouts: { totalMs: 60 },
      }).chat({ messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(doneOf(events).errorKind).toBe('timeout');
  });

  it('env ZA_LLM_IDLE_MS 生效（options 缺省时按 env 启用）', async () => {
    pointAtMock();
    process.env['ZA_LLM_IDLE_MS'] = '60';
    const events = await collect(
      createLlmPort({
        allowedProviders: ['openai-compatible'],
        fetchImpl: stallingFetch(),
      }).chat({ messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(doneOf(events).errorKind).toBe('timeout');
  });

  it('env 值非正整数 → 视为未设置（不启用，不改变基线）', async () => {
    pointAtMock();
    process.env['ZA_LLM_IDLE_MS'] = '0';
    let seenInit: RequestInit | undefined;
    const fetchImpl: typeof fetch = async (_url, init) => {
      seenInit = init;
      return new Response(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '好' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
        { status: 200 },
      );
    };
    await collect(
      createLlmPort({ allowedProviders: ['openai-compatible'], fetchImpl }).chat({
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    expect('signal' in (seenInit as object)).toBe(false);
  });

  it('用户取消与超时并存时如实区分：取消收口不标 timeout', async () => {
    pointAtMock();
    const cancellable = createLlmPort({
      allowedProviders: ['openai-compatible'],
      fetchImpl: stallingFetch(),
      timeouts: { idleMs: 5_000 },
    });
    const eventsPromise = collect(
      cancellable.chat({ requestId: 'cancel-not-timeout', messages: [{ role: 'user', content: 'hi' }] }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    cancellable.cancel('cancel-not-timeout');
    const done = doneOf(await eventsPromise);
    expect(done.stopReason).toBe('error');
    expect(done.errorKind).toBeUndefined();
  });
});

describe('createLlmPort · 上游错误分类（errorKind 闭集）', () => {
  function statusPort(status: number, body: string) {
    return createLlmPort({
      allowedProviders: ['openai-compatible'],
      fetchImpl: async () => new Response(body, { status }),
    });
  }

  it('401 → auth，文案只含状态类别与键名，不回显 body 与凭证形态', async () => {
    pointAtMock();
    const events = await collect(
      statusPort(401, JSON.stringify({ error: { message: 'Incorrect API key provided: sk-live-abcdefghijklmnop' } })).chat(
        { messages: [{ role: 'user', content: 'hi' }] },
      ),
    );
    const done = doneOf(events);
    expect(done.errorKind).toBe('auth');
    expect(done.error).toContain('ZA_LLM_API_KEY');
    expect(done.error).not.toContain('sk-live-abcdefghijklmnop');
    expect(done.error).not.toContain('Bearer');
    expect(done.error).not.toContain('Incorrect API key');
  });

  it('403 → auth', async () => {
    pointAtMock();
    const done = doneOf(
      await collect(statusPort(403, 'forbidden').chat({ messages: [{ role: 'user', content: 'hi' }] })),
    );
    expect(done.errorKind).toBe('auth');
  });

  it('429 普通限流 → rate-limit；429 配额耗尽 → quota', async () => {
    pointAtMock();
    const rateLimited = doneOf(
      await collect(
        statusPort(429, JSON.stringify({ error: { code: 'rate_limit_exceeded' } })).chat({
          messages: [{ role: 'user', content: 'hi' }],
        }),
      ),
    );
    expect(rateLimited.errorKind).toBe('rate-limit');
    const quota = doneOf(
      await collect(
        statusPort(429, JSON.stringify({ error: { code: 'insufficient_quota' } })).chat({
          messages: [{ role: 'user', content: 'hi' }],
        }),
      ),
    );
    expect(quota.errorKind).toBe('quota');
    expect(quota.error).not.toContain('insufficient_quota');
  });

  it('400 且 body 命中上下文超长措辞 → context-overflow', async () => {
    pointAtMock();
    const done = doneOf(
      await collect(
        statusPort(
          400,
          JSON.stringify({ error: { message: "This model's maximum context length is 128000 tokens" } }),
        ).chat({ messages: [{ role: 'user', content: 'hi' }] }),
      ),
    );
    expect(done.errorKind).toBe('context-overflow');
    expect(done.error).not.toContain('128000');
  });

  it('400 非上下文原因 → 不误判为 context-overflow', async () => {
    pointAtMock();
    const done = doneOf(
      await collect(
        statusPort(400, JSON.stringify({ error: { message: 'unknown field foo' } })).chat({
          messages: [{ role: 'user', content: 'hi' }],
        }),
      ),
    );
    expect(done.errorKind).not.toBe('context-overflow');
    expect(done.error).toContain('400');
  });

  it('404 → endpoint-invalid，文案指向 ZA_LLM_BASE_URL', async () => {
    pointAtMock();
    const done = doneOf(
      await collect(statusPort(404, 'not found').chat({ messages: [{ role: 'user', content: 'hi' }] })),
    );
    expect(done.errorKind).toBe('endpoint-invalid');
    expect(done.error).toContain('ZA_LLM_BASE_URL');
  });

  it('fetch 连接类失败 → transport；URL 不可解析 → endpoint-invalid', async () => {
    pointAtMock();
    const transport = doneOf(
      await collect(
        createLlmPort({
          allowedProviders: ['openai-compatible'],
          retryDelayMs: 0,
          fetchImpl: async () => {
            throw new TypeError('fetch failed');
          },
        }).chat({ messages: [{ role: 'user', content: 'hi' }] }),
      ),
    );
    expect(transport.errorKind).toBe('transport');
    const invalidUrl = doneOf(
      await collect(
        createLlmPort({
          allowedProviders: ['openai-compatible'],
          retryDelayMs: 0,
          fetchImpl: async () => {
            throw new TypeError('Failed to parse URL from not-a-url/chat/completions');
          },
        }).chat({ messages: [{ role: 'user', content: 'hi' }] }),
      ),
    );
    expect(invalidUrl.errorKind).toBe('endpoint-invalid');
  });

  it('流未收到 [DONE] 即断 → stream-interrupted', async () => {
    const { url, close } = await startSseServer((res) => {
      res.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '半截' }, finish_reason: null }] })}\n\n`,
      );
      setTimeout(() => res.destroy(), 10);
    });
    try {
      pointAtMock();
      process.env['ZA_LLM_BASE_URL'] = url;
      const done = doneOf(await collect(port().chat({ messages: [{ role: 'user', content: 'hi' }] })));
      expect(done.errorKind).toBe('stream-interrupted');
    } finally {
      await close();
    }
  });

  it('finish_reason=length 且无工具调用 → done stopReason=end 带 truncated', async () => {
    pointAtMock();
    const events = await collect(
      createLlmPort({
        allowedProviders: ['openai-compatible'],
        fetchImpl: async () =>
          new Response(
            [
              `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '半句话' }, finish_reason: null }] })}`,
              `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] })}`,
              'data: [DONE]',
              '',
            ].join('\n\n'),
            { status: 200 },
          ),
      }).chat({ messages: [{ role: 'user', content: 'hi' }] }),
    );
    const done = doneOf(events);
    expect(done.stopReason).toBe('end');
    expect(done.truncated).toBe(true);
  });

  it('正常收尾不带 truncated', async () => {
    pointAtMock();
    const events = await collect(
      createLlmPort({
        allowedProviders: ['openai-compatible'],
        fetchImpl: async () =>
          new Response(
            [
              `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '整句' }, finish_reason: 'stop' }] })}`,
              'data: [DONE]',
              '',
            ].join('\n\n'),
            { status: 200 },
          ),
      }).chat({ messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(doneOf(events).truncated).toBeUndefined();
  });
});

describe('createLlmPort · 并行工具调用策略', () => {
  async function bodyOf(
    options: { declareParallelToolCalls?: boolean } = {},
    tools?: { name: string; description: string; params: JsonObject }[],
  ): Promise<Record<string, unknown>> {
    let seenBody: Record<string, unknown> = {};
    const fetchImpl: typeof fetch = async (_url, init) => {
      seenBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '好' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
        { status: 200 },
      );
    };
    await collect(
      createLlmPort({ allowedProviders: ['openai-compatible'], fetchImpl, ...options }).chat({
        messages: [{ role: 'user', content: 'hi' }],
        ...(tools !== undefined ? { tools } : {}),
      }),
    );
    return seenBody;
  }

  const TOOLS = [{ name: 'a_b', description: 'd', params: { type: 'object' } }];

  it('有 tools 时请求体声明 parallel_tool_calls:false（串行治理与 HITL 语义一致）', async () => {
    pointAtMock();
    expect((await bodyOf({}, TOOLS))['parallel_tool_calls']).toBe(false);
  });

  it('无 tools 时不声明该字段（上游对无工具请求拒绝该字段）', async () => {
    pointAtMock();
    expect('parallel_tool_calls' in (await bodyOf({}))).toBe(false);
  });

  it('declareParallelToolCalls:false → 不声明该字段（兼容不支持该字段的上游）', async () => {
    pointAtMock();
    expect('parallel_tool_calls' in (await bodyOf({ declareParallelToolCalls: false }, TOOLS))).toBe(
      false,
    );
  });

  it('上游仍返回多个 index 的 tool_calls → 逐个产出 tool-call 事件，不丢弃', async () => {
    pointAtMock();
    const events = await collect(
      createLlmPort({
        allowedProviders: ['openai-compatible'],
        fetchImpl: async () =>
          new Response(
            [
              `data: ${JSON.stringify({
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: 'assistant',
                      tool_calls: [
                        { index: 0, id: 'call_a', type: 'function', function: { name: 'a_b', arguments: '{}' } },
                        { index: 1, id: 'call_b', type: 'function', function: { name: 'a_b', arguments: '{"k":1}' } },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              })}`,
              `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}`,
              'data: [DONE]',
              '',
            ].join('\n\n'),
            { status: 200 },
          ),
      }).chat({ messages: [{ role: 'user', content: 'hi' }], tools: TOOLS }),
    );
    expect(
      events
        .filter((e): e is Extract<LlmStreamEvent, { kind: 'tool-call' }> => e.kind === 'tool-call')
        .map((e) => e.toolCallId),
    ).toEqual(['call_a', 'call_b']);
  });
});

async function startSseServer(
  write: (res: import('node:http').ServerResponse) => void,
): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    write(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('无法获取监听端口');
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
