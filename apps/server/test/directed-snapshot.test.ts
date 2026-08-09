/**
 * adr-023 D2 定向观察服务端闭环：page_snapshot 带 page 的目标解析（U7 fail-closed，
 * 拒绝全部在下发前、不回退活跃页）、下行帧带目标句柄、观测页标注前缀、domContext 不被定向覆写、
 * 三类拒绝的回喂措辞与审计 skipped 页标注、缺省调用零变化回归。句柄按不透明契约用异形字符串验证（U5）。
 * 本文件自带确定性 mock LLM（按用户哨兵语产出带 page 实参的 tool_call，回喂轮原样回显 observation），
 * 不依赖 scripts/mock-llm 的剧本面。
 */
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../src/index.js';

const repoRoot = new URL('../../../', import.meta.url).pathname;
const snapshotRoot = join(repoRoot, 'examples/acceptance');
const systemPromptPath = join(repoRoot, 'assets/system-prompt.md');
const AUDIT_SINK = join(mkdtempSync(join(tmpdir(), 'za-directed-snap-audit-')), 'events.jsonl');
const TIMEOUT_AUDIT_SINK = join(
  mkdtempSync(join(tmpdir(), 'za-directed-snap-timeout-audit-')),
  'events.jsonl',
);

// 每次运行现生成：仓库内不留固定密钥串（SEC-01），值本身对断言无意义。
const JWT_SECRET = randomUUID();
const SIGNING_SECRET = randomUUID();
const ISS = 'zen-agent-demo';
const key = new TextEncoder().encode(JWT_SECRET);

const GENERIC_ORIGIN = 'http://127.0.0.1:4173';
const GENERIC_URL = `${GENERIC_ORIGIN}/article.html`;

const SNAPSHOT_TOOL = 'page_snapshot';
const BROWSE_TOOL = 'browse.page-operate';
const OBS_ECHO_PREFIX = 'MOCK-DIRECTED-OBS';

/** 异形句柄（非 p<N> 形状）：服务端只作等值比对，无按句柄结构分支（U5 续锚）。 */
const ODD_HANDLE = 'workspace-view-00c3';
/** 契约合法（1..64 无 pattern）的含换行句柄：页标注 tag 消毒防线的输入。 */
const NEWLINE_HANDLE = 'p2\nfake';
const TARGET_URL = 'https://mail.126.com/main?box=inbox';
const TARGET_ORIGIN = 'https://mail.126.com';
const NO_ORIGIN_HANDLE = 'p-noorigin';
const SILENT_HANDLE = 'p-silent';
const SILENT_URL = 'https://docs.example/guide';

interface DirectedMockHandle {
  port: number;
  close(): Promise<void>;
}

type MockDecision = { text: string } | { toolCall: { id: string; name: string; arguments: string } };

/**
 * 首轮按用户哨兵语产出快照 tool_call（page 实参取哨兵语中的句柄字面）；
 * 回喂轮原样回显 observation，供对回喂内容做机械断言。
 * 「定向后操作」剧本的回喂轮改发 dom 批次（驱动 domContext 未被定向覆写的 deny 路径）。
 */
function decide(u: string, messages: Array<Record<string, unknown>>): MockDecision {
  const last = messages[messages.length - 1] as { role?: string; content?: unknown } | undefined;
  const obs = last?.role === 'tool' ? String(last.content ?? '') : null;
  if (obs !== null) {
    if (u.includes('定向后操作') && obs.startsWith('[来自 ')) {
      return {
        toolCall: {
          id: 'call_browse_after_directed',
          name: BROWSE_TOOL,
          arguments: JSON.stringify({
            task: '定向观察后在活跃页操作',
            plan: ['先定向观察目标页', '再点击活跃页目标元素'],
            steps: [{ action: 'click', ref: 'za-1' }],
            summary: '点击活跃页目标按钮',
          }),
        },
      };
    }
    return { text: `${OBS_ECHO_PREFIX} ${obs}` };
  }
  if (u.includes('定向读取空句柄')) {
    return {
      toolCall: { id: 'call_snap_invalid', name: SNAPSHOT_TOOL, arguments: JSON.stringify({ page: '' }) },
    };
  }
  if (u.includes('定向读取换行句柄')) {
    return {
      toolCall: {
        id: 'call_snap_newline',
        name: SNAPSHOT_TOOL,
        arguments: JSON.stringify({ page: NEWLINE_HANDLE }),
      },
    };
  }
  const afterOp = u.match(/定向后操作\s+(\S+)/);
  if (afterOp !== null) {
    return {
      toolCall: {
        id: 'call_snap_before_op',
        name: SNAPSHOT_TOOL,
        arguments: JSON.stringify({ page: afterOp[1] }),
      },
    };
  }
  const directed = u.match(/定向读取\s+(\S+)/);
  if (directed !== null) {
    return {
      toolCall: {
        id: 'call_snap_directed',
        name: SNAPSHOT_TOOL,
        arguments: JSON.stringify({
          page: directed[1],
          ...(u.includes('带正文') ? { includeText: true } : {}),
        }),
      },
    };
  }
  if (u.includes('缺省快照')) {
    return { toolCall: { id: 'call_snap_default', name: SNAPSHOT_TOOL, arguments: JSON.stringify({}) } };
  }
  return { text: 'MOCK-DIRECTED-DEFAULT' };
}

function startDirectedMock(): Promise<DirectedMockHandle> {
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found', type: 'invalid_request_error' } }));
      return;
    }
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const body = JSON.parse(raw) as { messages: Array<Record<string, unknown>> };
      const lastUser = [...body.messages].reverse().find((m) => m['role'] === 'user');
      const decision = decide(String(lastUser?.['content'] ?? ''), body.messages);
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const base = {
        id: 'chatcmpl-directed-mock',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'mock-model',
      };
      const send = (choice: Record<string, unknown>): void => {
        res.write(`data: ${JSON.stringify({ ...base, choices: [choice] })}\n\n`);
      };
      send({ index: 0, delta: { role: 'assistant' }, finish_reason: null });
      if ('toolCall' in decision) {
        send({
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: decision.toolCall.id,
                type: 'function',
                function: { name: decision.toolCall.name, arguments: decision.toolCall.arguments },
              },
            ],
          },
          finish_reason: null,
        });
        send({ index: 0, delta: {}, finish_reason: 'tool_calls' });
      } else {
        send({ index: 0, delta: { content: decision.text }, finish_reason: null });
        send({ index: 0, delta: {}, finish_reason: 'stop' });
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        port: typeof address === 'object' && address !== null ? address.port : 0,
        close: () =>
          new Promise((res2, rej2) => server.close((err) => (err ? rej2(err) : res2()))),
      });
    });
  });
}

let mock: DirectedMockHandle;
let server: RunningServer;
let timeoutServer: RunningServer;
let baseUrl = '';
let timeoutBaseUrl = '';

beforeAll(async () => {
  mock = await startDirectedMock();
  process.env['ZA_LLM_BASE_URL'] = `http://127.0.0.1:${mock.port}/v1`;
  process.env['ZA_LLM_MODEL'] = 'mock-model';
  const options = {
    port: 0,
    jwtSecret: JWT_SECRET,
    signingSecret: SIGNING_SECRET,
    issAllowlist: [ISS],
    snapshotRoot,
    systemPromptPath,
    allowedProviders: ['openai-compatible'],
    heartbeatMs: 60_000,
    genericAllowlist: [GENERIC_ORIGIN],
  };
  server = await startServer({ ...options, auditSinkPath: AUDIT_SINK });
  // 快照时限缩短的第二实例：超时路径不能靠等 15s 默认值，且独立 sink 免与主实例交错落盘。
  timeoutServer = await startServer({
    ...options,
    auditSinkPath: TIMEOUT_AUDIT_SINK,
    snapshotTimeoutMs: 300,
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
  timeoutBaseUrl = `http://127.0.0.1:${timeoutServer.port}`;
});

afterAll(async () => {
  await server?.close();
  await timeoutServer?.close();
  await mock?.close();
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

async function createSession(token: string, base = baseUrl): Promise<string> {
  const res = await fetch(`${base}/v1/sessions`, { method: 'POST', headers: authHeaders(token) });
  expect(res.status).toBe(201);
  return ((await res.json()) as { sessionId: string }).sessionId;
}

async function postFrame(
  token: string,
  sessionId: string,
  frame: Record<string, unknown>,
  base = baseUrl,
): Promise<Response> {
  return fetch(`${base}/v1/sessions/${encodeURIComponent(sessionId)}/frames`, {
    method: 'POST',
    headers: authHeaders(token, { 'content-type': 'application/json' }),
    body: JSON.stringify(frame),
  });
}

interface SseHandle {
  frames: Array<Record<string, unknown>>;
  waitFor(predicate: () => boolean, timeoutMs?: number): Promise<void>;
  close(): void;
}

async function openSse(token: string, sessionId: string, base = baseUrl): Promise<SseHandle> {
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
        if (Date.now() > deadline) {
          throw new Error(`SSE 等待超时；已收帧：${JSON.stringify(frames)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
    close: () => controller.abort(),
  };
}

function framesByType(
  frames: Array<Record<string, unknown>>,
  type: string,
): Array<Record<string, unknown>> {
  return frames.filter((frame) => frame['type'] === type);
}

function joinedText(sse: SseHandle): string {
  return framesByType(sse.frames, 'text-delta')
    .map((frame) => String(frame['delta']))
    .join('');
}

/** 建会话并上报组页面状态表（active 活跃页 + 异形 background + 无 origin background + silent）。 */
async function startGroupSession(
  token: string,
  base = baseUrl,
): Promise<{ sessionId: string; sse: SseHandle }> {
  const sessionId = await createSession(token, base);
  const sse = await openSse(token, sessionId, base);
  await postFrame(token, sessionId, { type: 'context-report', sessionId, url: GENERIC_URL }, base);
  await postFrame(
    token,
    sessionId,
    {
      type: 'group-pages',
      sessionId,
      pages: [
        { handle: 'act-1', url: GENERIC_URL, title: '通用文章页', status: 'active' },
        { handle: ODD_HANDLE, url: TARGET_URL, title: '126邮箱', status: 'background' },
        { handle: NO_ORIGIN_HANDLE, url: 'not a url!!', title: '怪页', status: 'background' },
        { handle: SILENT_HANDLE, url: SILENT_URL, status: 'silent' },
      ],
    },
    base,
  );
  return { sessionId, sse };
}

async function driveTurn(
  token: string,
  sessionId: string,
  text: string,
  base = baseUrl,
): Promise<Response> {
  return postFrame(token, sessionId, { type: 'user-message', sessionId, text }, base);
}

async function awaitTurnComplete(sse: SseHandle): Promise<void> {
  await sse.waitFor(() => framesByType(sse.frames, 'turn-complete').length > 0);
}

function auditEventsFor(sessionId: string, sink = AUDIT_SINK): Array<Record<string, unknown>> {
  const raw = readFileSync(sink, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((event) => event['sessionId'] === sessionId);
}

function snapshotExecEvents(sessionId: string, sink = AUDIT_SINK): Array<Record<string, unknown>> {
  return auditEventsFor(sessionId, sink).filter(
    (event) =>
      event['type'] === 'tool-execution' &&
      (event['data'] as Record<string, unknown>)['toolId'] === SNAPSHOT_TOOL,
  );
}

describe('定向快照全链路（成功路径）', () => {
  it('异形句柄命中 background 页：帧带目标句柄、不带 evidenceRules，观测首行页标注，审计 ok 带目标 page', async () => {
    const token = await signToken();
    const { sessionId, sse } = await startGroupSession(token);
    try {
      await driveTurn(token, sessionId, `定向读取 ${ODD_HANDLE}`);
      await sse.waitFor(() => framesByType(sse.frames, 'snapshot-request').length > 0);
      const request = framesByType(sse.frames, 'snapshot-request')[0]!;
      expect(request['page']).toBe(ODD_HANDLE);
      expect(request).not.toHaveProperty('evidenceRules');

      await postFrame(token, sessionId, {
        type: 'snapshot-report',
        sessionId,
        requestId: String(request['requestId']),
        url: TARGET_URL,
        title: '收件箱',
        elements: [{ ref: 'za-1', role: 'link', label: '验证码邮件' }],
      });
      await sse.waitFor(() => joinedText(sse).includes(OBS_ECHO_PREFIX));
      await awaitTurnComplete(sse);
    } finally {
      sse.close();
    }
    const text = joinedText(sse);
    // 前缀独占首行：`[来自 句柄 · origin]` + 换行 + 快照 JSON。
    expect(text).toContain(`${OBS_ECHO_PREFIX} [来自 ${ODD_HANDLE} · ${TARGET_ORIGIN}]\n{"url"`);

    const events = snapshotExecEvents(sessionId);
    expect(events).toHaveLength(1);
    expect((events[0]!['data'] as Record<string, unknown>)['outcome']).toBe('ok');
    expect(events[0]!['page']).toEqual({ handle: ODD_HANDLE, origin: TARGET_ORIGIN });
  });

  it('目标页 URL 取不到 origin：前缀退化为仅句柄，审计 page 只带 handle', async () => {
    const token = await signToken();
    const { sessionId, sse } = await startGroupSession(token);
    try {
      await driveTurn(token, sessionId, `定向读取 ${NO_ORIGIN_HANDLE}`);
      await sse.waitFor(() => framesByType(sse.frames, 'snapshot-request').length > 0);
      const request = framesByType(sse.frames, 'snapshot-request')[0]!;
      expect(request['page']).toBe(NO_ORIGIN_HANDLE);
      await postFrame(token, sessionId, {
        type: 'snapshot-report',
        sessionId,
        requestId: String(request['requestId']),
        url: 'not a url!!',
        title: '怪页',
        elements: [],
      });
      await sse.waitFor(() => joinedText(sse).includes(OBS_ECHO_PREFIX));
      await awaitTurnComplete(sse);
    } finally {
      sse.close();
    }
    expect(joinedText(sse)).toContain(`${OBS_ECHO_PREFIX} [来自 ${NO_ORIGIN_HANDLE}]\n{"url"`);
    const events = snapshotExecEvents(sessionId);
    expect(events).toHaveLength(1);
    expect(events[0]!['page']).toEqual({ handle: NO_ORIGIN_HANDLE });
  });

  it('定向到活跃页自身句柄同样按定向处理：帧带句柄、观测带前缀', async () => {
    const token = await signToken();
    const { sessionId, sse } = await startGroupSession(token);
    try {
      await driveTurn(token, sessionId, '定向读取 act-1');
      await sse.waitFor(() => framesByType(sse.frames, 'snapshot-request').length > 0);
      const request = framesByType(sse.frames, 'snapshot-request')[0]!;
      expect(request['page']).toBe('act-1');
      await postFrame(token, sessionId, {
        type: 'snapshot-report',
        sessionId,
        requestId: String(request['requestId']),
        url: GENERIC_URL,
        title: '通用文章页',
        elements: [],
      });
      await sse.waitFor(() => joinedText(sse).includes(OBS_ECHO_PREFIX));
      await awaitTurnComplete(sse);
    } finally {
      sse.close();
    }
    expect(joinedText(sse)).toContain(`${OBS_ECHO_PREFIX} [来自 act-1 · ${GENERIC_ORIGIN}]\n{"url"`);
  });

  it('includeText 随定向透传：下行帧同时带 page 与 includeText', async () => {
    const token = await signToken();
    const { sessionId, sse } = await startGroupSession(token);
    try {
      await driveTurn(token, sessionId, `定向读取 ${ODD_HANDLE} 带正文`);
      await sse.waitFor(() => framesByType(sse.frames, 'snapshot-request').length > 0);
      const request = framesByType(sse.frames, 'snapshot-request')[0]!;
      expect(request['page']).toBe(ODD_HANDLE);
      expect(request['includeText']).toBe(true);
      await postFrame(token, sessionId, {
        type: 'snapshot-report',
        sessionId,
        requestId: String(request['requestId']),
        url: TARGET_URL,
        title: '收件箱',
        elements: [],
        text: '目标页正文内容',
      });
      await sse.waitFor(() => joinedText(sse).includes(OBS_ECHO_PREFIX));
      await awaitTurnComplete(sse);
    } finally {
      sse.close();
    }
    const text = joinedText(sse);
    expect(text).toContain(`[来自 ${ODD_HANDLE} · ${TARGET_ORIGIN}]`);
    expect(text).toContain('目标页正文内容');
  });

  it('契约合法的含换行句柄：观测页标注消毒后仍独占首行，帧与审计句柄原样透传', async () => {
    const token = await signToken();
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    try {
      await postFrame(token, sessionId, { type: 'context-report', sessionId, url: GENERIC_URL });
      await postFrame(token, sessionId, {
        type: 'group-pages',
        sessionId,
        pages: [
          { handle: 'act-1', url: GENERIC_URL, title: '通用文章页', status: 'active' },
          { handle: NEWLINE_HANDLE, url: TARGET_URL, title: '126邮箱', status: 'background' },
        ],
      });
      await driveTurn(token, sessionId, '定向读取换行句柄');
      await sse.waitFor(() => framesByType(sse.frames, 'snapshot-request').length > 0);
      const request = framesByType(sse.frames, 'snapshot-request')[0]!;
      // 下行帧句柄原样透传（等值查表用原值；消毒只发生在观测 tag 渲染点）。
      expect(request['page']).toBe(NEWLINE_HANDLE);
      await postFrame(token, sessionId, {
        type: 'snapshot-report',
        sessionId,
        requestId: String(request['requestId']),
        url: TARGET_URL,
        title: '收件箱',
        elements: [{ ref: 'za-1', role: 'link', label: '验证码邮件' }],
      });
      await sse.waitFor(() => joinedText(sse).includes(OBS_ECHO_PREFIX));
      await awaitTurnComplete(sse);
    } finally {
      sse.close();
    }
    const text = joinedText(sse);
    expect(text).toContain(`${OBS_ECHO_PREFIX} [来自 p2fake · ${TARGET_ORIGIN}]\n{"url"`);
    expect(text).not.toContain(`[来自 ${NEWLINE_HANDLE}`);
    const events = snapshotExecEvents(sessionId);
    expect(events).toHaveLength(1);
    expect(events[0]!['page']).toEqual({ handle: NEWLINE_HANDLE, origin: TARGET_ORIGIN });
  });
});

describe('定向拒绝路径（U7：下发前拒绝、不发帧、不回退活跃页）', () => {
  it('silent 页拒绝并引导：不 broadcast 帧，回喂含不可交互与激活引导，审计 skipped 带目标 page', async () => {
    const token = await signToken();
    const { sessionId, sse } = await startGroupSession(token);
    try {
      await driveTurn(token, sessionId, `定向读取 ${SILENT_HANDLE}`);
      await sse.waitFor(() => joinedText(sse).includes(OBS_ECHO_PREFIX));
      await awaitTurnComplete(sse);
    } finally {
      sse.close();
    }
    expect(framesByType(sse.frames, 'snapshot-request')).toHaveLength(0);
    const failedCards = framesByType(sse.frames, 'tool-card').filter(
      (frame) => frame['toolId'] === SNAPSHOT_TOOL && frame['status'] === 'failed',
    );
    expect(failedCards.length).toBeGreaterThan(0);
    const text = joinedText(sse);
    expect(text).toContain('page-not-interactive');
    expect(text).toContain('不可交互');
    expect(text).toContain('激活');
    const events = snapshotExecEvents(sessionId);
    expect(events).toHaveLength(1);
    expect((events[0]!['data'] as Record<string, unknown>)['outcome']).toBe('skipped');
    expect(events[0]!['page']).toEqual({ handle: SILENT_HANDLE, origin: 'https://docs.example' });
  });

  it('句柄未命中拒绝：不 broadcast 帧，回喂指向清单最新句柄，审计 skipped 仅带 handle', async () => {
    const token = await signToken();
    const { sessionId, sse } = await startGroupSession(token);
    try {
      await driveTurn(token, sessionId, '定向读取 p-ghost');
      await sse.waitFor(() => joinedText(sse).includes(OBS_ECHO_PREFIX));
      await awaitTurnComplete(sse);
    } finally {
      sse.close();
    }
    expect(framesByType(sse.frames, 'snapshot-request')).toHaveLength(0);
    const text = joinedText(sse);
    expect(text).toContain('page-not-in-group');
    expect(text).toContain('不在当前任务组页面清单');
    const events = snapshotExecEvents(sessionId);
    expect(events).toHaveLength(1);
    expect((events[0]!['data'] as Record<string, unknown>)['outcome']).toBe('skipped');
    expect(events[0]!['page']).toEqual({ handle: 'p-ghost' });
  });

  it('形状越界（空串句柄）拒绝：不 broadcast 帧，回喂引导修正，审计 skipped 省略 page', async () => {
    const token = await signToken();
    const { sessionId, sse } = await startGroupSession(token);
    try {
      await driveTurn(token, sessionId, '定向读取空句柄');
      await sse.waitFor(() => joinedText(sse).includes(OBS_ECHO_PREFIX));
      await awaitTurnComplete(sse);
    } finally {
      sse.close();
    }
    expect(framesByType(sse.frames, 'snapshot-request')).toHaveLength(0);
    const text = joinedText(sse);
    expect(text).toContain('page-invalid');
    expect(text).toContain('任务组页面清单');
    const events = snapshotExecEvents(sessionId);
    expect(events).toHaveLength(1);
    expect((events[0]!['data'] as Record<string, unknown>)['outcome']).toBe('skipped');
    expect(events[0]).not.toHaveProperty('page');
  });
});

describe('定向快照超时（目标页不回传 snapshot-report）', () => {
  it('时限到期：观测回喂 snapshot-timeout，卡片失败，审计 timeout 带目标 page', async () => {
    const token = await signToken();
    const { sessionId, sse } = await startGroupSession(token, timeoutBaseUrl);
    try {
      await driveTurn(token, sessionId, `定向读取 ${ODD_HANDLE}`, timeoutBaseUrl);
      await sse.waitFor(() => framesByType(sse.frames, 'snapshot-request').length > 0);
      expect(framesByType(sse.frames, 'snapshot-request')[0]!['page']).toBe(ODD_HANDLE);
      // 全程不回传 snapshot-report：由服务端注入的快照时限收口。
      await sse.waitFor(() => joinedText(sse).includes(OBS_ECHO_PREFIX));
      await awaitTurnComplete(sse);
    } finally {
      sse.close();
    }
    expect(joinedText(sse)).toContain('snapshot-timeout');
    const failedCards = framesByType(sse.frames, 'tool-card').filter(
      (frame) => frame['toolId'] === SNAPSHOT_TOOL && frame['status'] === 'failed',
    );
    expect(failedCards).toHaveLength(1);
    const events = snapshotExecEvents(sessionId, TIMEOUT_AUDIT_SINK);
    expect(events).toHaveLength(1);
    expect((events[0]!['data'] as Record<string, unknown>)['outcome']).toBe('timeout');
    expect(events[0]!['page']).toEqual({ handle: ODD_HANDLE, origin: TARGET_ORIGIN });
  });
});

describe('定向观察不建立 dom 操作基准（domContext 只绑缺省观察链）', () => {
  it('定向快照成功后发 dom 批次：toolgate 因无 domContext 拒绝，未签发任何指令', async () => {
    const token = await signToken();
    const { sessionId, sse } = await startGroupSession(token);
    try {
      await driveTurn(token, sessionId, `定向后操作 ${ODD_HANDLE}`);
      await sse.waitFor(() => framesByType(sse.frames, 'snapshot-request').length > 0);
      const request = framesByType(sse.frames, 'snapshot-request')[0]!;
      expect(request['page']).toBe(ODD_HANDLE);
      await postFrame(token, sessionId, {
        type: 'snapshot-report',
        sessionId,
        requestId: String(request['requestId']),
        url: TARGET_URL,
        title: '收件箱',
        elements: [{ ref: 'za-1', role: 'button', label: '目标按钮' }],
      });
      await sse.waitFor(() => joinedText(sse).includes(OBS_ECHO_PREFIX));
      await awaitTurnComplete(sse);
    } finally {
      sse.close();
    }
    // 定向快照未建立 domContext：dom 工具签发前即 deny，无 HITL、无签名指令下发。
    expect(joinedText(sse)).toContain('dom-context-missing');
    expect(framesByType(sse.frames, 'exec-instruction')).toHaveLength(0);
    expect(framesByType(sse.frames, 'hitl-request')).toHaveLength(0);
  });
});

describe('缺省调用零变化回归', () => {
  it('不带 page：下行帧无 page 键、观测无页标注前缀、快照不发 tool-execution 审计事件', async () => {
    const token = await signToken();
    const { sessionId, sse } = await startGroupSession(token);
    try {
      await driveTurn(token, sessionId, '缺省快照');
      await sse.waitFor(() => framesByType(sse.frames, 'snapshot-request').length > 0);
      const request = framesByType(sse.frames, 'snapshot-request')[0]!;
      expect(request).not.toHaveProperty('page');
      await postFrame(token, sessionId, {
        type: 'snapshot-report',
        sessionId,
        requestId: String(request['requestId']),
        url: GENERIC_URL,
        title: '通用文章页',
        elements: [{ ref: 'za-1', role: 'button', label: '按钮' }],
      });
      await sse.waitFor(() => joinedText(sse).includes(OBS_ECHO_PREFIX));
      await awaitTurnComplete(sse);
    } finally {
      sse.close();
    }
    // 缺省观测原样回喂（无前缀）：回显紧跟快照 JSON 本体。
    expect(joinedText(sse)).toContain(`${OBS_ECHO_PREFIX} {"url"`);
    expect(joinedText(sse)).not.toContain('[来自 ');
    expect(snapshotExecEvents(sessionId)).toHaveLength(0);
  });
});
