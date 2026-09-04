import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startServer, type RunningServer } from '../src/index.js';
import { redactSnapshotValues } from '../src/gateway.js';
import { createFsUserConfigStore } from '../src/user-config-store.js';
import { createMemorySessionStore, createPersistentSessionStore } from '../src/sessions.js';

const repoRoot = new URL('../../../', import.meta.url).pathname;
const snapshotRoot = join(repoRoot, 'examples/host-demo/config');
const acceptanceRoot = join(repoRoot, 'examples/acceptance');
const sitePacksRoot = join(repoRoot, 'examples/site-packs');
const systemPromptPath = join(repoRoot, 'assets/system-prompt.md');
// 共享测试 server 的审计落点：审计链测试按 sessionId 过滤本流事件，与其它测试的事件互不干扰。
const AUDIT_SINK = join(mkdtempSync(join(tmpdir(), 'za-server-audit-')), 'events.jsonl');

const JWT_SECRET = 'za-test-secret';
const SIGNING_SECRET = 'za-test-signing-secret';
const ISS = 'zen-agent-demo';
const key = new TextEncoder().encode(JWT_SECRET);

const REPLY_R1 = '根据本功能事实：已完成订单不可取消（其取消按钮为禁用态）。';
const REPLY_R2_LIST = '这是订单列表页：可查看订单、进入详情、取消未发货订单。';
const REPLY_GENERAL_QA = 'MOCK-GENERAL-QA-HIT：这类通用请求可以直接回答。';
const REPLY_NO_ANCHOR = 'MOCK-NO-ANCHOR';

const ORDER_LIST_URL = 'http://127.0.0.1:4173/order-list.html';
const UNKNOWN_URL = 'http://127.0.0.1:4173/unknown.html';

it('服务端二次剥离快照输入值与 href query，均不进入模型', () => {
  expect(
    redactSnapshotValues([
      { ref: 'za-message', role: 'textarea', label: '消息', value: '不应进入模型' },
      { ref: 'za-send', role: 'link', label: '发送', href: 'https://example.test/?token=query-canary' },
    ]),
  ).toEqual([
    { ref: 'za-message', role: 'textarea', label: '消息' },
    { ref: 'za-send', role: 'link', label: '发送' },
  ]);
});

interface MockLlmHandle {
  port: number;
  /** 原始请求体（JSON 字符串），供断言送到模型面前的消息序列。 */
  requests: string[];
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

async function getAutomationRun(token: string, sessionId: string, runId: string): Promise<Record<string, unknown>> {
  const response = await api(
    `/v1/sessions/${encodeURIComponent(sessionId)}/automation-runs/${encodeURIComponent(runId)}`,
    { headers: authHeaders(token) },
  );
  expect(response.status).toBe(200);
  return await response.json() as Record<string, unknown>;
}

async function getInjection(token: string, sessionId: string): Promise<Record<string, unknown>> {
  const res = await api(`/v1/sessions/${encodeURIComponent(sessionId)}/injection`, {
    headers: authHeaders(token),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

async function getTurnState(token: string, sessionId: string): Promise<Record<string, unknown>> {
  const res = await api(`/v1/sessions/${encodeURIComponent(sessionId)}/turn-state`, {
    headers: authHeaders(token),
  });
  expect(res.status).toBe(200);
  return await res.json() as Record<string, unknown>;
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
  expect(response.headers.get('x-zen-agent-exec-algorithm')).toBe('Ed25519');
  expect(response.headers.get('x-zen-agent-exec-public-key')).toBeTruthy();
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

  it('GET /healthz 免鉴权 200（容器存活探针）；业务路由不受影响', async () => {
    const res = await api('/healthz', { method: 'GET' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // 仅 GET 放行：其他方法走后续路由判定（POST /healthz 非已知路由 → 先撞鉴权 401）。
    const post = await api('/healthz', { method: 'POST' });
    expect(post.status).toBe(401);
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

  it('config-decision 在未组装写入通道（无 userConfigDir）的服务上 → 400 fail-closed', async () => {
    const token = await signToken();
    const sessionId = await createSession(token);
    const res = await postFrame(token, sessionId, {
      type: 'config-decision',
      sessionId,
      draftId: 'd-01',
      decision: 'accept',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('未启用');
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
  it('停止活动回合会解除代执行等待、取消后续执行并发出 turn-complete', async () => {
    const token = await signToken();
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    const messageId = 'message-stop-active';
    try {
      await postFrame(token, sessionId, {
        type: 'context-report', sessionId, url: ORDER_LIST_URL,
      });
      const started = await postFrame(token, sessionId, {
        type: 'user-message',
        sessionId,
        messageId,
        text: '在页面上刷新订单',
      });
      expect(started.status).toBe(202);
      await sse.waitFor(() => sse.frames.some((frame) => frame['type'] === 'exec-instruction'));
      const stopped = await api(`/v1/sessions/${sessionId}/stop`, {
        method: 'POST',
        headers: authHeaders(token, { 'content-type': 'application/json' }),
        body: JSON.stringify({ messageId }),
      });
      expect(stopped.status).toBe(202);
      await sse.waitFor(() => sse.frames.some(
        (frame) => frame['type'] === 'turn-complete' && frame['messageId'] === messageId,
      ));
      expect(sse.frames.some(
        (frame) => frame['type'] === 'text-delta' && frame['delta'] === '已停止当前任务。',
      )).toBe(true);
      expect(await getTurnState(token, sessionId)).toEqual({ running: false });
    } finally {
      sse.close();
    }
  });

  it('幂等占位无法耐久写入时返回 503，且不启动回合', async () => {
    const base = mkdtempSync(join(tmpdir(), 'za-idempotency-failure-'));
    const blockedSessionDir = join(base, 'not-a-directory');
    writeFileSync(blockedSessionDir, 'x', 'utf8');
    const unsafe = await startServer(serverOptions({ sessionDir: blockedSessionDir }));
    try {
      const token = await signToken();
      const unsafeBase = `http://127.0.0.1:${unsafe.port}`;
      const created = await fetch(`${unsafeBase}/v1/sessions`, {
        method: 'POST',
        headers: authHeaders(token),
      });
      const { sessionId } = await created.json() as { sessionId: string };
      const response = await fetch(`${unsafeBase}/v1/sessions/${sessionId}/frames`, {
        method: 'POST',
        headers: authHeaders(token, { 'content-type': 'application/json' }),
        body: JSON.stringify({
          type: 'user-message',
          sessionId,
          messageId: 'must-not-run',
          text: '不得执行',
        }),
      });
      expect(response.status).toBe(503);
      const turnState = await fetch(`${unsafeBase}/v1/sessions/${sessionId}/turn-state`, {
        headers: authHeaders(token),
      });
      expect(await turnState.json()).toEqual({ running: false });
    } finally {
      await unsafe.close();
    }
  });

  it('服务重启后的遗留 pending 明确返回中断，不永久等待或重复启动回合', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'za-restart-session-'));
    const seeded = createPersistentSessionStore(createMemorySessionStore(), { dir });
    const seededSession = seeded.create({
      sub: 'user-1',
      tenant: 'demo-tenant',
      roles: ['ops'],
      hostUserId: 'host-u1',
      iss: ISS,
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    expect(seeded.reserveMessageTurn(seededSession.sessionId, 'interrupted-message')).toBe('reserved');
    seeded.stop();

    const restarted = await startServer(serverOptions({ sessionDir: dir }));
    try {
      const token = await signToken();
      const response = await fetch(
        `http://127.0.0.1:${restarted.port}/v1/sessions/${seededSession.sessionId}/frames`,
        {
          method: 'POST',
          headers: authHeaders(token, { 'content-type': 'application/json' }),
          body: JSON.stringify({
            type: 'user-message',
            sessionId: seededSession.sessionId,
            messageId: 'interrupted-message',
            text: '请勿重复执行',
          }),
        },
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ messageState: 'interrupted', idle: true });
    } finally {
      await restarted.close();
    }
  });

  it('相同 messageId 重投只启动一次回合，并返回当前幂等状态', async () => {
    const token = await signToken();
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    const messageId = 'message-idempotent-1';
    try {
      await postFrame(token, sessionId, {
        type: 'context-report', sessionId, url: ORDER_LIST_URL,
      });
      const frame = { type: 'user-message', sessionId, messageId, text: '已完成的订单还能取消吗？' };
      const first = await postFrame(token, sessionId, frame);
      const duplicatePending = await postFrame(token, sessionId, frame);
      expect(first.status).toBe(202);
      expect(await first.json()).toMatchObject({ accepted: true, messageState: 'pending' });
      const duplicateState = await duplicatePending.json() as { accepted?: unknown; duplicate?: unknown; messageState?: unknown };
      expect(duplicateState).toMatchObject({ accepted: true, duplicate: true });
      expect(['pending', 'complete']).toContain(duplicateState.messageState);
      await sse.waitFor(() => sse.frames.some(
        (item) => item['type'] === 'turn-complete' && item['messageId'] === messageId,
      ));
      const duplicateComplete = await postFrame(token, sessionId, frame);
      expect(await duplicateComplete.json()).toMatchObject({
        accepted: true, duplicate: true, messageState: 'complete', idle: true,
      });
      expect(sse.frames.filter(
        (item) => item['type'] === 'turn-complete' && item['messageId'] === messageId,
      )).toHaveLength(1);
    } finally {
      sse.close();
    }
  });

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
      await sse.waitFor(() => sse.frames.some((frame) => frame['type'] === 'turn-complete'));
      expect(await getTurnState(token, sessionId)).toEqual({ running: false });
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

  it('未登记 URL → featureId=null 仅基座（fail-safe），通用请求由基座直接应答', async () => {
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
      await sse.waitFor(() => textOf(sse.frames) === REPLY_GENERAL_QA);
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

  it('客户端不回 exec-result 时按指令 TTL 主动结束回合，迟到结果返回 409', async () => {
    const timeoutServer = await startServer(serverOptions({ execInstructionTtlMs: 30 }));
    const previousBaseUrl = baseUrl;
    baseUrl = `http://127.0.0.1:${timeoutServer.port}`;
    const token = await signToken();
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    try {
      await postFrame(token, sessionId, { type: 'context-report', sessionId, url: ORDER_LIST_URL });
      await postFrame(token, sessionId, { type: 'user-message', sessionId, text: '刷新订单列表' });
      await sse.waitFor(() => framesByType(sse.frames, 'exec-instruction').length === 1);
      const nonce = String(framesByType(sse.frames, 'exec-instruction')[0]!['nonce']);
      await sse.waitFor(() => lastCardStatus(sse.frames, 'order-list.refresh-orders') === 'failed');
      const late = await postFrame(token, sessionId, {
        type: 'exec-result',
        sessionId,
        nonce,
        ok: true,
        body: { ok: true, count: 2 },
      });
      expect(late.status).toBe(409);
    } finally {
      sse.close();
      baseUrl = previousBaseUrl;
      await timeoutServer.close();
    }
  });

  it('模型实参 JSON 截断 → 回喂修正提示自愈重试，回合不终结（invalid-tool-args）', async () => {
    const token = await signToken();
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    try {
      await postFrame(token, sessionId, { type: 'context-report', sessionId, url: ORDER_LIST_URL });
      // mock-llm '模拟截断实参' 哨兵：首轮产出半截 arguments → llm-port 报 invalid-tool-args →
      // 网关回喂修正提示 → mock 依提示产出完整调用 → 正常签发执行。
      await postFrame(token, sessionId, { type: 'user-message', sessionId, text: '模拟截断实参 刷新订单列表' });
      await sse.waitFor(() => framesByType(sse.frames, 'exec-instruction').length > 0);
      // 自愈路径不向用户播报"服务暂时不可用"。
      expect(textOf(sse.frames)).not.toContain('服务暂时不可用');
      const instr = framesByType(sse.frames, 'exec-instruction')[0]!;
      expect((instr['request'] as { url: string }).url).toBe('/api/orders');
      await postFrame(token, sessionId, {
        type: 'exec-result',
        sessionId,
        nonce: String(instr['nonce']),
        ok: true,
        status: 200,
        body: { ok: true, count: 2 },
      });
      await sse.waitFor(() => textOf(sse.frames).includes(REPLY_REFRESH));
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
    // 人工回合基线：run 归因键缺省（automationRunId/automationId 是无人值守回合专属）。
    for (const event of events) {
      expect(event['automationRunId']).toBeUndefined();
      expect(event['automationId']).toBeUndefined();
    }

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

/**
 * ADR-013 渐进披露第一层：装配注入"已安装站点索引"+ 内建 site_navigate 工具面（≥2 带 site 的 pack 才注入）。
 * 用捕获式 mock LLM 断言送达 LLM 的 system 与 tools：acceptance 根（codeflow+mail 双 site）注入索引与 site_navigate；
 * host-demo 根（单 site）两者皆无——直接验证 gateway 的 buildSystemContent 与工具面装配。
 */
interface CapturingMock {
  port: number;
  requests: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

function startCapturingMock(): Promise<CapturingMock> {
  const requests: Array<Record<string, unknown>> = [];
  const httpServer = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404).end();
      return;
    }
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      try {
        requests.push(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        /* 非 JSON 请求体（不应发生），忽略 */
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const base = { id: 'x', object: 'chat.completion.chunk', created: 0, model: 'mock-model' };
      const send = (choice: unknown): void => {
        res.write(`data: ${JSON.stringify({ ...base, choices: [choice] })}\n\n`);
      };
      send({ index: 0, delta: { role: 'assistant' }, finish_reason: null });
      send({ index: 0, delta: { content: 'ok' }, finish_reason: null });
      send({ index: 0, delta: {}, finish_reason: 'stop' });
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve({ port, requests, close: () => new Promise((r) => httpServer.close(() => r())) });
    });
  });
}

describe('ADR-013 渐进披露：站点索引 + site_navigate 注入（≥2 site 装配）', () => {
  let capturing: CapturingMock;
  let acceptanceServer: RunningServer;
  let demoServer: RunningServer;
  let prevBaseUrl: string | undefined;

  beforeAll(async () => {
    capturing = await startCapturingMock();
    prevBaseUrl = process.env['ZA_LLM_BASE_URL'];
    process.env['ZA_LLM_BASE_URL'] = `http://127.0.0.1:${capturing.port}/v1`;
    acceptanceServer = await startServer(
      serverOptions({ snapshotRoot: join(repoRoot, 'examples/acceptance') }),
    );
    demoServer = await startServer(serverOptions());
  });

  afterAll(async () => {
    await acceptanceServer?.close();
    await demoServer?.close();
    await capturing?.close();
    if (prevBaseUrl !== undefined) process.env['ZA_LLM_BASE_URL'] = prevBaseUrl;
  });

  /** 驱动一次会话到 LLM 调用，返回送达 LLM 的最近一次 system 文本与工具名清单。 */
  async function driveOnce(srv: RunningServer, url: string): Promise<{ system: string; toolNames: string[] }> {
    capturing.requests.length = 0;
    const token = await signToken();
    const base = `http://127.0.0.1:${srv.port}`;
    const created = await fetch(`${base}/v1/sessions`, { method: 'POST', headers: authHeaders(token) });
    const { sessionId } = (await created.json()) as { sessionId: string };
    await fetch(`${base}/v1/sessions/${sessionId}/frames`, {
      method: 'POST',
      headers: authHeaders(token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ type: 'context-report', sessionId, url }),
    });
    await fetch(`${base}/v1/sessions/${sessionId}/frames`, {
      method: 'POST',
      headers: authHeaders(token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ type: 'user-message', sessionId, text: '你好' }),
    });
    const deadline = Date.now() + 8000;
    while (capturing.requests.length === 0) {
      if (Date.now() > deadline) throw new Error('等待 LLM 调用捕获超时');
      await new Promise((r) => setTimeout(r, 25));
    }
    const req = capturing.requests[capturing.requests.length - 1]!;
    const messages = (req['messages'] ?? []) as Array<{ role: string; content: string }>;
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    const tools = (req['tools'] ?? []) as Array<{ name?: string; function?: { name?: string } }>;
    const toolNames = tools.map((t) => t.function?.name ?? t.name ?? '');
    return { system, toolNames };
  }

  // 判别注入的站点索引本体用其正文行"平台可辅助以下站点"——ZA-SYS-06 基座条款措辞不同（"平台能辅助"），
  // 故基座恒含的说明句不会误判为已注入索引。
  const INDEX_BODY_MARKER = '平台可辅助以下站点';

  it('双 site 根（codeflow 会话）：system 含站点索引列两站，工具面含 site_navigate', async () => {
    const { system, toolNames } = await driveOnce(acceptanceServer, 'https://codeflow.asia/console/log');
    expect(system).toContain(INDEX_BODY_MARKER);
    expect(system).toContain('codeflow.asia');
    expect(system).toContain('mail.126.com');
    expect(toolNames).toContain('site_navigate');
    // open_url 只随 generic 准入注入：站点 pack 会话不给任意开页入口。
    expect(toolNames).not.toContain('open_url');
  });

  it('单 site 根（host-demo 会话）：无站点索引、工具面无 site_navigate（<2 site 不注入）', async () => {
    const { system, toolNames } = await driveOnce(demoServer, ORDER_LIST_URL);
    expect(system).not.toContain(INDEX_BODY_MARKER);
    expect(toolNames).not.toContain('site_navigate');
    expect(toolNames).not.toContain('open_url');
  });
});

describe('adr-014 L2 注入贯通：个人规则进入实际 system 注入且与透明视图一致（R4）', () => {
  let capturing: CapturingMock;
  let l2Server: RunningServer;
  let prevBaseUrl: string | undefined;
  const userConfigDir = mkdtempSync(join(tmpdir(), 'za-l2-inject-'));

  beforeAll(async () => {
    // claims 固定 tenant=demo-tenant / hostUserId=host-u1（signToken 缺省）；经 store 端口预置该
    // subject 的 overlay——文件段编码（percent-encode + 大小写消歧尾缀）是存储实现细节，测试不硬编码路径。
    await createFsUserConfigStore({ dir: userConfigDir }).write(
      { tenant: 'demo-tenant', hostUserId: 'host-u1' },
      {
        schemaVersion: 1,
        subject: { tenant: 'demo-tenant', hostUserId: 'host-u1' },
        packs: {
          '*': {
            rules: [
              {
                id: 'r-l2-e2e-1',
                text: '所有回复末尾附加敬语标记。',
                origin: 'manual',
                createdAt: '2026-08-05T00:00:00.000Z',
              },
            ],
          },
        },
      },
    );
    capturing = await startCapturingMock();
    prevBaseUrl = process.env['ZA_LLM_BASE_URL'];
    process.env['ZA_LLM_BASE_URL'] = `http://127.0.0.1:${capturing.port}/v1`;
    l2Server = await startServer(serverOptions({ userConfigDir }));
  });

  afterAll(async () => {
    await l2Server?.close();
    await capturing?.close();
    if (prevBaseUrl !== undefined) process.env['ZA_LLM_BASE_URL'] = prevBaseUrl;
  });

  it('system 注入含 L2 规则文本与条目 id；/injection 视图 user-rules 块同 id（三方互证的注入侧）', async () => {
    capturing.requests.length = 0;
    const token = await signToken();
    const base = `http://127.0.0.1:${l2Server.port}`;
    const created = await fetch(`${base}/v1/sessions`, { method: 'POST', headers: authHeaders(token) });
    const { sessionId } = (await created.json()) as { sessionId: string };
    const post = (frame: Record<string, unknown>): Promise<Response> =>
      fetch(`${base}/v1/sessions/${sessionId}/frames`, {
        method: 'POST',
        headers: authHeaders(token, { 'content-type': 'application/json' }),
        body: JSON.stringify(frame),
      });
    await post({ type: 'context-report', sessionId, url: ORDER_LIST_URL });
    await post({ type: 'user-message', sessionId, text: '你好' });
    const deadline = Date.now() + 8000;
    while (capturing.requests.length === 0) {
      if (Date.now() > deadline) throw new Error('等待 LLM 调用捕获超时');
      await new Promise((r) => setTimeout(r, 25));
    }
    const req = capturing.requests[capturing.requests.length - 1]!;
    const messages = (req['messages'] ?? []) as Array<{ role: string; content: string }>;
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    expect(system).toContain('用户个人规则');
    expect(system).toContain('所有回复末尾附加敬语标记。');
    expect(system).toContain('r-l2-e2e-1');

    const injection = await fetch(`${base}/v1/sessions/${sessionId}/injection`, {
      headers: authHeaders(token),
    });
    expect(injection.status).toBe(200);
    const view = (await injection.json()) as { blocks?: Array<{ kind: string; id?: string }> };
    const userRuleBlocks = (view.blocks ?? []).filter((block) => block.kind === 'user-rules');
    expect(userRuleBlocks.map((block) => block.id)).toContain('r-l2-e2e-1');
  });
});

describe('adr-019 自动化描述符端点（pack 声明下发）', () => {
  it('GET /v1/automation-descriptors 输出站点包根的 pack 自动化声明', async () => {
    const srv = await startServer(serverOptions({ snapshotRoot: sitePacksRoot }));
    try {
      const token = await signToken();
      const response = await fetch(`http://127.0.0.1:${srv.port}/v1/automation-descriptors`, {
        headers: authHeaders(token),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { descriptors: Array<Record<string, unknown>> };
      expect(body.descriptors).toEqual([
        {
          packId: 'xianyu-seller',
          origin: 'https://seller.goofish.com',
          automation: {
            id: 'xianyu-auto-scan',
            prompt: '执行闲鱼待发货订单扫描。每轮最多处理一笔；任一页面、订单或回执状态不确定时立即暂停，不得重试发送。',
            workRoutes: ['#/seller-trade/order-manage', '#/im'],
            executionPreference: 'dom-only',
            defaultPeriodMinutes: 5,
          },
        },
      ]);
    } finally {
      await srv.close();
    }
  });

  it('未鉴权请求被拒', async () => {
    const srv = await startServer(serverOptions({ snapshotRoot: sitePacksRoot }));
    try {
      const response = await fetch(`http://127.0.0.1:${srv.port}/v1/automation-descriptors`);
      expect(response.status).toBe(401);
    } finally {
      await srv.close();
    }
  });
});

describe('adr-024 治理决策链完整性（无人值守收口 / 停止吊销 / 批准复核）', () => {
  const ORDER_MANAGE_URL =
    'https://seller.goofish.com/?site=COMMONPRO#/seller-trade/order-manage';
  const IM_URL =
    'https://seller.goofish.com/?site=COMMONPRO#/im?itemId=item-u&orderId=order-u&peerUserId=buyer-u';
  const ORDERS_TOOL = 'xianyu-orders.page-operate';
  const SEND_TOOL = 'xianyu-fulfillment.send-test-message';
  const ORDERS_PROMPT = '在页面上筛选待发货订单';
  const ORDER_ELEMENTS = [
    { ref: 'za-pending', role: 'button', label: '待发货' },
    { ref: 'za-empty', role: 'text', label: '暂无数据' },
  ];

  function toolDecisions(sessionId: string, toolId: string): Array<Record<string, unknown>> {
    return auditEventsFor(sessionId)
      .filter((event) => event['type'] === 'tool-decision')
      .map((event) => event['data'] as Record<string, unknown>)
      .filter((data) => data['toolId'] === toolId);
  }

  async function reportSnapshot(
    token: string,
    sessionId: string,
    requestId: string,
    url: string,
    elements: Array<Record<string, unknown>>,
  ): Promise<void> {
    await postFrame(token, sessionId, {
      type: 'snapshot-report',
      sessionId,
      requestId,
      url,
      pageInstanceId: 'page-adr024',
      elements,
    });
  }

  it('pack 声明自动化的无人值守回合命中 hitl 工具：服务端 deny，不广播确认卡、不签发指令', async () => {
    const unattendedServer = await startServer(
      serverOptions({ snapshotRoot: acceptanceRoot, maxTurnRounds: 2 }),
    );
    const previousBaseUrl = baseUrl;
    baseUrl = `http://127.0.0.1:${unattendedServer.port}`;
    const token = await signToken();
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    try {
      await postFrame(token, sessionId, { type: 'context-report', sessionId, url: IM_URL });
      await postFrame(token, sessionId, {
        type: 'user-message',
        sessionId,
        text: '发送闲鱼测试消息',
        automationRunId: 'adr024_unattended_run', automationId: 'xianyu-auto-scan',
      });
      await sse.waitFor(() => framesByType(sse.frames, 'snapshot-request').length === 1);
      await reportSnapshot(
        token,
        sessionId,
        String(framesByType(sse.frames, 'snapshot-request')[0]!['requestId']),
        IM_URL,
        [
          { ref: 'za-message', role: 'textarea', label: '请输入消息' },
          { ref: 'za-send', role: 'button', label: '发 送' },
        ],
      );
      await sse.waitFor(() => lastCardStatus(sse.frames, SEND_TOOL) === 'failed');
      // 无人在场时确认卡不得出现在任何客户端上——治理拒绝在服务端完成，不依赖插件自动 reject。
      expect(framesByType(sse.frames, 'hitl-request')).toHaveLength(0);
      expect(framesByType(sse.frames, 'exec-instruction')).toHaveLength(0);
      const decisions = toolDecisions(sessionId, SEND_TOOL);
      expect(decisions.length).toBeGreaterThan(0);
      expect(decisions[decisions.length - 1]).toMatchObject({
        verdict: 'deny',
        reason: 'hitl-unattended',
      });
    } finally {
      sse.close();
      baseUrl = previousBaseUrl;
      await unattendedServer.close();
    }
  });

  it('同一 hitl 工具在人工回合仍照常弹确认卡（收口只针对无人值守回合）', async () => {
    const attendedServer = await startServer(
      serverOptions({ snapshotRoot: acceptanceRoot, maxTurnRounds: 2 }),
    );
    const previousBaseUrl = baseUrl;
    baseUrl = `http://127.0.0.1:${attendedServer.port}`;
    const token = await signToken();
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    try {
      await postFrame(token, sessionId, { type: 'context-report', sessionId, url: IM_URL });
      await postFrame(token, sessionId, { type: 'user-message', sessionId, text: '发送闲鱼测试消息' });
      await sse.waitFor(() => framesByType(sse.frames, 'snapshot-request').length === 1);
      await reportSnapshot(
        token,
        sessionId,
        String(framesByType(sse.frames, 'snapshot-request')[0]!['requestId']),
        IM_URL,
        [
          { ref: 'za-message', role: 'textarea', label: '请输入消息' },
          { ref: 'za-send', role: 'button', label: '发 送' },
        ],
      );
      await sse.waitFor(() => framesByType(sse.frames, 'hitl-request').length === 1);
      expect(framesByType(sse.frames, 'hitl-request')[0]!['toolId']).toBe(SEND_TOOL);
      await postFrame(token, sessionId, {
        type: 'hitl-decision',
        sessionId,
        hitlId: String(framesByType(sse.frames, 'hitl-request')[0]!['hitlId']),
        decision: 'reject',
      });
      await sse.waitFor(() => lastCardStatus(sse.frames, SEND_TOOL) === 'failed');
    } finally {
      sse.close();
      baseUrl = previousBaseUrl;
      await attendedServer.close();
    }
  });

  it('用户停止即吊销任务授权：停止后同任务同工具再调用重新弹确认卡', async () => {
    const stopServer = await startServer(
      serverOptions({ snapshotRoot: acceptanceRoot, maxTurnRounds: 3 }),
    );
    const previousBaseUrl = baseUrl;
    baseUrl = `http://127.0.0.1:${stopServer.port}`;
    const token = await signToken();
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    try {
      await postFrame(token, sessionId, { type: 'context-report', sessionId, url: ORDER_MANAGE_URL });
      await postFrame(token, sessionId, {
        type: 'user-message', sessionId, text: ORDERS_PROMPT, messageId: 'adr024-stop-1',
      });
      await sse.waitFor(() => framesByType(sse.frames, 'snapshot-request').length === 1);
      await reportSnapshot(
        token, sessionId,
        String(framesByType(sse.frames, 'snapshot-request')[0]!['requestId']),
        ORDER_MANAGE_URL, ORDER_ELEMENTS,
      );
      await sse.waitFor(() => framesByType(sse.frames, 'hitl-request').length === 1);
      await postFrame(token, sessionId, {
        type: 'hitl-decision',
        sessionId,
        hitlId: String(framesByType(sse.frames, 'hitl-request')[0]!['hitlId']),
        decision: 'approve',
      });
      await sse.waitFor(() => framesByType(sse.frames, 'exec-instruction').length === 1);
      const stopped = await api(`/v1/sessions/${sessionId}/stop`, {
        method: 'POST',
        headers: authHeaders(token, { 'content-type': 'application/json' }),
        body: JSON.stringify({ messageId: 'adr024-stop-1' }),
      });
      expect(stopped.status).toBe(202);
      await sse.waitFor(() =>
        framesByType(sse.frames, 'turn-complete').some((f) => f['messageId'] === 'adr024-stop-1'),
      );

      await postFrame(token, sessionId, {
        type: 'user-message', sessionId, text: ORDERS_PROMPT, messageId: 'adr024-stop-2',
      });
      await sse.waitFor(() => framesByType(sse.frames, 'snapshot-request').length === 2);
      await reportSnapshot(
        token, sessionId,
        String(framesByType(sse.frames, 'snapshot-request')[1]!['requestId']),
        ORDER_MANAGE_URL, ORDER_ELEMENTS,
      );
      // 停止已收回自动执行授权：同任务不得凭旧 grant 直接放行。
      await sse.waitFor(() => framesByType(sse.frames, 'hitl-request').length === 2);
      expect(framesByType(sse.frames, 'exec-instruction')).toHaveLength(1);
    } finally {
      sse.close();
      baseUrl = previousBaseUrl;
      await stopServer.close();
    }
  });

  it('快照世代进 dom 判定上下文：toolgate 收到的 domContext.snapshotEpoch 与本次上报同代', async () => {
    const epochServer = await startServer(
      serverOptions({ snapshotRoot: acceptanceRoot, maxTurnRounds: 3 }),
    );
    const previousBaseUrl = baseUrl;
    baseUrl = `http://127.0.0.1:${epochServer.port}`;
    // 端口边界取证：domContext 只在裁决入参里外显，故在端口对象上挂透传观察者而非改被测实现。
    const gate = epochServer.ports.toolgate;
    const realDecide = gate.decide.bind(gate);
    const decideInputs: Array<Parameters<typeof realDecide>[0]> = [];
    gate.decide = async (input) => {
      decideInputs.push(input);
      return realDecide(input);
    };
    const token = await signToken();
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    try {
      await postFrame(token, sessionId, { type: 'context-report', sessionId, url: ORDER_MANAGE_URL });
      await postFrame(token, sessionId, { type: 'user-message', sessionId, text: ORDERS_PROMPT });
      await sse.waitFor(() => framesByType(sse.frames, 'snapshot-request').length === 1);
      await postFrame(token, sessionId, {
        type: 'snapshot-report',
        sessionId,
        requestId: String(framesByType(sse.frames, 'snapshot-request')[0]!['requestId']),
        url: ORDER_MANAGE_URL,
        pageInstanceId: 'page-epoch',
        snapshotEpoch: 7,
        elements: ORDER_ELEMENTS,
      });
      await sse.waitFor(() => framesByType(sse.frames, 'hitl-request').length === 1);
      const withDom = decideInputs.filter((input) => input.domContext !== undefined);
      expect(withDom.length).toBeGreaterThan(0);
      for (const input of withDom) expect(input.domContext?.snapshotEpoch).toBe(7);
    } finally {
      sse.close();
      gate.decide = realDecide;
      baseUrl = previousBaseUrl;
      await epochServer.close();
    }
  });

  it('批准恢复期复核：挂起期间该工具被 L2 收紧到 forbidden → approval-stale 拒绝且不签发指令', async () => {
    const userConfigDir = mkdtempSync(join(tmpdir(), 'za-adr024-l2-'));
    const staleServer = await startServer(
      serverOptions({ snapshotRoot: acceptanceRoot, maxTurnRounds: 3, userConfigDir }),
    );
    const previousBaseUrl = baseUrl;
    baseUrl = `http://127.0.0.1:${staleServer.port}`;
    const token = await signToken();
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    try {
      await postFrame(token, sessionId, { type: 'context-report', sessionId, url: ORDER_MANAGE_URL });
      await postFrame(token, sessionId, { type: 'user-message', sessionId, text: ORDERS_PROMPT });
      await sse.waitFor(() => framesByType(sse.frames, 'snapshot-request').length === 1);
      await reportSnapshot(
        token, sessionId,
        String(framesByType(sse.frames, 'snapshot-request')[0]!['requestId']),
        ORDER_MANAGE_URL, ORDER_ELEMENTS,
      );
      await sse.waitFor(() => framesByType(sse.frames, 'hitl-request').length === 1);
      // 用户在确认卡挂起期间把该工具收紧到 forbidden：批准的是当时那个动作，不是长期通行证。
      await createFsUserConfigStore({ dir: userConfigDir }).write(
        { tenant: 'demo-tenant', hostUserId: 'host-u1' },
        {
          schemaVersion: 1,
          subject: { tenant: 'demo-tenant', hostUserId: 'host-u1' },
          packs: {
            'xianyu-seller': { restrictions: { riskTierRaise: { [ORDERS_TOOL]: 'forbidden' } } },
          },
        },
      );
      await postFrame(token, sessionId, {
        type: 'hitl-decision',
        sessionId,
        hitlId: String(framesByType(sse.frames, 'hitl-request')[0]!['hitlId']),
        decision: 'approve',
      });
      await sse.waitFor(() => lastCardStatus(sse.frames, ORDERS_TOOL) === 'failed');
      expect(framesByType(sse.frames, 'exec-instruction')).toHaveLength(0);
      const decisions = toolDecisions(sessionId, ORDERS_TOOL);
      const stale = decisions[decisions.length - 1]!;
      expect(stale['verdict']).toBe('deny');
      // 归因按 `approval-stale:<底层依据>` 形态落审计：前缀可机械检验，依据保留给排障。
      expect(String(stale['reason'])).toBe('approval-stale:forbidden');
    } finally {
      sse.close();
      baseUrl = previousBaseUrl;
      await staleServer.close();
    }
  });

  it('批准恢复期复核：挂起期间 pack 被关停（工具已不在工具面）→ approval-stale 拒绝且不签发指令', async () => {
    const userConfigDir = mkdtempSync(join(tmpdir(), 'za-adr024-off-'));
    const disabledServer = await startServer(
      serverOptions({ snapshotRoot: acceptanceRoot, maxTurnRounds: 3, userConfigDir }),
    );
    const previousBaseUrl = baseUrl;
    baseUrl = `http://127.0.0.1:${disabledServer.port}`;
    const token = await signToken();
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    try {
      await postFrame(token, sessionId, { type: 'context-report', sessionId, url: ORDER_MANAGE_URL });
      await postFrame(token, sessionId, { type: 'user-message', sessionId, text: ORDERS_PROMPT });
      await sse.waitFor(() => framesByType(sse.frames, 'snapshot-request').length === 1);
      await reportSnapshot(
        token, sessionId,
        String(framesByType(sse.frames, 'snapshot-request')[0]!['requestId']),
        ORDER_MANAGE_URL, ORDER_ELEMENTS,
      );
      await sse.waitFor(() => framesByType(sse.frames, 'hitl-request').length === 1);
      await createFsUserConfigStore({ dir: userConfigDir }).write(
        { tenant: 'demo-tenant', hostUserId: 'host-u1' },
        {
          schemaVersion: 1,
          subject: { tenant: 'demo-tenant', hostUserId: 'host-u1' },
          packs: { 'xianyu-seller': { enabled: false } },
        },
      );
      await postFrame(token, sessionId, {
        type: 'hitl-decision',
        sessionId,
        hitlId: String(framesByType(sse.frames, 'hitl-request')[0]!['hitlId']),
        decision: 'approve',
      });
      await sse.waitFor(() => lastCardStatus(sse.frames, ORDERS_TOOL) === 'failed');
      expect(framesByType(sse.frames, 'exec-instruction')).toHaveLength(0);
      const decisions = toolDecisions(sessionId, ORDERS_TOOL);
      expect(decisions[decisions.length - 1]).toMatchObject({
        verdict: 'deny',
        reason: 'approval-stale',
      });
    } finally {
      sse.close();
      baseUrl = previousBaseUrl;
      await disabledServer.close();
    }
  });

  it('批准恢复期复核：挂起期间用户把本站写进站点黑名单 → approval-stale 拒绝且不签发指令', async () => {
    const userConfigDir = mkdtempSync(join(tmpdir(), 'za-adr024-deny-'));
    const deniedServer = await startServer(
      serverOptions({ snapshotRoot: acceptanceRoot, maxTurnRounds: 3, userConfigDir }),
    );
    const previousBaseUrl = baseUrl;
    baseUrl = `http://127.0.0.1:${deniedServer.port}`;
    const token = await signToken();
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    try {
      await postFrame(token, sessionId, { type: 'context-report', sessionId, url: ORDER_MANAGE_URL });
      await postFrame(token, sessionId, { type: 'user-message', sessionId, text: ORDERS_PROMPT });
      await sse.waitFor(() => framesByType(sse.frames, 'snapshot-request').length === 1);
      await reportSnapshot(
        token, sessionId,
        String(framesByType(sse.frames, 'snapshot-request')[0]!['requestId']),
        ORDER_MANAGE_URL, ORDER_ELEMENTS,
      );
      await sse.waitFor(() => framesByType(sse.frames, 'hitl-request').length === 1);
      // 「不让 Zen 出现在这个站点」与关停 pack 同样收紧：批准的动作所在的工具面已不存在。
      await createFsUserConfigStore({ dir: userConfigDir }).write(
        { tenant: 'demo-tenant', hostUserId: 'host-u1' },
        {
          schemaVersion: 1,
          subject: { tenant: 'demo-tenant', hostUserId: 'host-u1' },
          packs: { '*': { siteDenylist: ['https://seller.goofish.com'] } },
        },
      );
      await postFrame(token, sessionId, {
        type: 'hitl-decision',
        sessionId,
        hitlId: String(framesByType(sse.frames, 'hitl-request')[0]!['hitlId']),
        decision: 'approve',
      });
      await sse.waitFor(() => lastCardStatus(sse.frames, ORDERS_TOOL) === 'failed');
      expect(framesByType(sse.frames, 'exec-instruction')).toHaveLength(0);
      const decisions = toolDecisions(sessionId, ORDERS_TOOL);
      expect(decisions[decisions.length - 1]).toMatchObject({
        verdict: 'deny',
        reason: 'approval-stale',
      });
    } finally {
      sse.close();
      baseUrl = previousBaseUrl;
      await deniedServer.close();
    }
  });
});

describe('B3b — HITL 卡真实性（服务端反解的机械摘要 + R4 五要素）', () => {
  const SEND_TOOL = 'xianyu-fulfillment.send-test-message';
  const IM_URL =
    'https://seller.goofish.com/?site=COMMONPRO#/im?itemId=item-u&orderId=order-u&peerUserId=buyer-u';

  it('dom 确认卡携带服务端反解的 effects/pack/风险行/有效期（用户批准的是「将发生什么」）', async () => {
    const srv = await startServer(serverOptions({ snapshotRoot: acceptanceRoot, maxTurnRounds: 2 }));
    const previousBaseUrl = baseUrl;
    baseUrl = `http://127.0.0.1:${srv.port}`;
    const token = await signToken();
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    try {
      await postFrame(token, sessionId, { type: 'context-report', sessionId, url: IM_URL });
      await postFrame(token, sessionId, { type: 'user-message', sessionId, text: '发送闲鱼测试消息' });
      await sse.waitFor(() => framesByType(sse.frames, 'snapshot-request').length === 1);
      await postFrame(token, sessionId, {
        type: 'snapshot-report',
        sessionId,
        requestId: String(framesByType(sse.frames, 'snapshot-request')[0]!['requestId']),
        url: IM_URL,
        pageInstanceId: 'page-b3b',
        elements: [
          { ref: 'za-message', role: 'textarea', label: '请输入消息' },
          { ref: 'za-send', role: 'button', label: '发 送' },
        ],
      });
      await sse.waitFor(() => framesByType(sse.frames, 'hitl-request').length === 1);
      const hitl = framesByType(sse.frames, 'hitl-request')[0]!;
      expect(hitl['toolId']).toBe(SEND_TOOL);
      // 卡上的动作由 toolgate 净化终值 + 最近快照元素表反解得来，不是模型自述。
      expect(hitl['effects']).toEqual([{ action: '点击', target: '发 送（button）' }]);
      expect(hitl['pack']).toEqual({
        packId: 'xianyu-seller',
        source: 'official',
        origin: 'https://seller.goofish.com',
      });
      expect(hitl['risk']).toBe('将触发页面按钮：一旦触发提交，平台无法为你撤销。');
      expect(hitl['ttlMs']).toBe(60000);
      // pack 默认即需确认：不得谎称是用户自己收紧的。
      expect(hitl['tightenedBy']).toBeUndefined();
      await postFrame(token, sessionId, {
        type: 'hitl-decision',
        sessionId,
        hitlId: String(hitl['hitlId']),
        decision: 'reject',
      });
      await sse.waitFor(() => lastCardStatus(sse.frames, SEND_TOOL) === 'failed');
    } finally {
      sse.close();
      baseUrl = previousBaseUrl;
      await srv.close();
    }
  });

  it('L2 把 auto 收紧到 hitl：卡上标注 tightenedBy=L2，effects 逐字反映 fill 值与目标控件', async () => {
    const userConfigDir = mkdtempSync(join(tmpdir(), 'za-b3b-l2-'));
    await createFsUserConfigStore({ dir: userConfigDir }).write(
      { tenant: 'demo-tenant', hostUserId: 'host-u1' },
      {
        schemaVersion: 1,
        subject: { tenant: 'demo-tenant', hostUserId: 'host-u1' },
        packs: {
          'host-demo': { restrictions: { riskTierRaise: { 'order-list.page-operate': 'hitl' } } },
        },
      },
    );
    const srv = await startServer(serverOptions({ userConfigDir, maxTurnRounds: 2 }));
    const previousBaseUrl = baseUrl;
    baseUrl = `http://127.0.0.1:${srv.port}`;
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
      await sse.waitFor(() => framesByType(sse.frames, 'snapshot-request').length === 1);
      await postFrame(token, sessionId, {
        type: 'snapshot-report',
        sessionId,
        requestId: String(framesByType(sse.frames, 'snapshot-request')[0]!['requestId']),
        url: ORDER_LIST_URL,
        title: '订单列表',
        elements: [
          { ref: 'za-1', role: 'input:text', label: '备注' },
          { ref: 'za-2', role: 'button', label: '保存' },
        ],
      });
      await sse.waitFor(() => framesByType(sse.frames, 'hitl-request').length === 1);
      const hitl = framesByType(sse.frames, 'hitl-request')[0]!;
      expect(hitl['effects']).toEqual([
        { action: '填写', target: '备注（input:text）', valuePreview: 'mock-note' },
        { action: '点击', target: '保存（button）' },
        { action: '读取', target: '备注（input:text）' },
      ]);
      expect(hitl['tightenedBy']).toBe('L2');
      expect(hitl['pack']).toEqual({
        packId: 'host-demo',
        source: 'official',
        origin: 'http://127.0.0.1:4173',
      });
      expect(hitl['risk']).toBe('将写入页面内容并触发页面按钮：一旦触发提交，平台无法为你撤销。');
      await postFrame(token, sessionId, {
        type: 'hitl-decision',
        sessionId,
        hitlId: String(hitl['hitlId']),
        decision: 'reject',
      });
      await sse.waitFor(() => lastCardStatus(sse.frames, 'order-list.page-operate') === 'failed');
    } finally {
      sse.close();
      baseUrl = previousBaseUrl;
      await srv.close();
    }
  });

  it('read 目标是密码框 → 服务端 deny read-sensitive-control，不签发指令、密码值不进模型上下文', async () => {
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
      await postFrame(token, sessionId, {
        type: 'snapshot-report',
        sessionId,
        requestId: String(framesByType(sse.frames, 'snapshot-request')[0]!['requestId']),
        url: ORDER_LIST_URL,
        title: '订单列表',
        elements: [
          { ref: 'za-1', role: 'input:password', label: '登录密码' },
          { ref: 'za-2', role: 'button', label: '保存' },
        ],
      });
      await sse.waitFor(() => lastCardStatus(sse.frames, 'order-list.page-operate') === 'failed');
      expect(framesByType(sse.frames, 'exec-instruction')).toHaveLength(0);
      const decisions = auditEventsFor(sessionId)
        .filter((event) => event['type'] === 'tool-decision')
        .map((event) => event['data'] as Record<string, unknown>)
        .filter((data) => data['toolId'] === 'order-list.page-operate');
      expect(decisions[decisions.length - 1]).toMatchObject({
        verdict: 'deny',
        reason: 'read-sensitive-control',
      });
    } finally {
      sse.close();
    }
  });
});

describe('停止路径的执行结局审计（A-GOV-04：副作用可能已发生即留证）', () => {
  it('指令已下发后停止 → 审计留 tool-execution(dispatched-unknown) 且带 nonce', async () => {
    const token = await signToken();
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    const messageId = 'message-stop-audit';
    let nonce = '';
    try {
      await postFrame(token, sessionId, { type: 'context-report', sessionId, url: ORDER_LIST_URL });
      await postFrame(token, sessionId, {
        type: 'user-message', sessionId, messageId, text: '在页面上刷新订单',
      });
      await sse.waitFor(() => framesByType(sse.frames, 'exec-instruction').length > 0);
      nonce = String(framesByType(sse.frames, 'exec-instruction')[0]!['nonce']);
      const stopped = await api(`/v1/sessions/${sessionId}/stop`, {
        method: 'POST',
        headers: authHeaders(token, { 'content-type': 'application/json' }),
        body: JSON.stringify({ messageId }),
      });
      expect(stopped.status).toBe(202);
      await sse.waitFor(() => sse.frames.some(
        (frame) => frame['type'] === 'turn-complete' && frame['messageId'] === messageId,
      ));
    } finally {
      sse.close();
    }
    const executions = auditEventsFor(sessionId)
      .filter((event) => event['type'] === 'tool-execution')
      .map((event) => event['data'] as Record<string, unknown>);
    expect(executions).toHaveLength(1);
    // 「授权了、指令发了、可能执行了」必须与「授权了但没发指令」在审计流里可分。
    expect(executions[0]).toMatchObject({ outcome: 'dispatched-unknown', nonce, execution: 'client' });
  });

  it('挂起确认期间停止 → hitl-verdict 记 reject 但标注 synthetic:stopped（与用户真实拒绝可分）', async () => {
    const token = await signToken();
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    const messageId = 'message-stop-hitl-audit';
    try {
      await postFrame(token, sessionId, { type: 'context-report', sessionId, url: ORDER_LIST_URL });
      await postFrame(token, sessionId, {
        type: 'user-message', sessionId, messageId, text: '帮我取消订单 ORD-1001',
      });
      await sse.waitFor(() => framesByType(sse.frames, 'hitl-request').length > 0);
      await api(`/v1/sessions/${sessionId}/stop`, {
        method: 'POST',
        headers: authHeaders(token, { 'content-type': 'application/json' }),
        body: JSON.stringify({ messageId }),
      });
      await sse.waitFor(() => sse.frames.some(
        (frame) => frame['type'] === 'turn-complete' && frame['messageId'] === messageId,
      ));
    } finally {
      sse.close();
    }
    const events = auditEventsFor(sessionId);
    const verdict = events.find((event) => event['type'] === 'hitl-verdict')!['data'] as Record<string, unknown>;
    expect(verdict).toMatchObject({ decision: 'reject', synthetic: 'stopped' });
    // 中断发生在签发之前：零副作用，故不得凭空补执行事件。
    expect(events.some((event) => event['type'] === 'tool-execution')).toBe(false);
  });

  it('用户在确认卡上真实拒绝 → hitl-verdict 不带 synthetic（对照）', async () => {
    const token = await signToken();
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    try {
      await postFrame(token, sessionId, { type: 'context-report', sessionId, url: ORDER_LIST_URL });
      await postFrame(token, sessionId, { type: 'user-message', sessionId, text: '帮我取消订单 ORD-1001' });
      await sse.waitFor(() => framesByType(sse.frames, 'hitl-request').length > 0);
      const hitl = framesByType(sse.frames, 'hitl-request')[0]!;
      await postFrame(token, sessionId, {
        type: 'hitl-decision', sessionId, hitlId: String(hitl['hitlId']), decision: 'reject',
      });
      await sse.waitFor(() => sse.frames.some((frame) => frame['type'] === 'turn-complete'));
    } finally {
      sse.close();
    }
    const verdict = auditEventsFor(sessionId)
      .find((event) => event['type'] === 'hitl-verdict')!['data'] as Record<string, unknown>;
    expect(verdict['decision']).toBe('reject');
    expect(verdict['synthetic']).toBeUndefined();
  });
});

/**
 * adr-024 D1：人工回合的确认卡在无人裁决时不得永久挂起——串行链会被该会话后续消息一直等下去。
 * 上限只在 env 显式配置时启用，故两条用例分别钉住「未配置＝与基线严格等价」与「配置后到期收口」。
 */
describe('HITL 挂起等待上限（adr-024 D1）', () => {
  const HITL_TIMEOUT_ENV = 'ZA_HITL_TIMEOUT_MS';

  it('未设 ZA_HITL_TIMEOUT_MS → 等待无上限：远超上限时长后裁决仍被接受并签发指令', async () => {
    expect(process.env[HITL_TIMEOUT_ENV]).toBeUndefined();
    const token = await signToken();
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    try {
      await postFrame(token, sessionId, { type: 'context-report', sessionId, url: ORDER_LIST_URL });
      await postFrame(token, sessionId, { type: 'user-message', sessionId, text: '帮我取消订单 ORD-1001' });
      await sse.waitFor(() => framesByType(sse.frames, 'hitl-request').length > 0);
      const hitl = framesByType(sse.frames, 'hitl-request')[0]!;
      // 静置远超启用态用例所用的 150ms 上限：等待器仍在＝未装计时器。
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(lastCardStatus(sse.frames, 'order-list.cancel-order')).toBe('running');
      const decided = await postFrame(token, sessionId, {
        type: 'hitl-decision', sessionId, hitlId: String(hitl['hitlId']), decision: 'approve',
      });
      expect(decided.status).toBe(202);
      await sse.waitFor(() => framesByType(sse.frames, 'exec-instruction').length > 0);
    } finally {
      sse.close();
    }
  });

  it('设 ZA_HITL_TIMEOUT_MS → 到期合成 reject：不签发指令、回喂 hitl-timeout、审计可与用户拒绝区分、迟到裁决 409', async () => {
    const previousEnv = process.env[HITL_TIMEOUT_ENV];
    process.env[HITL_TIMEOUT_ENV] = '150';
    const timeoutServer = await startServer(serverOptions());
    const previousBaseUrl = baseUrl;
    baseUrl = `http://127.0.0.1:${timeoutServer.port}`;
    const token = await signToken();
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    try {
      await postFrame(token, sessionId, { type: 'context-report', sessionId, url: ORDER_LIST_URL });
      await postFrame(token, sessionId, { type: 'user-message', sessionId, text: '帮我取消订单 ORD-1001' });
      await sse.waitFor(() => framesByType(sse.frames, 'hitl-request').length > 0);
      const hitl = framesByType(sse.frames, 'hitl-request')[0]!;
      await sse.waitFor(() => lastCardStatus(sse.frames, 'order-list.cancel-order') === 'failed');
      expect(framesByType(sse.frames, 'exec-instruction')).toHaveLength(0);
      const late = await postFrame(token, sessionId, {
        type: 'hitl-decision', sessionId, hitlId: String(hitl['hitlId']), decision: 'approve',
      });
      expect(late.status).toBe(409);
      await sse.waitFor(() => sse.frames.some((frame) => frame['type'] === 'turn-complete'));
      // 回喂给模型的是 hitl-timeout（非 user-rejected）：mock 据失败类别收尾，不得谎称已取消订单。
      expect(textOf(sse.frames)).toBe('操作未成功完成。');
    } finally {
      sse.close();
      baseUrl = previousBaseUrl;
      await timeoutServer.close();
      if (previousEnv === undefined) delete process.env[HITL_TIMEOUT_ENV];
      else process.env[HITL_TIMEOUT_ENV] = previousEnv;
    }
    const events = auditEventsFor(sessionId);
    const verdict = events.find((event) => event['type'] === 'hitl-verdict')!['data'] as Record<string, unknown>;
    expect(verdict['decision']).toBe('reject');
    const denies = events
      .filter((event) => event['type'] === 'tool-decision')
      .map((event) => event['data'] as Record<string, unknown>)
      .filter((data) => data['verdict'] === 'deny');
    expect(denies.some((data) => data['reason'] === 'hitl-timeout')).toBe(true);
    // 到期发生在签发之前：零副作用，不得凭空补执行事件。
    expect(events.some((event) => event['type'] === 'tool-execution')).toBe(false);
  });
});

/**
 * A-SUP-01/02 端到端：用户偏好与 pack 声明的可配置点必须真的出现在送达 LLM 的 system 里，
 * 而不只是 compose 返回了字段——断言点是捕获式 mock 收到的 system 文本本身。
 */
describe('L2 用户塑形贯通注入：回答详略偏好与站点包设置进 system（A-SUP-01/A-SUP-02）', () => {
  let capturing: CapturingMock;
  let shapedServer: RunningServer;
  let prevBaseUrl: string | undefined;
  const userConfigDir = mkdtempSync(join(tmpdir(), 'za-shaping-store-'));
  const shapedSnapshotRoot = mkdtempSync(join(tmpdir(), 'za-shaping-snapshot-'));

  beforeAll(async () => {
    // host-demo 快照的等价副本 + pack 声明 configSchema：packConfig 的注入面只能来自 pack 作者声明。
    cpSync(snapshotRoot, shapedSnapshotRoot, { recursive: true });
    const packJsonPath = join(shapedSnapshotRoot, 'packs/host-demo/pack.json');
    const packJson = JSON.parse(readFileSync(packJsonPath, 'utf8')) as Record<string, unknown>;
    packJson['configSchema'] = {
      type: 'object',
      properties: { shippingTemplate: { type: 'string' } },
      additionalProperties: false,
    };
    writeFileSync(packJsonPath, JSON.stringify(packJson));

    await createFsUserConfigStore({ dir: userConfigDir }).write(
      { tenant: 'demo-tenant', hostUserId: 'host-u1' },
      {
        schemaVersion: 1,
        subject: { tenant: 'demo-tenant', hostUserId: 'host-u1' },
        packs: {
          '*': { preferences: { verbosity: 'concise' } },
          'host-demo': { packConfig: { shippingTemplate: '江浙沪包邮模板' } },
        },
      },
    );
    capturing = await startCapturingMock();
    prevBaseUrl = process.env['ZA_LLM_BASE_URL'];
    process.env['ZA_LLM_BASE_URL'] = `http://127.0.0.1:${capturing.port}/v1`;
    shapedServer = await startServer(
      serverOptions({ userConfigDir, snapshotRoot: shapedSnapshotRoot }),
    );
  });

  afterAll(async () => {
    await shapedServer?.close();
    await capturing?.close();
    if (prevBaseUrl !== undefined) process.env['ZA_LLM_BASE_URL'] = prevBaseUrl;
  });

  it('送达 LLM 的 system 含详略指令与站点包设置值；/injection 同轮出对应块', async () => {
    capturing.requests.length = 0;
    const token = await signToken();
    const base = `http://127.0.0.1:${shapedServer.port}`;
    const created = await fetch(`${base}/v1/sessions`, { method: 'POST', headers: authHeaders(token) });
    const { sessionId } = (await created.json()) as { sessionId: string };
    const post = (frame: Record<string, unknown>): Promise<Response> =>
      fetch(`${base}/v1/sessions/${sessionId}/frames`, {
        method: 'POST',
        headers: authHeaders(token, { 'content-type': 'application/json' }),
        body: JSON.stringify(frame),
      });
    await post({ type: 'context-report', sessionId, url: ORDER_LIST_URL });
    await post({ type: 'user-message', sessionId, text: '你好' });
    const deadline = Date.now() + 8000;
    while (capturing.requests.length === 0) {
      if (Date.now() > deadline) throw new Error('等待 LLM 调用捕获超时');
      await new Promise((r) => setTimeout(r, 25));
    }
    const req = capturing.requests[capturing.requests.length - 1]!;
    const messages = (req['messages'] ?? []) as Array<{ role: string; content: string }>;
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    expect(system).toContain('用户偏好');
    expect(system).toContain('简洁');
    expect(system).toContain('站点包设置');
    expect(system).toContain('shippingTemplate');
    expect(system).toContain('江浙沪包邮模板');

    const injection = await fetch(`${base}/v1/sessions/${sessionId}/injection`, {
      headers: authHeaders(token),
    });
    expect(injection.status).toBe(200);
    const view = (await injection.json()) as {
      reason?: string;
      blocks?: Array<{ kind: string; id?: string }>;
    };
    expect(view.reason).toBe('pack');
    expect((view.blocks ?? []).filter((b) => b.kind === 'user-preferences').map((b) => b.id)).toEqual([
      'verbosity',
    ]);
    expect((view.blocks ?? []).filter((b) => b.kind === 'pack-config').map((b) => b.id)).toEqual([
      'shippingTemplate',
    ]);
  });
});

/**
 * L2 站点黑名单的服务端终判（R3/R8）：用户把某站点写进黑名单后，该 origin 上不装配任何站点包。
 * 判定只在 compose（U7 决策服务端），客户端跳过激活至多是少上报一次；审计以 siteDenied 标注归因，
 * 使「本页治理面为何是空的」在审计流里与「本站没有 pack」区分得开。
 */
describe('L2 站点黑名单：命中站点回落仅基座并落审计标注（R3/R8）', () => {
  const userConfigDir = mkdtempSync(join(tmpdir(), 'za-site-deny-'));
  // 名单只收紧命中的 origin：快照根在 host-demo（命中侧）之外再放一个不同 origin 的站点包，
  // 未命中侧才有「确实装出了 pack 与工具面」可断言——否则装配整体崩掉时该用例同样会绿。
  const deniedSnapshotRoot = mkdtempSync(join(tmpdir(), 'za-site-deny-config-'));
  const ALLOWED_PACK_URL = 'https://www.zhipin.com/web/geek/job?query=backend';
  let deniedServer: RunningServer;

  beforeAll(async () => {
    cpSync(snapshotRoot, deniedSnapshotRoot, { recursive: true });
    cpSync(join(acceptanceRoot, 'packs/zhipin'), join(deniedSnapshotRoot, 'packs/zhipin'), { recursive: true });
    const manifestPath = join(deniedSnapshotRoot, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      packs: Array<{ packId: string; version: string }>;
    };
    manifest.packs.push({ packId: 'zhipin', version: '0.1.0' });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    await createFsUserConfigStore({ dir: userConfigDir }).write(
      { tenant: 'demo-tenant', hostUserId: 'host-u1' },
      {
        schemaVersion: 1,
        subject: { tenant: 'demo-tenant', hostUserId: 'host-u1' },
        packs: { '*': { siteDenylist: ['http://127.0.0.1:4173'] } },
      },
    );
    deniedServer = await startServer(serverOptions({ userConfigDir, snapshotRoot: deniedSnapshotRoot }));
  });

  afterAll(async () => {
    await deniedServer?.close();
  });

  /** 跑一轮人工回合并取本轮 assembly 审计事件（装配面的唯一可判读产物）。 */
  async function assemblyEventOf(token: string, url: string): Promise<Record<string, unknown>> {
    const sessionId = await createSession(token);
    await postFrame(token, sessionId, { type: 'context-report', sessionId, url });
    await postFrame(token, sessionId, { type: 'user-message', sessionId, text: '这个页面能做什么' });
    const deadline = Date.now() + 8000;
    for (;;) {
      const found = auditEventsFor(sessionId).find((event) => event['type'] === 'assembly');
      if (found !== undefined) return found;
      if (Date.now() > deadline) throw new Error('等待 assembly 审计事件超时');
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it('黑名单站点：packId 回落 null、工具面为空、assembly 事件带 siteDenied', async () => {
    const token = await signToken();
    const baseline = await assemblyEventOf(token, ORDER_LIST_URL);
    // 对照组（无 L2 黑名单的共享 server）：同一 URL 本应装出站点工具面，否则本用例恒真。
    expect((baseline['data'] as { toolIds: string[] }).toolIds.length).toBeGreaterThan(0);
    expect(baseline['packId']).toBeTruthy();

    const previousBaseUrl = baseUrl;
    baseUrl = `http://127.0.0.1:${deniedServer.port}`;
    try {
      const denied = await assemblyEventOf(token, ORDER_LIST_URL);
      const data = denied['data'] as Record<string, unknown>;
      expect(data['siteDenied']).toBe(true);
      expect(data['toolIds']).toEqual([]);
      // 「不让 Zen 出现在这个站点」不是「用户关停了这个 pack」：两种归因不可互相冒充。
      expect(data['packDisabled']).toBeUndefined();
      expect(data['disabledPackId']).toBeUndefined();
      expect(denied['packId']).toBeUndefined();
    } finally {
      baseUrl = previousBaseUrl;
    }
  });

  /**
   * 注入自省是面板「本页生效」块的唯一数据源：黑名单命中轮实际已是仅基座，
   * 该端点若仍报 reason='pack'，面板会显示一条不存在的事实（R6 如实呈现）。
   */
  it('注入自省端点如实标注 site-denied（面板不显示「站点包激活中」）', async () => {
    const token = await signToken();
    const previousBaseUrl = baseUrl;
    baseUrl = `http://127.0.0.1:${deniedServer.port}`;
    try {
      const sessionId = await createSession(token);
      await postFrame(token, sessionId, { type: 'context-report', sessionId, url: ORDER_LIST_URL });
      const denied = await getInjection(token, sessionId);
      expect(denied['reason']).toBe('site-denied');
      expect(denied['packId']).toBeNull();
      expect(denied['toolIds']).toEqual([]);
      // 功能行同守：本轮没装配任何功能，报一条 featureId 与报「站点包激活中」同属载体说谎。
      expect(denied['featureId']).toBeNull();
    } finally {
      baseUrl = previousBaseUrl;
    }
    // 对照组（无黑名单的共享 server）：同一 URL 的自省本应报站点包，否则上面的断言恒真。
    const sessionId = await createSession(token);
    await postFrame(token, sessionId, { type: 'context-report', sessionId, url: ORDER_LIST_URL });
    const baseline = await getInjection(token, sessionId);
    expect(baseline['reason']).toBe('pack');
    expect(baseline['featureId']).toBe('order-list');
    expect((baseline['toolIds'] as string[]).length).toBeGreaterThan(0);
  });

  it('未落在黑名单的站点照常装配（黑名单只收紧命中的 origin）', async () => {
    const token = await signToken();
    const previousBaseUrl = baseUrl;
    baseUrl = `http://127.0.0.1:${deniedServer.port}`;
    try {
      const event = await assemblyEventOf(token, ALLOWED_PACK_URL);
      const data = event['data'] as Record<string, unknown>;
      expect(data['siteDenied']).toBeUndefined();
      // 正向断言：同一台带名单的 server 上，未命中 origin 确实装出了该站点包与它的工具面。
      // 只断言 siteDenied 缺省时，装配整体崩掉（无 pack 命中、工具面为空）同样会绿。
      expect(event['packId']).toBe('zhipin');
      expect(event['featureId']).toBe('job-search');
      expect((data['toolIds'] as string[]).length).toBeGreaterThan(0);
    } finally {
      baseUrl = previousBaseUrl;
    }
  });
});

interface WireMessage {
  role: string;
  content?: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; function: { name: string } }>;
}

/** 自 from 起第 n 个上游请求的 messages（送到模型面前的实际视图）。 */
function requestMessagesAt(index: number): WireMessage[] {
  const raw = mock.requests[index];
  if (raw === undefined) throw new Error(`第 ${index} 个上游请求不存在`);
  return (JSON.parse(raw) as { messages: WireMessage[] }).messages;
}

function lastTurnComplete(frames: Array<Record<string, unknown>>): Record<string, unknown> {
  const done = framesByType(frames, 'turn-complete');
  return done[done.length - 1] ?? {};
}

describe('编排韧性：并行调用 / 未知工具 / 失败预算 / 终止原因', () => {
  it('一次响应两个 tool_calls：按序逐个执行，回声携带全部调用，无静默丢弃', async () => {
    const token = await signToken();
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    const requestsBefore = mock.requests.length;
    try {
      await postFrame(token, sessionId, { type: 'context-report', sessionId, url: ORDER_LIST_URL });
      await postFrame(token, sessionId, {
        type: 'user-message',
        sessionId,
        text: '模拟并行调用 刷新订单列表',
      });
      await sse.waitFor(() => framesByType(sse.frames, 'exec-instruction').length === 1);
      const first = framesByType(sse.frames, 'exec-instruction')[0]!;
      await postFrame(token, sessionId, {
        type: 'exec-result',
        sessionId,
        nonce: String(first['nonce']),
        ok: true,
        status: 200,
        body: { ok: true, count: 2 },
      });
      // 第二个调用不需要模型再发一轮：同一轮响应内按序继续分发。
      await sse.waitFor(() => framesByType(sse.frames, 'exec-instruction').length === 2);
      const second = framesByType(sse.frames, 'exec-instruction')[1]!;
      expect(second['toolCallId']).not.toBe(first['toolCallId']);
      await postFrame(token, sessionId, {
        type: 'exec-result',
        sessionId,
        nonce: String(second['nonce']),
        ok: true,
        status: 200,
        body: { ok: true, count: 2 },
      });
      await sse.waitFor(() => framesByType(sse.frames, 'turn-complete').length > 0);
      // 回喂视图：一条 assistant 回声携带两个 tool_calls，其后两条 role:tool 观测各自成对。
      const messages = requestMessagesAt(mock.requests.length - 1);
      const echo = messages.find((m) => (m.tool_calls?.length ?? 0) === 2);
      expect(echo, JSON.stringify(messages.map((m) => m.role))).toBeDefined();
      const answered = new Set(messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
      for (const call of echo!.tool_calls!) expect(answered.has(call.id)).toBe(true);
      expect(mock.requests.length).toBeGreaterThan(requestsBefore);
    } finally {
      sse.close();
    }
  });

  it('用户停止后同一轮剩余调用零分发：不再发 snapshot-request，剩余调用回喂 not-executed/user-stopped', async () => {
    // 快照等待器缩短到 300ms：缺陷态下第二个调用会真的发帧并等待，短超时让红/绿差异快速可判。
    const stopServer = await startServer(serverOptions({ snapshotTimeoutMs: 300 }));
    const previousBaseUrl = baseUrl;
    baseUrl = `http://127.0.0.1:${stopServer.port}`;
    const token = await signToken();
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    try {
      await postFrame(token, sessionId, { type: 'context-report', sessionId, url: ORDER_LIST_URL });
      await postFrame(token, sessionId, {
        type: 'user-message',
        sessionId,
        messageId: 'msg-stop-rest',
        text: '模拟停止后剩余调用 刷新订单列表',
      });
      await sse.waitFor(() => framesByType(sse.frames, 'exec-instruction').length === 1);
      const snapshotsBefore = framesByType(sse.frames, 'snapshot-request').length;
      const stopped = await api(`/v1/sessions/${sessionId}/stop`, {
        method: 'POST',
        headers: authHeaders(token, { 'content-type': 'application/json' }),
        body: JSON.stringify({ messageId: 'msg-stop-rest' }),
      });
      expect(stopped.status).toBe(202);
      await sse.waitFor(() =>
        framesByType(sse.frames, 'turn-complete').some((f) => f['messageId'] === 'msg-stop-rest'),
      );
      expect(lastTurnComplete(sse.frames)['reason']).toBe('stopped');
      // 停止＝立刻收手：排在后面的内建调用不得再向页面发帧。
      expect(framesByType(sse.frames, 'snapshot-request')).toHaveLength(snapshotsBefore);
      // 未执行的调用如实回喂（不静默丢弃）：下一回合请求视图里该 toolCallId 有成对观测。
      await postFrame(token, sessionId, {
        type: 'user-message',
        sessionId,
        messageId: 'msg-stop-rest-next',
        text: '今天天气怎么样',
      });
      await sse.waitFor(() =>
        framesByType(sse.frames, 'turn-complete').some((f) => f['messageId'] === 'msg-stop-rest-next'),
      );
      const messages = requestMessagesAt(mock.requests.length - 1);
      const skipped = messages.find((m) => m.role === 'tool' && m.tool_call_id === 'call_stop_2');
      expect(skipped, JSON.stringify(messages.map((m) => `${m.role}:${m.tool_call_id ?? ''}`))).toBeDefined();
      expect(JSON.parse(skipped!.content ?? '{}')).toMatchObject({
        error: 'not-executed',
        reason: 'user-stopped',
      });
    } finally {
      sse.close();
      baseUrl = previousBaseUrl;
      await stopServer.close();
    }
  });

  it('工具面外的幻觉工具名：回喂 tool-not-available 观测而非终结回合，含可用工具名列表', async () => {
    const token = await signToken();
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    try {
      await postFrame(token, sessionId, { type: 'context-report', sessionId, url: ORDER_LIST_URL });
      await postFrame(token, sessionId, {
        type: 'user-message',
        sessionId,
        text: '模拟未知工具 帮我处理一下',
      });
      await sse.waitFor(() => framesByType(sse.frames, 'turn-complete').length > 0);
      // 回合内至少发生过一次「回喂后继续」：模型看到了 role:tool 的 tool-not-available 观测。
      const withObs = mock.requests
        .map((raw) => (JSON.parse(raw) as { messages: WireMessage[] }).messages)
        .filter((messages) =>
          messages.some(
            (m) => m.role === 'tool' && (m.content ?? '').includes('tool-not-available'),
          ),
        );
      expect(withObs.length).toBeGreaterThan(0);
      const obs = withObs[0]!.find(
        (m) => m.role === 'tool' && (m.content ?? '').includes('tool-not-available'),
      )!;
      const parsed = JSON.parse(obs.content ?? '{}') as { error: string; available?: string[] };
      expect(parsed.error).toBe('tool-not-available');
      expect(parsed.available).toContain('order-list.refresh-orders');
      // 幻觉调用不产生任何代执行
      expect(framesByType(sse.frames, 'exec-instruction')).toHaveLength(0);
      expect(textOf(sse.frames)).toContain('该操作暂未支持。');
    } finally {
      sse.close();
    }
  });

  it('同工具同因连续失败达硬阈值：回合终结，turn-complete.reason=consecutive-failures', async () => {
    const token = await signToken();
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    try {
      await postFrame(token, sessionId, { type: 'context-report', sessionId, url: ORDER_LIST_URL });
      await postFrame(token, sessionId, {
        type: 'user-message',
        sessionId,
        messageId: 'msg-consecutive-fail',
        text: '模拟未知工具 帮我处理一下',
      });
      await sse.waitFor(() => framesByType(sse.frames, 'turn-complete').length > 0);
      expect(lastTurnComplete(sse.frames)['reason']).toBe('consecutive-failures');
      expect(textOf(sse.frames)).toContain('连续失败');
      // 硬阈值 3：轮数远未耗尽（maxTurnRounds 默认 12）就已止损
      const ghostRounds = mock.requests.filter((raw) => raw.includes('ghost_tool')).length;
      expect(ghostRounds).toBeLessThanOrEqual(4);
    } finally {
      sse.close();
    }
  });

  it('正常收尾的回合带 reason=completed', async () => {
    const token = await signToken();
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    try {
      await postFrame(token, sessionId, { type: 'context-report', sessionId, url: ORDER_LIST_URL });
      await postFrame(token, sessionId, {
        type: 'user-message',
        sessionId,
        messageId: 'msg-completed-reason',
        text: '这个页面显示的是什么',
      });
      await sse.waitFor(() => framesByType(sse.frames, 'turn-complete').length > 0);
      expect(lastTurnComplete(sse.frames)['reason']).toBe('completed');
    } finally {
      sse.close();
    }
  });

  it('元素清单被配额截断：截断事实进回喂观测（与 textTruncated 同口径），模型不得据此断言控件不存在', async () => {
    const token = await signToken();
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    try {
      await postFrame(token, sessionId, { type: 'context-report', sessionId, url: ORDER_LIST_URL });
      await postFrame(token, sessionId, {
        type: 'user-message',
        sessionId,
        text: '模拟连续快照 观察这一页',
      });
      for (let round = 1; round <= 3; round += 1) {
        await sse.waitFor(() => framesByType(sse.frames, 'snapshot-request').length === round);
        const request = framesByType(sse.frames, 'snapshot-request')[round - 1]!;
        await postFrame(token, sessionId, {
          type: 'snapshot-report',
          sessionId,
          requestId: String(request['requestId']),
          url: ORDER_LIST_URL,
          title: `截断快照 第${round}次`,
          elements: [{ ref: `za-t${round}`, role: 'button', label: `按钮${round}` }],
          elementsTruncated: true,
          elementsOmitted: 42,
        });
      }
      await sse.waitFor(() => framesByType(sse.frames, 'turn-complete').length > 0);
      const messages = requestMessagesAt(mock.requests.length - 1);
      const obs = messages.find(
        (m) => m.role === 'tool' && (m.content ?? '').includes('截断快照 第3次'),
      );
      expect(obs, JSON.stringify(messages.map((m) => m.role))).toBeDefined();
      const body = JSON.parse(obs!.content ?? '{}') as {
        elementsTruncated?: boolean;
        elementsOmitted?: number;
        elementsNote?: string;
      };
      expect(body.elementsTruncated).toBe(true);
      expect(body.elementsOmitted).toBe(42);
      expect(body.elementsNote).toContain('不完整');
    } finally {
      sse.close();
    }
  });

  it('同回合多次快照：每轮请求视图只保留最近一份快照全文，更早的替换为存根', async () => {
    const token = await signToken();
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    try {
      await postFrame(token, sessionId, { type: 'context-report', sessionId, url: ORDER_LIST_URL });
      await postFrame(token, sessionId, {
        type: 'user-message',
        sessionId,
        text: '模拟连续快照 观察这一页',
      });
      for (let round = 1; round <= 3; round += 1) {
        await sse.waitFor(() => framesByType(sse.frames, 'snapshot-request').length === round);
        const request = framesByType(sse.frames, 'snapshot-request')[round - 1]!;
        await postFrame(token, sessionId, {
          type: 'snapshot-report',
          sessionId,
          requestId: String(request['requestId']),
          url: ORDER_LIST_URL,
          title: `订单列表 第${round}次`,
          elements: [{ ref: `za-${round}`, role: 'button', label: `按钮${round}` }],
        });
      }
      await sse.waitFor(() => framesByType(sse.frames, 'turn-complete').length > 0);
      const messages = requestMessagesAt(mock.requests.length - 1);
      const snapshotObs = messages.filter(
        (m) => m.role === 'tool' && (m.content ?? '').includes('订单列表 第'),
      );
      expect(snapshotObs).toHaveLength(1);
      expect(snapshotObs[0]!.content).toContain('第3次');
      const stubs = messages.filter((m) => m.role === 'tool' && (m.content ?? '').includes('快照已过期'));
      expect(stubs).toHaveLength(2);
    } finally {
      sse.close();
    }
  });
});

describe('上游失败分类如实呈现（R6/SEC-04）', () => {
  async function withUpstream(
    handle: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void,
    run: (sessionId: string, token: string, sse: SseHandle) => Promise<void>,
  ): Promise<void> {
    const upstream = createServer(handle);
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address();
    if (address === null || typeof address === 'string') throw new Error('无法获取上游端口');
    const savedBaseUrl = process.env['ZA_LLM_BASE_URL'];
    const token = await signToken();
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    try {
      process.env['ZA_LLM_BASE_URL'] = `http://127.0.0.1:${address.port}/v1`;
      await run(sessionId, token, sse);
    } finally {
      process.env['ZA_LLM_BASE_URL'] = savedBaseUrl;
      sse.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  }

  it('上游 401：告知模型服务配置问题而非「服务暂时不可用」，且不回显响应体与凭证形态', async () => {
    await withUpstream(
      (_req, res) => {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Incorrect API key provided: xk-canary-value' } }));
      },
      async (sessionId, token, sse) => {
        await postFrame(token, sessionId, {
          type: 'user-message',
          sessionId,
          messageId: 'msg-upstream-auth',
          text: '订单能取消吗',
        });
        await sse.waitFor(() => framesByType(sse.frames, 'turn-complete').length > 0);
        const text = textOf(sse.frames);
        expect(text).toContain('模型服务配置');
        expect(text).not.toContain('服务暂时不可用');
        expect(text).not.toContain('xk-canary-value');
        expect(text).not.toContain('Bearer');
        expect(lastTurnComplete(sse.frames)['reason']).toBe('llm-error');
      },
    );
  });

  it('上游因输出上限截断回答：尾部如实告知被截断', async () => {
    await withUpstream(
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '这是半句' }, finish_reason: null }] })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] })}\n\n`,
        );
        res.write('data: [DONE]\n\n');
        res.end();
      },
      async (sessionId, token, sse) => {
        await postFrame(token, sessionId, {
          type: 'user-message',
          sessionId,
          messageId: 'msg-upstream-truncated',
          text: '讲讲这个页面',
        });
        await sse.waitFor(() => framesByType(sse.frames, 'turn-complete').length > 0);
        const text = textOf(sse.frames);
        expect(text).toContain('这是半句');
        expect(text).toContain('被截断');
        expect(lastTurnComplete(sse.frames)['reason']).toBe('completed');
      },
    );
  });
});
