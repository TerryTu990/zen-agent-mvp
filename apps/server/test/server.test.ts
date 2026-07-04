import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../src/index.js';

const repoRoot = new URL('../../../', import.meta.url).pathname;
const snapshotRoot = join(repoRoot, 'examples/host-demo/config');
const systemPromptPath = join(repoRoot, 'assets/system-prompt.md');

const JWT_SECRET = 'za-test-secret';
const SIGNING_SECRET = 'za-test-signing-secret';
const ISS = 'zen-agent-demo';
const key = new TextEncoder().encode(JWT_SECRET);

const REPLY_R1 = '根据本功能事实：已完成订单不可取消（其取消按钮为禁用态）。';
const REPLY_R2_LIST = '这是订单列表页：可查看订单、进入详情、取消未发货订单。';
const REPLY_R3 = '这超出了我的职责范围：我只辅助你使用当前系统，无法回答与系统无关的问题。';
const REPLY_NO_ANCHOR = 'MOCK-NO-ANCHOR';

const ORDER_LIST_URL = 'http://127.0.0.1:4173/order-list.html';
const UNKNOWN_URL = 'http://127.0.0.1:4173/unknown.html';

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
    signingSecret: SIGNING_SECRET,
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

describe('上行帧校验（400/404/409 闭集）', () => {
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

  it('无挂起回合的 hitl-decision / exec-result → 409（失效/伪造 nonce，不入 toolgate）', async () => {
    const token = await signToken();
    const sessionId = await createSession(token);
    const hitl = await postFrame(token, sessionId, {
      type: 'hitl-decision',
      sessionId,
      hitlId: 'h1',
      decision: 'approve',
    });
    expect(hitl.status).toBe(409);
    const exec = await postFrame(token, sessionId, {
      type: 'exec-result',
      sessionId,
      nonce: 'n1',
      ok: true,
    });
    expect(exec.status).toBe(409);
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
    expect(listInjection['toolIds']).toEqual([
      'order-list.cancel-order',
      'order-list.refresh-orders',
      'order-list.purge-orders',
    ]);

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

function guideFrames(frames: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return frames.filter((frame) => frame['type'] === 'guide-action');
}

describe('引导闭环（guide-action 下发 + built-in 工具注入门）', () => {
  it('order-list 问定位且 facts 有锚点 → 下发 guide-action 高亮 #btn-export，回合终结不回喂', async () => {
    const token = await signToken();
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    try {
      await postFrame(token, sessionId, { type: 'context-report', sessionId, url: ORDER_LIST_URL });
      const message = await postFrame(token, sessionId, {
        type: 'user-message',
        sessionId,
        text: '导出订单在哪里？',
      });
      expect(message.status).toBe(202);
      await sse.waitFor(() => guideFrames(sse.frames).length > 0);
      const guide = guideFrames(sse.frames)[0]!;
      expect(guide['action']).toBe('highlight');
      expect(guide['selector']).toBe('#btn-export');
      expect(guide['message']).toContain('导出');
      expect(guide['sessionId']).toBe(sessionId);
      // 引导是终结动作：本回合不回喂 observation，无 LLM 二次文本气泡
      expect(textOf(sse.frames)).toBe('');
    } finally {
      sse.close();
    }
  });

  it('order-list 问 facts 无锚点的定位问题 → 如实降级文本，不下发 guide-action', async () => {
    const token = await signToken();
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    try {
      await postFrame(token, sessionId, { type: 'context-report', sessionId, url: ORDER_LIST_URL });
      await postFrame(token, sessionId, {
        type: 'user-message',
        sessionId,
        text: '在哪里打印发票？',
      });
      await sse.waitFor(() => textOf(sse.frames) === REPLY_NO_ANCHOR);
      expect(guideFrames(sse.frames)).toHaveLength(0);
    } finally {
      sse.close();
    }
  });

  it('无 facts 页（featureId=null）不注入 guide 工具 → 定位问句仍退化为文本', async () => {
    const token = await signToken();
    const sessionId = await createSession(token);
    await postFrame(token, sessionId, { type: 'context-report', sessionId, url: UNKNOWN_URL });
    const injection = await getInjection(token, sessionId);
    expect(injection['featureId']).toBeNull();
    const sse = await openSse(token, sessionId);
    try {
      await postFrame(token, sessionId, {
        type: 'user-message',
        sessionId,
        text: '导出在哪里？',
      });
      await sse.waitFor(() => textOf(sse.frames) === REPLY_NO_ANCHOR);
      expect(guideFrames(sse.frames)).toHaveLength(0);
    } finally {
      sse.close();
    }
  });

  it('LLM 产出越界 action 的引导 tool-call → 服务端不下发非法帧，改文本降级', async () => {
    const token = await signToken();
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    try {
      await postFrame(token, sessionId, { type: 'context-report', sessionId, url: ORDER_LIST_URL });
      await postFrame(token, sessionId, {
        type: 'user-message',
        sessionId,
        text: '越界导出在哪里？',
      });
      await sse.waitFor(() => textOf(sse.frames).includes('未能定位到目标元素'));
      expect(guideFrames(sse.frames)).toHaveLength(0);
    } finally {
      sse.close();
    }
  });
});

function framesByType(
  frames: Array<Record<string, unknown>>,
  type: string,
): Array<Record<string, unknown>> {
  return frames.filter((frame) => frame['type'] === type);
}

function lastCardStatus(
  frames: Array<Record<string, unknown>>,
  toolId: string,
): string | undefined {
  const cards = framesByType(frames, 'tool-card').filter((f) => f['toolId'] === toolId);
  return cards.length > 0 ? String(cards[cards.length - 1]!['status']) : undefined;
}

describe('代执行闭环（toolgate 分级 + HITL 挂起恢复，U7）', () => {
  const REPLY_CANCEL = '已为你取消订单 ORD-1001。';
  const REPLY_REFRESH = '已刷新，当前 2 笔订单。';
  const REPLY_REJECT = '已取消该操作，未做任何更改。';
  const REPLY_FORBIDDEN = '抱歉，该操作不被允许执行。';

  it('auto 工具（刷新）直执 → 下发 exec-instruction，回喂结果后产出总结、无 HITL', async () => {
    const token = await signToken();
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    try {
      await postFrame(token, sessionId, { type: 'context-report', sessionId, url: ORDER_LIST_URL });
      await postFrame(token, sessionId, { type: 'user-message', sessionId, text: '刷新订单列表' });
      await sse.waitFor(() => framesByType(sse.frames, 'exec-instruction').length > 0);
      expect(framesByType(sse.frames, 'hitl-request')).toHaveLength(0);
      const instr = framesByType(sse.frames, 'exec-instruction')[0]!;
      expect((instr['request'] as { method: string }).method).toBe('GET');
      expect((instr['request'] as { url: string }).url).toBe('/api/orders');
      expect(instr['signature']).toBeTruthy();
      expect(instr['nonce']).toBeTruthy();
      const nonce = String(instr['nonce']);
      const accepted = await postFrame(token, sessionId, {
        type: 'exec-result',
        sessionId,
        nonce,
        ok: true,
        status: 200,
        body: { ok: true, count: 2 },
      });
      expect(accepted.status).toBe(202);
      await sse.waitFor(() => textOf(sse.frames) === REPLY_REFRESH);
      expect(lastCardStatus(sse.frames, 'order-list.refresh-orders')).toBe('succeeded');
    } finally {
      sse.close();
    }
  });

  it('hitl 工具（取消）→ hitl-request → approve → exec 闭环 → 成功总结', async () => {
    const token = await signToken();
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    try {
      await postFrame(token, sessionId, { type: 'context-report', sessionId, url: ORDER_LIST_URL });
      await postFrame(token, sessionId, {
        type: 'user-message',
        sessionId,
        text: '帮我取消订单 ORD-1001',
      });
      await sse.waitFor(() => framesByType(sse.frames, 'hitl-request').length > 0);
      // HITL 挂起期间尚未下发代执行指令（判定未放行前不签发）
      expect(framesByType(sse.frames, 'exec-instruction')).toHaveLength(0);
      const hitl = framesByType(sse.frames, 'hitl-request')[0]!;
      expect(hitl['toolId']).toBe('order-list.cancel-order');
      expect((hitl['params'] as { orderId: string }).orderId).toBe('ORD-1001');
      await postFrame(token, sessionId, {
        type: 'hitl-decision',
        sessionId,
        hitlId: String(hitl['hitlId']),
        decision: 'approve',
      });
      await sse.waitFor(() => framesByType(sse.frames, 'exec-instruction').length > 0);
      const instr = framesByType(sse.frames, 'exec-instruction')[0]!;
      expect((instr['request'] as { method: string }).method).toBe('POST');
      expect((instr['request'] as { url: string }).url).toBe('/api/orders/ORD-1001/cancel');
      await postFrame(token, sessionId, {
        type: 'exec-result',
        sessionId,
        nonce: String(instr['nonce']),
        ok: true,
        status: 200,
        body: { ok: true, orderId: 'ORD-1001' },
      });
      await sse.waitFor(() => textOf(sse.frames) === REPLY_CANCEL);
      expect(lastCardStatus(sse.frames, 'order-list.cancel-order')).toBe('succeeded');
    } finally {
      sse.close();
    }
  });

  it('hitl 工具拒绝 → 不下发 exec-instruction，回喂 user-rejected、tool-card failed', async () => {
    const token = await signToken();
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    try {
      await postFrame(token, sessionId, { type: 'context-report', sessionId, url: ORDER_LIST_URL });
      await postFrame(token, sessionId, {
        type: 'user-message',
        sessionId,
        text: '帮我取消订单 ORD-1001',
      });
      await sse.waitFor(() => framesByType(sse.frames, 'hitl-request').length > 0);
      const hitl = framesByType(sse.frames, 'hitl-request')[0]!;
      await postFrame(token, sessionId, {
        type: 'hitl-decision',
        sessionId,
        hitlId: String(hitl['hitlId']),
        decision: 'reject',
      });
      await sse.waitFor(() => textOf(sse.frames) === REPLY_REJECT);
      expect(framesByType(sse.frames, 'exec-instruction')).toHaveLength(0);
      expect(lastCardStatus(sse.frames, 'order-list.cancel-order')).toBe('failed');
    } finally {
      sse.close();
    }
  });

  it('forbidden 工具（清空）→ 服务端 deny，无 HITL/无 exec-instruction，回喂拒绝文案', async () => {
    const token = await signToken();
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    try {
      await postFrame(token, sessionId, { type: 'context-report', sessionId, url: ORDER_LIST_URL });
      await postFrame(token, sessionId, {
        type: 'user-message',
        sessionId,
        text: '清空所有订单',
      });
      await sse.waitFor(() => textOf(sse.frames) === REPLY_FORBIDDEN);
      expect(framesByType(sse.frames, 'hitl-request')).toHaveLength(0);
      expect(framesByType(sse.frames, 'exec-instruction')).toHaveLength(0);
      expect(lastCardStatus(sse.frames, 'order-list.purge-orders')).toBe('failed');
    } finally {
      sse.close();
    }
  });

  it('exec-result 重放（同 nonce 二次 POST）→ 409，网关不再入 toolgate、不重复执行', async () => {
    const token = await signToken();
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    try {
      await postFrame(token, sessionId, { type: 'context-report', sessionId, url: ORDER_LIST_URL });
      await postFrame(token, sessionId, { type: 'user-message', sessionId, text: '刷新订单列表' });
      await sse.waitFor(() => framesByType(sse.frames, 'exec-instruction').length > 0);
      const nonce = String(framesByType(sse.frames, 'exec-instruction')[0]!['nonce']);
      const first = await postFrame(token, sessionId, {
        type: 'exec-result',
        sessionId,
        nonce,
        ok: true,
        status: 200,
        body: { ok: true, count: 2 },
      });
      expect(first.status).toBe(202);
      await sse.waitFor(() => textOf(sse.frames) === REPLY_REFRESH);
      const replay = await postFrame(token, sessionId, {
        type: 'exec-result',
        sessionId,
        nonce,
        ok: true,
        status: 200,
        body: { ok: true, count: 999 },
      });
      expect(replay.status).toBe(409);
    } finally {
      sse.close();
    }
  });

  it('伪造 nonce 的 exec-result → 409（无对应挂起回合）', async () => {
    const token = await signToken();
    const sessionId = await createSession(token);
    const res = await postFrame(token, sessionId, {
      type: 'exec-result',
      sessionId,
      nonce: 'forged-nonce',
      ok: true,
      body: { ok: true, count: 1 },
    });
    expect(res.status).toBe(409);
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

  it('signingSecret 缺失 → 拒绝启动（U7 一次性签名前提）', async () => {
    await expect(startServer(serverOptions({ signingSecret: '' }))).rejects.toThrow(
      /ZA_SIGNING_SECRET/,
    );
  });

  it('坏快照根 → 启动即 fail-fast', async () => {
    await expect(
      startServer(serverOptions({ snapshotRoot: join(repoRoot, 'examples/no-such-config') })),
    ).rejects.toThrow(/快照拒载/);
  });
});
