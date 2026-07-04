import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../src/index.js';

const repoRoot = new URL('../../../', import.meta.url).pathname;
const snapshotRoot = join(repoRoot, 'examples/host-demo/config');
const systemPromptPath = join(repoRoot, 'assets/system-prompt.md');

const JWT_SECRET = 'za-test-secret';
const ISS = 'zen-agent-demo';
const key = new TextEncoder().encode(JWT_SECRET);

const REPLY_R1 = '根据本功能事实：已完成订单不可取消（其取消按钮为禁用态）。';
const REPLY_R2_LIST = '这是订单列表页：可查看订单、进入详情、取消未发货订单。';
const REPLY_R3 = '这超出了我的职责范围：我只辅助你使用当前系统，无法回答与系统无关的问题。';

interface MockLlmHandle {
  port: number;
  close(): Promise<void>;
}

let mock: MockLlmHandle;
let server: RunningServer;
let baseUrl = '';

function serverOptions(overrides: Partial<Parameters<typeof startServer>[0]> = {}) {
  return {
    port: 0,
    jwtSecret: JWT_SECRET,
    issAllowlist: [ISS],
    snapshotRoot,
    systemPromptPath,
    auditSinkPath: join(repoRoot, '.za/events.jsonl'),
    allowedProviders: ['openai-compatible'],
    heartbeatMs: 60_000,
    ...overrides,
  };
}

beforeAll(async () => {
  const mockLlmUrl = pathToFileURL(join(repoRoot, 'scripts/mock-llm/server.mjs')).href;
  const mockModule = (await import(mockLlmUrl)) as {
    startMockLlm(options?: { port?: number }): Promise<MockLlmHandle>;
  };
  mock = await mockModule.startMockLlm({ port: 0 });
  process.env['ZA_LLM_BASE_URL'] = `http://127.0.0.1:${mock.port}/v1`;
  process.env['ZA_LLM_MODEL'] = 'mock-model';
  server = await startServer(serverOptions());
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server?.close();
  await mock?.close();
});

interface SignOptions {
  iss?: string;
  exp?: number;
  secret?: Uint8Array;
  claims?: Record<string, unknown>;
}

async function signToken(options: SignOptions = {}): Promise<string> {
  const claims = options.claims ?? { tenant: 'demo-tenant', roles: ['ops'], hostUserId: 'host-u1' };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('user-1')
    .setIssuer(options.iss ?? ISS)
    .setExpirationTime(options.exp ?? Math.floor(Date.now() / 1000) + 300)
    .sign(options.secret ?? key);
}

function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, init);
}

function authHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...extra };
}

async function createSession(token: string): Promise<string> {
  const res = await api('/v1/sessions', { method: 'POST', headers: authHeaders(token) });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { sessionId: string };
  expect(body.sessionId).toBeTruthy();
  return body.sessionId;
}

function postFrame(token: string, sessionId: string, frame: unknown): Promise<Response> {
  return api(`/v1/sessions/${encodeURIComponent(sessionId)}/frames`, {
    method: 'POST',
    headers: authHeaders(token, { 'content-type': 'application/json' }),
    body: typeof frame === 'string' ? frame : JSON.stringify(frame),
  });
}

async function getInjection(token: string, sessionId: string): Promise<Record<string, unknown>> {
  const res = await api(`/v1/sessions/${encodeURIComponent(sessionId)}/injection`, {
    headers: authHeaders(token),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

interface SseHandle {
  frames: Array<Record<string, unknown>>;
  raw(): string;
  waitFor(predicate: () => boolean, timeoutMs?: number): Promise<void>;
  close(): void;
}

async function openSse(token: string, sessionId: string): Promise<SseHandle> {
  const controller = new AbortController();
  const response = await api(`/v1/sessions/${encodeURIComponent(sessionId)}/events`, {
    headers: authHeaders(token),
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const frames: Array<Record<string, unknown>> = [];
  let rawText = '';
  void (async () => {
    if (!response.body) return;
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of response.body) {
        const text = decoder.decode(chunk as Uint8Array, { stream: true });
        buffer += text;
        rawText += text;
        let index: number;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          for (const line of block.split('\n')) {
            if (line.startsWith('data: ')) {
              frames.push(JSON.parse(line.slice('data: '.length)) as Record<string, unknown>);
            }
          }
        }
      }
    } catch {
      // abort 断开属正常收尾
    }
  })();
  return {
    frames,
    raw: () => rawText,
    async waitFor(predicate, timeoutMs = 8000) {
      const deadline = Date.now() + timeoutMs;
      while (!predicate()) {
        if (Date.now() > deadline) {
          throw new Error(`SSE 等待超时；已收帧：${JSON.stringify(frames)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
    close: () => controller.abort(),
  };
}

function textOf(frames: Array<Record<string, unknown>>, from = 0): string {
  return frames
    .slice(from)
    .filter((frame) => frame['type'] === 'text-delta')
    .map((frame) => String(frame['delta']))
    .join('');
}

describe('鉴权 fail-closed（401 闭集）', () => {
  it('无 Authorization → 401', async () => {
    const res = await api('/v1/sessions', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('坏签名（其它 secret 签发）→ 401', async () => {
    const token = await signToken({ secret: new TextEncoder().encode('other-secret') });
    const res = await api('/v1/sessions', { method: 'POST', headers: authHeaders(token) });
    expect(res.status).toBe(401);
  });

  it('iss 不在白名单 → 401', async () => {
    const token = await signToken({ iss: 'rogue-issuer' });
    const res = await api('/v1/sessions', { method: 'POST', headers: authHeaders(token) });
    expect(res.status).toBe(401);
  });

  it('exp 已过期 → 401', async () => {
    const token = await signToken({ exp: Math.floor(Date.now() / 1000) - 60 });
    const res = await api('/v1/sessions', { method: 'POST', headers: authHeaders(token) });
    expect(res.status).toBe(401);
  });

  it('claims 缺必填字段（无 tenant）→ 401', async () => {
    const token = await signToken({ claims: { roles: [], hostUserId: 'host-u1' } });
    const res = await api('/v1/sessions', { method: 'POST', headers: authHeaders(token) });
    expect(res.status).toBe(401);
  });

  it('401 响应不回显 token 原文（SEC-04）', async () => {
    const token = await signToken({ iss: 'rogue-issuer' });
    const res = await api('/v1/sessions', { method: 'POST', headers: authHeaders(token) });
    const body = await res.text();
    expect(body).not.toContain(token);
    expect(body).not.toContain(JWT_SECRET);
  });
});

describe('上行帧校验（400/404/501 闭集）', () => {
  it('请求体不是 JSON → 400', async () => {
    const token = await signToken();
    const sessionId = await createSession(token);
    const res = await postFrame(token, sessionId, '{not-json');
    expect(res.status).toBe(400);
  });

  it('schema 不过（user-message 缺 text）→ 400', async () => {
    const token = await signToken();
    const sessionId = await createSession(token);
    const res = await postFrame(token, sessionId, { type: 'user-message', sessionId });
    expect(res.status).toBe(400);
  });

  it('下行帧类型不被上行接受 → 400', async () => {
    const token = await signToken();
    const sessionId = await createSession(token);
    const res = await postFrame(token, sessionId, { type: 'text-delta', sessionId, delta: 'x' });
    expect(res.status).toBe(400);
  });

  it('帧 sessionId 与路径不一致 → 400', async () => {
    const token = await signToken();
    const sessionId = await createSession(token);
    const res = await postFrame(token, sessionId, {
      type: 'user-message',
      sessionId: 'someone-else',
      text: '你好',
    });
    expect(res.status).toBe(400);
  });

  it('未知会话 → 404', async () => {
    const token = await signToken();
    const res = await postFrame(token, 'no-such-session', {
      type: 'user-message',
      sessionId: 'no-such-session',
      text: '你好',
    });
    expect(res.status).toBe(404);
  });

  it('hitl-decision / exec-result 合法帧 → 501（锚点 M3）', async () => {
    const token = await signToken();
    const sessionId = await createSession(token);
    const hitl = await postFrame(token, sessionId, {
      type: 'hitl-decision',
      sessionId,
      hitlId: 'h1',
      decision: 'approve',
    });
    expect(hitl.status).toBe(501);
    const exec = await postFrame(token, sessionId, {
      type: 'exec-result',
      sessionId,
      nonce: 'n1',
      ok: true,
    });
    expect(exec.status).toBe(501);
  });
});

describe('讲解闭环全链路（真 assembly + mock LLM）', () => {
  it('context-report + user-message → SSE 收到 R1 事实回答（流式 ≥2 帧）', async () => {
    const token = await signToken();
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    try {
      const report = await postFrame(token, sessionId, {
        type: 'context-report',
        sessionId,
        url: 'http://127.0.0.1:4173/order-list.html',
        title: '订单列表',
      });
      expect(report.status).toBe(204);
      const message = await postFrame(token, sessionId, {
        type: 'user-message',
        sessionId,
        text: '已完成的订单还能取消吗？',
      });
      expect(message.status).toBe(202);
      await sse.waitFor(() => textOf(sse.frames) === REPLY_R1);
      const deltaFrames = sse.frames.filter((frame) => frame['type'] === 'text-delta');
      expect(deltaFrames.length).toBeGreaterThanOrEqual(2);
      for (const frame of deltaFrames) {
        expect(frame['sessionId']).toBe(sessionId);
      }
    } finally {
      sse.close();
    }
  });

  it('多轮：第二轮携带历史仍按当前注入回答（R2 列表）', async () => {
    const token = await signToken();
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    try {
      await postFrame(token, sessionId, {
        type: 'context-report',
        sessionId,
        url: 'http://127.0.0.1:4173/order-list.html',
      });
      await postFrame(token, sessionId, { type: 'user-message', sessionId, text: '订单能取消吗' });
      await sse.waitFor(() => textOf(sse.frames) === REPLY_R1);
      const secondTurnFrom = sse.frames.length;
      await postFrame(token, sessionId, {
        type: 'user-message',
        sessionId,
        text: '这个页面显示的是什么？',
      });
      await sse.waitFor(() => textOf(sse.frames, secondTurnFrom) === REPLY_R2_LIST);
    } finally {
      sse.close();
    }
  });

  it('context-report 换 url 后 /injection 的 featureId 与 blocks 随之变化', async () => {
    const token = await signToken();
    const sessionId = await createSession(token);
    await postFrame(token, sessionId, {
      type: 'context-report',
      sessionId,
      url: 'http://127.0.0.1:4173/order-list.html',
    });
    const listInjection = await getInjection(token, sessionId);
    expect(listInjection['featureId']).toBe('order-list');
    const listKinds = (listInjection['blocks'] as Array<{ kind: string }>).map((b) => b.kind);
    expect(listKinds).toContain('system-prompt');
    expect(listKinds).toContain('feature-rules');
    expect(listKinds).toContain('facts');
    expect(listInjection['toolIds']).toEqual(['order-list.cancel-order']);

    await postFrame(token, sessionId, {
      type: 'context-report',
      sessionId,
      url: 'http://127.0.0.1:4173/order-detail.html?orderId=ORD-1001',
    });
    const detailInjection = await getInjection(token, sessionId);
    expect(detailInjection['featureId']).toBe('order-detail');
    expect(detailInjection['toolIds']).toEqual([]);
  });

  it('未登记 URL → featureId=null 仅基座（fail-safe），无关请求仍被基座拒答', async () => {
    const token = await signToken();
    const sessionId = await createSession(token);
    await postFrame(token, sessionId, {
      type: 'context-report',
      sessionId,
      url: 'http://127.0.0.1:4173/unknown.html',
    });
    const injection = await getInjection(token, sessionId);
    expect(injection['featureId']).toBeNull();
    expect(injection['blocks']).toEqual([
      { kind: 'system-prompt', bytes: expect.any(Number) as number },
    ]);
    expect(injection['toolIds']).toEqual([]);

    const sse = await openSse(token, sessionId);
    try {
      await postFrame(token, sessionId, {
        type: 'user-message',
        sessionId,
        text: '今天天气怎么样？',
      });
      await sse.waitFor(() => textOf(sse.frames) === REPLY_R3);
    } finally {
      sse.close();
    }
  });

  it('LLM 不可达 → 下行"服务暂时不可用"且不含敏感值（SEC-04）', async () => {
    const token = await signToken();
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    const savedBaseUrl = process.env['ZA_LLM_BASE_URL'];
    try {
      process.env['ZA_LLM_BASE_URL'] = 'http://127.0.0.1:1/v1';
      await postFrame(token, sessionId, {
        type: 'user-message',
        sessionId,
        text: '订单能取消吗',
      });
      await sse.waitFor(() => textOf(sse.frames).includes('服务暂时不可用'));
      const text = textOf(sse.frames);
      expect(text).not.toContain(JWT_SECRET);
      expect(text).not.toContain(token);
    } finally {
      process.env['ZA_LLM_BASE_URL'] = savedBaseUrl;
      sse.close();
    }
  });
});

describe('SSE 心跳与 CORS', () => {
  it('OPTIONS 预检 → 204 + 宽松 CORS 头', async () => {
    const res = await api('/v1/sessions', { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-headers')).toContain('authorization');
  });

  it('业务响应也带 Access-Control-Allow-Origin: *', async () => {
    const token = await signToken();
    const res = await api('/v1/sessions', { method: 'POST', headers: authHeaders(token) });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('心跳为 ": ping" 注释行，按配置间隔重复下发', async () => {
    const fast = await startServer(serverOptions({ heartbeatMs: 40 }));
    const fastBase = `http://127.0.0.1:${fast.port}`;
    try {
      const token = await signToken();
      const created = await fetch(`${fastBase}/v1/sessions`, {
        method: 'POST',
        headers: authHeaders(token),
      });
      const { sessionId } = (await created.json()) as { sessionId: string };
      const controller = new AbortController();
      const response = await fetch(
        `${fastBase}/v1/sessions/${encodeURIComponent(sessionId)}/events`,
        { headers: authHeaders(token), signal: controller.signal },
      );
      expect(response.status).toBe(200);
      let raw = '';
      const reading = (async () => {
        if (!response.body) return;
        const decoder = new TextDecoder();
        try {
          for await (const chunk of response.body) {
            raw += decoder.decode(chunk as Uint8Array, { stream: true });
          }
        } catch {
          // abort 断开属正常收尾
        }
      })();
      await new Promise((resolve) => setTimeout(resolve, 200));
      controller.abort();
      await reading;
      const pings = raw.split('\n').filter((line) => line === ': ping').length;
      expect(pings).toBeGreaterThanOrEqual(2);
    } finally {
      await fast.close();
    }
  });
});

describe('启动 fail-closed', () => {
  it('jwtSecret 缺失 → 拒绝启动', async () => {
    await expect(startServer(serverOptions({ jwtSecret: '' }))).rejects.toThrow(/ZA_JWT_SECRET/);
  });

  it('坏快照根 → 启动即 fail-fast', async () => {
    await expect(
      startServer(serverOptions({ snapshotRoot: join(repoRoot, 'examples/no-such-config') })),
    ).rejects.toThrow(/快照拒载/);
  });
});
