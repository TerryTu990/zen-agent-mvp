/**
 * 导航落点接入保障与 already-open 止损（adr-027 §4 补记）：
 *  - 非定向 open_url 成功后回喂前等落点页接入，observation 附 attached 与指引；
 *  - 同会话对同一地址、组内该地址的页仍 silent 时再次 open_url → 服务端 deny（不弹卡）并记审计；
 *  - 该页接入后同地址导航恢复放行（弹卡）。
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../src/index.js';

const repoRoot = new URL('../../../', import.meta.url).pathname;
const snapshotRoot = join(repoRoot, 'examples/acceptance');
const systemPromptPath = join(repoRoot, 'assets/system-prompt.md');
const AUDIT_SINK = join(mkdtempSync(join(tmpdir(), 'za-nav-attach-audit-')), 'events.jsonl');

const JWT_SECRET = 'za-test-secret';
const SIGNING_SECRET = 'za-test-signing-secret';
const ISS = 'zen-agent-demo';
const key = new TextEncoder().encode(JWT_SECRET);

const GENERIC_URL = 'http://127.0.0.1:4173/order-list.html';
const OPEN_TARGET = 'https://news.example/article?id=7';
/** 等落点接入的上限：足够短让「未接入」路径不拖慢用例，足够长让上报能在窗内落表。 */
const ATTACH_WAIT_MS = 400;

let scripted: { port: number; close(): Promise<void> };
let server: RunningServer;
let base = '';
let prevBaseUrl: string | undefined;

/**
 * 脚本化 mock：每个用户轮（自最近一条 user 消息起尚无 tool 观察）产出一次 open_url；
 * 观察到达后把最后一条 observation 原样回显（MOCK-NAV-OBS 前缀）。
 */
function startScriptedMock(): Promise<{ port: number; close(): Promise<void> }> {
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
      let body: { messages?: Array<{ role?: string; content?: unknown }> };
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        body = {};
      }
      const messages = body.messages ?? [];
      // 用户轮起点只认真实用户消息：导航换站后注入的站点边界标记也是 user 角色，不计回合。
      let lastUserIndex = -1;
      messages.forEach((m, index) => {
        if (m.role === 'user' && !String(m.content ?? '').startsWith('【站点边界】')) lastUserIndex = index;
      });
      const observation = messages.slice(lastUserIndex + 1).find((m) => m.role === 'tool');
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const chunkBase = { id: 'x', object: 'chat.completion.chunk', created: 0, model: 'mock-model' };
      const send = (choice: unknown): void => {
        res.write(`data: ${JSON.stringify({ ...chunkBase, choices: [choice] })}\n\n`);
      };
      send({ index: 0, delta: { role: 'assistant' }, finish_reason: null });
      if (observation !== undefined) {
        send({
          index: 0,
          delta: { content: `MOCK-NAV-OBS ${String(observation.content ?? '')}` },
          finish_reason: null,
        });
        send({ index: 0, delta: {}, finish_reason: 'stop' });
      } else {
        send({
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: `call_open_url_${messages.length}`,
                type: 'function',
                function: {
                  name: 'open_url',
                  arguments: JSON.stringify({ url: OPEN_TARGET, task: '打开新闻', reason: '查看新闻' }),
                },
              },
            ],
          },
          finish_reason: null,
        });
        send({ index: 0, delta: {}, finish_reason: 'tool_calls' });
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve({ port, close: () => new Promise((r) => httpServer.close(() => r())) });
    });
  });
}

beforeAll(async () => {
  scripted = await startScriptedMock();
  prevBaseUrl = process.env['ZA_LLM_BASE_URL'];
  process.env['ZA_LLM_BASE_URL'] = `http://127.0.0.1:${scripted.port}/v1`;
  process.env['ZA_LLM_MODEL'] = 'mock-model';
  server = await startServer({
    port: 0,
    jwtSecret: JWT_SECRET,
    signingSecret: SIGNING_SECRET,
    issAllowlist: [ISS],
    snapshotRoot,
    systemPromptPath,
    auditSinkPath: AUDIT_SINK,
    allowedProviders: ['openai-compatible'],
    heartbeatMs: 60_000,
    navAttachWaitMs: ATTACH_WAIT_MS,
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server?.close();
  await scripted?.close();
  if (prevBaseUrl !== undefined) process.env['ZA_LLM_BASE_URL'] = prevBaseUrl;
});

async function signToken(): Promise<string> {
  return new SignJWT({ tenant: 'demo-tenant', roles: ['ops'], hostUserId: 'host-u1' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('user-1')
    .setIssuer(ISS)
    .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
    .sign(key);
}

function authHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...extra };
}

async function createSession(token: string): Promise<string> {
  const res = await fetch(`${base}/v1/sessions`, { method: 'POST', headers: authHeaders(token) });
  expect(res.status).toBe(201);
  return ((await res.json()) as { sessionId: string }).sessionId;
}

async function postFrame(token: string, sessionId: string, frame: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${base}/v1/sessions/${encodeURIComponent(sessionId)}/frames`, {
    method: 'POST',
    headers: authHeaders(token, { 'content-type': 'application/json' }),
    body: JSON.stringify(frame),
  });
  expect([202, 204]).toContain(res.status);
}

interface SseHandle {
  frames: Array<Record<string, unknown>>;
  waitFor(predicate: () => boolean, timeoutMs?: number): Promise<void>;
  close(): void;
}

async function openSse(token: string, sessionId: string): Promise<SseHandle> {
  const controller = new AbortController();
  const response = await fetch(`${base}/v1/sessions/${encodeURIComponent(sessionId)}/events`, {
    headers: authHeaders(token),
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
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

function framesByType(frames: Array<Record<string, unknown>>, type: string): Array<Record<string, unknown>> {
  return frames.filter((frame) => frame['type'] === type);
}

function joinedText(sse: SseHandle): string {
  return framesByType(sse.frames, 'text-delta')
    .map((frame) => String(frame['delta']))
    .join('');
}

function auditEventsFor(sessionId: string): Array<Record<string, unknown>> {
  return readFileSync(AUDIT_SINK, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((event) => event['sessionId'] === sessionId);
}

/** 发一轮用户消息并走完 open_url 的 hitl 批准 + 指令回执；返回本轮 hitl 卡（无卡即 null）。 */
async function driveOpenUrlTurn(
  token: string,
  sessionId: string,
  sse: SseHandle,
  text: string,
  options: { reportPagesAfterExec?: Array<Record<string, unknown>> } = {},
): Promise<Record<string, unknown> | null> {
  const hitlBefore = framesByType(sse.frames, 'hitl-request').length;
  const turnsBefore = framesByType(sse.frames, 'turn-complete').length;
  await postFrame(token, sessionId, { type: 'user-message', sessionId, text });
  await sse.waitFor(
    () =>
      framesByType(sse.frames, 'hitl-request').length > hitlBefore ||
      framesByType(sse.frames, 'turn-complete').length > turnsBefore,
  );
  const hitl = framesByType(sse.frames, 'hitl-request')[hitlBefore] ?? null;
  if (hitl === null) return null;
  const instrBefore = framesByType(sse.frames, 'exec-instruction').length;
  await postFrame(token, sessionId, {
    type: 'hitl-decision',
    sessionId,
    hitlId: String(hitl['hitlId']),
    decision: 'approve',
  });
  await sse.waitFor(() => framesByType(sse.frames, 'exec-instruction').length > instrBefore);
  const instr = framesByType(sse.frames, 'exec-instruction')[instrBefore]!;
  await postFrame(token, sessionId, {
    type: 'exec-result',
    sessionId,
    nonce: String(instr['nonce']),
    ok: true,
    body: { url: OPEN_TARGET },
  });
  if (options.reportPagesAfterExec !== undefined) {
    await postFrame(token, sessionId, { type: 'group-pages', sessionId, pages: options.reportPagesAfterExec });
  }
  await sse.waitFor(() => framesByType(sse.frames, 'turn-complete').length > turnsBefore);
  return hitl;
}

function lastObservationText(sse: SseHandle): string {
  const text = joinedText(sse);
  return text.slice(text.lastIndexOf('MOCK-NAV-OBS'));
}

describe('非定向 open_url 成功后的落点接入回喂', () => {
  it('落点页在等待窗内未接入 → 等满上限后回喂 attached:false + 不重复打开/授权指引', async () => {
    const token = await signToken();
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    try {
      await postFrame(token, sessionId, { type: 'context-report', sessionId, url: GENERIC_URL });
      await postFrame(token, sessionId, {
        type: 'group-pages',
        sessionId,
        pages: [{ handle: 'p1', url: GENERIC_URL, title: '订单列表', status: 'active' }],
      });
      const startedAt = Date.now();
      const first = await driveOpenUrlTurn(token, sessionId, sse, '打开那条新闻', {
        reportPagesAfterExec: [
          { handle: 'p1', url: GENERIC_URL, title: '订单列表', status: 'active' },
          { handle: 'p2', url: OPEN_TARGET, title: '', status: 'silent' },
        ],
      });
      expect(first).not.toBeNull();
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(ATTACH_WAIT_MS);
      const unattached = lastObservationText(sse);
      expect(unattached).toContain('"attached":false');
      expect(unattached).toContain('不要再次打开同一地址');
      expect(unattached).toContain('点击 Zen 图标');
      expect(unattached).not.toContain('页面已接入');
    } finally {
      sse.close();
    }
  });

  it('等待窗内上报接入（active）→ 立即回喂 attached:true，不等满上限', async () => {
    const token = await signToken();
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    try {
      await postFrame(token, sessionId, { type: 'context-report', sessionId, url: GENERIC_URL });
      const hitl = await driveOpenUrlTurn(token, sessionId, sse, '打开那条新闻', {
        reportPagesAfterExec: [
          { handle: 'p1', url: GENERIC_URL, title: '订单列表', status: 'background' },
          { handle: 'p2', url: `${OPEN_TARGET}#comments`, title: '新闻', status: 'active' },
        ],
      });
      expect(hitl).not.toBeNull();
      const attached = lastObservationText(sse);
      expect(attached).toContain('"attached":true');
      expect(attached).toContain('页面已接入');
      expect(attached).not.toContain('不要再次打开同一地址');
    } finally {
      sse.close();
    }
  });
});

describe('already-open 止损（同地址的页仍未接入时再次 open_url → 服务端 deny、不弹卡）', () => {
  it('首次放行；同地址仍 silent 再导航被拒并记审计；该页接入后同地址导航不再拒', async () => {
    const token = await signToken();
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    try {
      await postFrame(token, sessionId, { type: 'context-report', sessionId, url: GENERIC_URL });
      await postFrame(token, sessionId, {
        type: 'group-pages',
        sessionId,
        pages: [{ handle: 'p1', url: GENERIC_URL, title: '订单列表', status: 'active' }],
      });
      const silentPages = [
        { handle: 'p1', url: GENERIC_URL, title: '订单列表', status: 'active' },
        { handle: 'p2', url: OPEN_TARGET, title: '', status: 'silent' },
      ];
      // 首次导航：弹卡、放行。
      const first = await driveOpenUrlTurn(token, sessionId, sse, '打开那条新闻', {
        reportPagesAfterExec: silentPages,
      });
      expect(first).not.toBeNull();
      expect(lastObservationText(sse)).toContain('"attached":false');

      // 同地址、组内该页仍 silent：服务端直接拒绝，不产生第二张卡。
      const hitlCountBefore = framesByType(sse.frames, 'hitl-request').length;
      const second = await driveOpenUrlTurn(token, sessionId, sse, '再打开一次那条新闻');
      expect(second).toBeNull();
      expect(framesByType(sse.frames, 'hitl-request').length).toBe(hitlCountBefore);
      const denied = lastObservationText(sse);
      expect(denied).toContain('already-open-not-attached');
      expect(denied).toContain('"attached":false');
      expect(denied).toContain('不要再次打开同一地址');
      expect(denied).toContain('点击 Zen 图标');
      const failedCards = framesByType(sse.frames, 'tool-card').filter(
        (frame) => frame['toolId'] === 'open_url' && frame['status'] === 'failed',
      );
      expect(failedCards.length).toBeGreaterThan(0);
      const denyEvents = auditEventsFor(sessionId).filter(
        (event) =>
          event['type'] === 'tool-decision' &&
          (event['data'] as Record<string, unknown>)['verdict'] === 'deny' &&
          (event['data'] as Record<string, unknown>)['reason'] === 'already-open-not-attached',
      );
      expect(denyEvents).toHaveLength(1);
      expect((denyEvents[0]!['data'] as Record<string, unknown>)['toolId']).toBe('open_url');

      // 该页接入（用户在该页点了 Zen 图标 / 授权后注入成功）→ 同地址导航恢复放行（弹卡）。
      await postFrame(token, sessionId, {
        type: 'group-pages',
        sessionId,
        pages: [
          { handle: 'p1', url: GENERIC_URL, title: '订单列表', status: 'background' },
          { handle: 'p2', url: OPEN_TARGET, title: '新闻', status: 'active' },
        ],
      });
      const third = await driveOpenUrlTurn(token, sessionId, sse, '第三次打开那条新闻');
      expect(third).not.toBeNull();
      expect(third?.['toolId']).toBe('open_url');
      expect(lastObservationText(sse)).toContain('"attached":true');
    } finally {
      sse.close();
    }
  });
});
