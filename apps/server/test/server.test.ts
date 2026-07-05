import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../src/index.js';

const repoRoot = new URL('../../../', import.meta.url).pathname;
const snapshotRoot = join(repoRoot, 'examples/host-demo/config');
const systemPromptPath = join(repoRoot, 'assets/system-prompt.md');
// 共享测试 server 的审计落点：审计链测试按 sessionId 过滤本流事件，与其它测试的事件互不干扰。
const AUDIT_SINK = join(mkdtempSync(join(tmpdir(), 'za-server-audit-')), 'events.jsonl');

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
    auditSinkPath: AUDIT_SINK,
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
      'order-list.page-operate',
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

describe('dom 代操作闭环（快照观察 → 批次签发 → 结果回喂，adr-011）', () => {
  it('page_snapshot 请求/上报 → kind=dom 签名指令 → reads 回喂 → 总结', async () => {
    const token = await signToken();
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    try {
      await postFrame(token, sessionId, { type: 'context-report', sessionId, url: ORDER_LIST_URL });
      await postFrame(token, sessionId, {
        type: 'user-message',
        sessionId,
        text: '帮我在页面上给订单加个备注',
      });
      // 观察半程：服务端下发 snapshot-request，客户端上报可交互元素清单。
      await sse.waitFor(() => framesByType(sse.frames, 'snapshot-request').length > 0);
      const snapshotRequest = framesByType(sse.frames, 'snapshot-request')[0]!;
      await postFrame(token, sessionId, {
        type: 'snapshot-report',
        sessionId,
        requestId: String(snapshotRequest['requestId']),
        url: ORDER_LIST_URL,
        title: '订单列表',
        elements: [
          { ref: 'za-1', role: 'input:text', label: '备注' },
          { ref: 'za-2', role: 'button', label: '保存' },
        ],
      });
      // 操作半程：签发 kind=dom 批次（步骤引用快照 ref、已净化），等客户端回传。
      await sse.waitFor(() => framesByType(sse.frames, 'exec-instruction').length > 0);
      const instr = framesByType(sse.frames, 'exec-instruction')[0]!;
      const request = instr['request'] as { kind: string; steps: Array<Record<string, unknown>> };
      expect(request.kind).toBe('dom');
      expect(request.steps).toEqual([
        { action: 'fill', ref: 'za-1', value: 'mock-note' },
        { action: 'click', ref: 'za-2' },
        { action: 'read', ref: 'za-1', name: 'noteValue' },
      ]);
      expect(instr['signature']).toBeTruthy();
      await postFrame(token, sessionId, {
        type: 'exec-result',
        sessionId,
        nonce: String(instr['nonce']),
        ok: true,
        body: { reads: { noteValue: 'mock-note' }, completedSteps: 3 },
      });
      await sse.waitFor(() => textOf(sse.frames) === '已在页面上完成操作，备注为 mock-note。');
      expect(lastCardStatus(sse.frames, 'order-list.page-operate')).toBe('succeeded');
    } finally {
      sse.close();
    }
  });

  it('快照带 notices → 拦截提示进 observation，agent 如实报告而非继续操作', async () => {
    const token = await signToken();
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    try {
      await postFrame(token, sessionId, { type: 'context-report', sessionId, url: ORDER_LIST_URL });
      await postFrame(token, sessionId, {
        type: 'user-message',
        sessionId,
        text: '帮我在页面上给订单加个备注',
      });
      await sse.waitFor(() => framesByType(sse.frames, 'snapshot-request').length > 0);
      const snapshotRequest = framesByType(sse.frames, 'snapshot-request')[0]!;
      await postFrame(token, sessionId, {
        type: 'snapshot-report',
        sessionId,
        requestId: String(snapshotRequest['requestId']),
        url: ORDER_LIST_URL,
        title: '订单列表',
        elements: [
          { ref: 'za-1', role: 'input:text', label: '备注' },
          { ref: 'za-2', role: 'button', label: '保存' },
        ],
        notices: ['请选择分组'],
      });
      // mock-llm 见 notices 即产出拦截报告文本：断言 notices 确经 observation 抵达 LLM。
      await sse.waitFor(() => textOf(sse.frames).includes('请选择分组'));
      expect(framesByType(sse.frames, 'exec-instruction')).toHaveLength(0);
    } finally {
      sse.close();
    }
  });

  it('过期/伪造 requestId 的快照上报 → 409（一次性等待器）', async () => {
    const token = await signToken();
    const sessionId = await createSession(token);
    const res = await postFrame(token, sessionId, {
      type: 'snapshot-report',
      sessionId,
      requestId: 'stale-or-forged',
      url: ORDER_LIST_URL,
      elements: [],
    });
    expect(res.status).toBe(409);
  });
});

describe('agent loop 轮数上限（maxTurnRounds 注入）', () => {
  it('maxTurnRounds=1：快照耗尽轮数 → 显式截断收尾、不签发操作指令', async () => {
    const capped = await startServer(serverOptions({ maxTurnRounds: 1 }));
    const base = `http://127.0.0.1:${capped.port}`;
    try {
      const token = await signToken();
      const created = await fetch(`${base}/v1/sessions`, {
        method: 'POST',
        headers: authHeaders(token),
      });
      const { sessionId } = (await created.json()) as { sessionId: string };
      const post = (frame: Record<string, unknown>) =>
        fetch(`${base}/v1/sessions/${sessionId}/frames`, {
          method: 'POST',
          headers: authHeaders(token, { 'content-type': 'application/json' }),
          body: JSON.stringify(frame),
        });
      const sse = await openSse2(base, token, sessionId);
      try {
        await post({ type: 'context-report', sessionId, url: ORDER_LIST_URL });
        await post({ type: 'user-message', sessionId, text: '帮我在页面上给订单加个备注' });
        await sse.waitFor(() => framesByType(sse.frames, 'snapshot-request').length > 0);
        const requestId = String(framesByType(sse.frames, 'snapshot-request')[0]!['requestId']);
        await post({
          type: 'snapshot-report',
          sessionId,
          requestId,
          url: ORDER_LIST_URL,
          elements: [
            { ref: 'za-1', role: 'input:text', label: '备注' },
            { ref: 'za-2', role: 'button', label: '保存' },
          ],
        });
        await sse.waitFor(() => textOf(sse.frames).includes('已达上限'));
        expect(framesByType(sse.frames, 'exec-instruction')).toHaveLength(0);
      } finally {
        sse.close();
      }
    } finally {
      await capped.close();
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

  it('corsOrigin 注入生效：预检与业务响应按配置回源', async () => {
    const scoped = await startServer(serverOptions({ corsOrigin: 'http://host.example' }));
    const scopedBase = `http://127.0.0.1:${scoped.port}`;
    try {
      const preflight = await fetch(`${scopedBase}/v1/sessions`, { method: 'OPTIONS' });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe('http://host.example');
      const token = await signToken();
      const res = await fetch(`${scopedBase}/v1/sessions`, {
        method: 'POST',
        headers: authHeaders(token),
      });
      expect(res.headers.get('access-control-allow-origin')).toBe('http://host.example');
    } finally {
      await scoped.close();
    }
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

describe('P0-b demo-token 端点（env 门控）', () => {
  it('默认关闭时 POST /demo-token → 404', async () => {
    const res = await api('/demo-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostUserId: '2579' }),
    });
    expect(res.status).toBe(404);
  });

  it('启用后签发 token 可直接创建会话（sign→verify 闭环，无需已有 token）', async () => {
    const demo = await startServer(serverOptions({ demoToken: { enabled: true, iss: ISS } }));
    const demoBase = `http://127.0.0.1:${demo.port}`;
    try {
      const res = await fetch(`${demoBase}/demo-token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hostUserId: '2579' }),
      });
      expect(res.status).toBe(200);
      const { token } = (await res.json()) as { token: string };
      expect(token).toBeTruthy();
      const created = await fetch(`${demoBase}/v1/sessions`, {
        method: 'POST',
        headers: authHeaders(token),
      });
      expect(created.status).toBe(201);

      const badBody = await fetch(`${demoBase}/demo-token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hostUserId: '' }),
      });
      expect(badBody.status).toBe(400);
    } finally {
      await demo.close();
    }
  });
});

/** 读共享审计落点，取属于指定 session 的事件（按 sessionId 隔离本测试流）。 */
function auditEventsFor(sessionId: string): Array<Record<string, unknown>> {
  const raw = readFileSync(AUDIT_SINK, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((event) => event['sessionId'] === sessionId);
}

const SECRET_SIGNATURES = [/sk-[A-Za-z0-9]{20,}/, /eyJ[\w-]+\.[\w-]+\.[\w-]+/, /ghp_[A-Za-z0-9]{36}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/];

/** 针对自定义 base（旁路测试自起的 server）的 SSE 读取，语义同 openSse。 */
async function openSse2(base: string, token: string, sessionId: string): Promise<SseHandle> {
  const controller = new AbortController();
  const response = await fetch(`${base}/v1/sessions/${sessionId}/events`, {
    headers: authHeaders(token),
    signal: controller.signal,
  });
  const frames: Array<Record<string, unknown>> = [];
  void (async () => {
    if (!response.body) return;
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk as Uint8Array, { stream: true });
        let index: number;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          for (const line of block.split('\n')) {
            if (line.startsWith('data: ')) frames.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
          }
        }
      }
    } catch {
      // abort 断开属正常收尾
    }
  })();
  return {
    frames,
    raw: () => '',
    async waitFor(predicate, timeoutMs = 8000) {
      const deadline = Date.now() + timeoutMs;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`SSE 等待超时；已收帧：${JSON.stringify(frames)}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
    close: () => controller.abort(),
  };
}

describe('审计事件链（M4 全链路 + 脱敏 + 旁路）', () => {
  it('完整 HITL 代执行后 .za events 含五段事件链且无 secret/签名值', async () => {
    const token = await signToken();
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    let signature = '';
    try {
      await postFrame(token, sessionId, { type: 'context-report', sessionId, url: ORDER_LIST_URL });
      await postFrame(token, sessionId, { type: 'user-message', sessionId, text: '帮我取消订单 ORD-1001' });
      await sse.waitFor(() => framesByType(sse.frames, 'hitl-request').length > 0);
      const hitl = framesByType(sse.frames, 'hitl-request')[0]!;
      await postFrame(token, sessionId, {
        type: 'hitl-decision',
        sessionId,
        hitlId: String(hitl['hitlId']),
        decision: 'approve',
      });
      await sse.waitFor(() => framesByType(sse.frames, 'exec-instruction').length > 0);
      const instr = framesByType(sse.frames, 'exec-instruction')[0]!;
      signature = String(instr['signature']);
      await postFrame(token, sessionId, {
        type: 'exec-result',
        sessionId,
        nonce: String(instr['nonce']),
        ok: true,
        status: 200,
        body: { ok: true, orderId: 'ORD-1001' },
      });
      await sse.waitFor(() => textOf(sse.frames).includes('已为你取消订单 ORD-1001'));
    } finally {
      sse.close();
    }

    const events = auditEventsFor(sessionId);
    const types = events.map((e) => e['type']);
    for (const expected of ['session-start', 'assembly', 'tool-decision', 'hitl-verdict', 'tool-execution']) {
      expect(types).toContain(expected);
    }
    const decision = events.find((e) => e['type'] === 'tool-decision')!['data'] as Record<string, unknown>;
    expect(decision['verdict']).toBe('hitl');
    expect(decision['riskTier']).toBe('hitl');
    const verdict = events.find((e) => e['type'] === 'hitl-verdict')!['data'] as Record<string, unknown>;
    expect(verdict['decision']).toBe('approve');
    const execution = events.find((e) => e['type'] === 'tool-execution')!['data'] as Record<string, unknown>;
    expect(execution['outcome']).toBe('ok');
    expect(execution['execution']).toBe('client');

    // 脱敏 + 无签名：事件全文不含 secret 样式，且不含 exec-instruction 的 signature 字段值。
    const dump = JSON.stringify(events);
    for (const sig of SECRET_SIGNATURES) expect(dump).not.toMatch(sig);
    expect(dump).not.toContain(signature);
    expect(dump).not.toContain(token);
  });

  it('forbidden 工具：审计有 tool-decision(deny) 但无 tool-execution（未执行）', async () => {
    const token = await signToken();
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    try {
      await postFrame(token, sessionId, { type: 'context-report', sessionId, url: ORDER_LIST_URL });
      await postFrame(token, sessionId, { type: 'user-message', sessionId, text: '帮我清空所有订单' });
      await sse.waitFor(() => textOf(sse.frames).includes('不被允许'));
    } finally {
      sse.close();
    }
    const events = auditEventsFor(sessionId);
    const decision = events.find((e) => e['type'] === 'tool-decision')!['data'] as Record<string, unknown>;
    expect(decision['verdict']).toBe('deny');
    expect(events.some((e) => e['type'] === 'tool-execution')).toBe(false);
  });

  it('旁路铁律：审计 sink 不可写时会话主链路不受影响', async () => {
    // auditSinkPath 指向一个已存在的目录 → append 必失败；record 吞掉、会话仍正常。
    const badServer = await startServer(serverOptions({ auditSinkPath: repoRoot }));
    try {
      const base = `http://127.0.0.1:${badServer.port}`;
      const token = await signToken();
      const createRes = await fetch(`${base}/v1/sessions`, { method: 'POST', headers: authHeaders(token) });
      expect(createRes.status).toBe(201);
      const { sessionId } = (await createRes.json()) as { sessionId: string };
      const sse = await openSse2(base, token, sessionId);
      try {
        await fetch(`${base}/v1/sessions/${sessionId}/frames`, {
          method: 'POST',
          headers: authHeaders(token, { 'content-type': 'application/json' }),
          body: JSON.stringify({ type: 'context-report', sessionId, url: ORDER_LIST_URL }),
        });
        await fetch(`${base}/v1/sessions/${sessionId}/frames`, {
          method: 'POST',
          headers: authHeaders(token, { 'content-type': 'application/json' }),
          body: JSON.stringify({ type: 'user-message', sessionId, text: '已完成的订单能取消吗？' }),
        });
        await sse.waitFor(() => textOf(sse.frames).includes('不可取消'));
      } finally {
        sse.close();
      }
    } finally {
      await badServer.close();
    }
  });
});
