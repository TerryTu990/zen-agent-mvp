import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMockLlmProcess, type MockLlmHandle } from './helpers/mock-llm.js';

let mock: MockLlmHandle;

beforeAll(async () => {
  mock = await startMockLlmProcess();
});

afterAll(async () => {
  await mock.close();
});

interface SseCapture {
  status: number;
  contentType: string | null;
  payloads: string[];
}

async function postChat(body: unknown): Promise<SseCapture> {
  const res = await fetch(`http://127.0.0.1:${mock.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  const payloads = text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim());
  return { status: res.status, contentType: res.headers.get('content-type'), payloads };
}

function contentOf(payloads: string[]): string[] {
  return payloads
    .filter((p) => p !== '[DONE]')
    .map((p) => JSON.parse(p).choices[0].delta.content)
    .filter((c: unknown): c is string => typeof c === 'string' && c.length > 0);
}

function streamBody(system: string, user: string) {
  return {
    model: 'mock-model',
    stream: true,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
}

describe('mock LLM 确定性规则', () => {
  it('R1 命中：facts 同含"已完成"与"不可取消"时回取消事实', async () => {
    const { status, contentType, payloads } = await postChat(
      streamBody('订单详情 事实：已完成订单不可取消', '这个订单还能取消吗'),
    );
    expect(status).toBe(200);
    expect(contentType).toContain('text/event-stream');
    const parts = contentOf(payloads);
    expect(parts.length).toBeGreaterThanOrEqual(3);
    expect(parts.join('')).toBe('根据本功能事实：已完成订单不可取消（其取消按钮为禁用态）。');
    expect(payloads.at(-1)).toBe('[DONE]');
  });

  it('R1 缺 facts：回 MOCK-MISSING-FACTS', async () => {
    const { payloads } = await postChat(streamBody('订单详情', '这个订单还能取消吗'));
    expect(contentOf(payloads).join('')).toBe('MOCK-MISSING-FACTS');
  });

  it('R2 订单详情：sys 含"订单详情"+"#order-id"时回详情页讲解', async () => {
    const { payloads } = await postChat(
      streamBody('订单详情 页面锚点 #order-id', '这个页面显示的是什么'),
    );
    expect(contentOf(payloads).join('')).toBe(
      '这是订单详情页：展示订单号、状态与金额，可通过返回链接回到订单列表。',
    );
  });

  it('R2 订单列表：sys 含"订单列表"+"#order-table"时回列表页讲解', async () => {
    const { payloads } = await postChat(
      streamBody('订单列表 页面锚点 #order-table', '这个页面做什么用'),
    );
    expect(contentOf(payloads).join('')).toBe('这是订单列表页：可查看订单、进入详情、取消未发货订单。');
  });

  it('R2 无功能块：回 MOCK-NO-FEATURE', async () => {
    const { payloads } = await postChat(streamBody('稳定基座', '这个页面显示的是什么'));
    expect(contentOf(payloads).join('')).toBe('MOCK-NO-FEATURE');
  });

  it('R3 拒答：sys 含"拒答"时回职责范围拒绝', async () => {
    const { payloads } = await postChat(streamBody('与系统无关的问题一律拒答', '今天天气怎么样'));
    expect(contentOf(payloads).join('')).toBe(
      '这超出了我的职责范围：我只辅助你使用当前系统，无法回答与系统无关的问题。',
    );
  });

  it('R3 写诗同样命中；基座缺失回 MOCK-BASE-MISSING', async () => {
    const { payloads } = await postChat(streamBody('空基座', '帮我写一首诗'));
    expect(contentOf(payloads).join('')).toBe('MOCK-BASE-MISSING');
  });

  it('R4 兜底：回 MOCK-DEFAULT', async () => {
    const { payloads } = await postChat(streamBody('订单列表 #order-table', '随便聊聊'));
    expect(contentOf(payloads).join('')).toBe('MOCK-DEFAULT');
  });

  it('非流式请求 → 400', async () => {
    const { status } = await postChat({
      model: 'mock-model',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(status).toBe(400);
  });

  it('非法 body → 400；未知路径 → 404', async () => {
    const { status } = await postChat('not-json');
    expect(status).toBe(400);
    const res = await fetch(`http://127.0.0.1:${mock.port}/v1/other`, { method: 'POST' });
    expect(res.status).toBe(404);
  });
});
