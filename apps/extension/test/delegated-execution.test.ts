import { describe, expect, it } from 'vitest';
import type { ExecInstructionFrame } from '../src/frames.js';
import { createDelegatedExecutor } from '../src/delegated-execution.js';

interface Capture {
  url: unknown;
  init: RequestInit | undefined;
}

function fakeResponse(ok: boolean, status: number, json: () => Promise<unknown>): Response {
  return { ok, status, json } as unknown as Response;
}

function instruction(
  request: ExecInstructionFrame['request'],
): ExecInstructionFrame {
  return {
    type: 'exec-instruction',
    sessionId: 's1',
    nonce: 'n1',
    ttl: 60000,
    signature: 'sig-not-verified-client-side',
    toolCallId: 'tc1',
    request,
  };
}

describe('delegated-execution 页面环境代执行', () => {
  it('成功：以用户会话 fetch，解析 JSON body，回传 ok/status/body（无 error）', async () => {
    const capture: Capture = { url: undefined, init: undefined };
    const fetchImpl = ((url: unknown, init?: RequestInit) => {
      capture.url = url;
      capture.init = init;
      return Promise.resolve(fakeResponse(true, 200, () => Promise.resolve({ ok: true, orderId: 'ORD-1001' })));
    }) as unknown as typeof fetch;
    const exec = createDelegatedExecutor(fetchImpl);

    const result = await exec.execute(
      instruction({
        method: 'POST',
        url: 'http://host.example/api/orders/ORD-1001/cancel',
        headers: { 'content-type': 'application/json' },
        body: {},
      }),
    );

    expect(result).toEqual({
      type: 'exec-result',
      sessionId: 's1',
      nonce: 'n1',
      ok: true,
      status: 200,
      body: { ok: true, orderId: 'ORD-1001' },
    });
    expect(capture.url).toBe('http://host.example/api/orders/ORD-1001/cancel');
    expect(capture.init?.method).toBe('POST');
    expect(capture.init?.credentials).toBe('include');
    expect(capture.init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(capture.init?.body).toBe('{}');
  });

  it('GET 无 body：init 不带 body', async () => {
    const capture: Capture = { url: undefined, init: undefined };
    const fetchImpl = ((url: unknown, init?: RequestInit) => {
      capture.url = url;
      capture.init = init;
      return Promise.resolve(fakeResponse(true, 200, () => Promise.resolve({ ok: true, count: 2 })));
    }) as unknown as typeof fetch;
    const exec = createDelegatedExecutor(fetchImpl);

    const result = await exec.execute(instruction({ method: 'GET', url: 'http://host.example/api/orders' }));

    expect(result.ok).toBe(true);
    expect(result.body).toEqual({ ok: true, count: 2 });
    expect(capture.init?.method).toBe('GET');
    expect(capture.init?.body).toBeUndefined();
  });

  it('HTTP 错：ok:false + status + error 状态串，仍解析 body', async () => {
    const fetchImpl = (() =>
      Promise.resolve(fakeResponse(false, 500, () => Promise.resolve({ error: 'boom' })))) as unknown as typeof fetch;
    const exec = createDelegatedExecutor(fetchImpl);

    const result = await exec.execute(
      instruction({ method: 'POST', url: 'http://host.example/api/orders/ORD-1/cancel', body: {} }),
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    expect(result.error).toBe('HTTP 500');
    expect(result.body).toEqual({ error: 'boom' });
  });

  it('HTTP 错且 body 非 JSON：省略 body，保留 status 与 error', async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        fakeResponse(false, 502, () => Promise.reject(new Error('not json'))),
      )) as unknown as typeof fetch;
    const exec = createDelegatedExecutor(fetchImpl);

    const result = await exec.execute(
      instruction({ method: 'GET', url: 'http://host.example/api/orders' }),
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe(502);
    expect(result.error).toBe('HTTP 502');
    expect(result.body).toBeUndefined();
  });

  it('网络错：fetch 抛出 → ok:false、无 status/body、error 为可定位文案', async () => {
    const fetchImpl = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
    const exec = createDelegatedExecutor(fetchImpl);

    const result = await exec.execute(
      instruction({ method: 'POST', url: 'http://host.example/api/orders/ORD-1/cancel', body: {} }),
    );

    expect(result.type).toBe('exec-result');
    expect(result.sessionId).toBe('s1');
    expect(result.nonce).toBe('n1');
    expect(result.ok).toBe(false);
    expect(result.status).toBeUndefined();
    expect(result.body).toBeUndefined();
    expect(typeof result.error).toBe('string');
    expect(result.error).not.toBe('');
    expect(result.error).not.toContain('sig-not-verified-client-side');
  });
});
