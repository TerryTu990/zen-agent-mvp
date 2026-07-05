import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { LlmStreamEvent } from '@zen-agent/contracts';
import { createLlmPort } from '../src/index.js';
import { startMockLlmProcess, type MockLlmHandle } from './helpers/mock-llm.js';

let mock: MockLlmHandle;
const envBackup: Record<string, string | undefined> = {};
const ENV_KEYS = ['ZA_LLM_BASE_URL', 'ZA_LLM_API_KEY', 'ZA_LLM_MODEL'] as const;

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

  it('R3：基座含拒答时回职责范围拒绝', async () => {
    pointAtMock();
    const events = await collect(
      port().chat({
        messages: [
          { role: 'system', content: '与系统无关的问题一律拒答' },
          { role: 'user', content: '今天天气怎么样' },
        ],
      }),
    );
    expect(textOf(events)).toBe(
      '这超出了我的职责范围：我只辅助你使用当前系统，无法回答与系统无关的问题。',
    );
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
