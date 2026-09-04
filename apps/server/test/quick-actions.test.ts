/**
 * 快捷提问的服务集成面（R-5）：C3 user-message 只带 quickActionId，网关按 L1 站点包声明 +
 * L2 覆盖层查表把模板展开为**用户轮**消息——system 注入不含模板文本（U8 零触碰），
 * 查不到/被停用即原文原样发起并在 assembly 审计事件标注（R4/R6）。
 * 驱动：可编程脚本 mock LLM，逐请求记录送到模型的 messages。
 */
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../src/index.js';

const repoRoot = new URL('../../../', import.meta.url).pathname;
const snapshotRoot = join(repoRoot, 'examples/acceptance');
const systemPromptPath = join(repoRoot, 'assets/system-prompt.md');
const AUDIT_SINK = join(mkdtempSync(join(tmpdir(), 'za-qa-audit-')), 'events.jsonl');
const userConfigDir = mkdtempSync(join(tmpdir(), 'za-qa-store-'));
const PAGE_URL = 'http://127.0.0.1:4173/order-list.html';

const JWT_SECRET = 'za-test-secret';
const SIGNING_SECRET = 'za-test-signing-secret';
const ISS = 'zen-agent-demo';
const TENANT = 'demo-tenant';
const key = new TextEncoder().encode(JWT_SECRET);

interface LlmMessage {
  role: string;
  content: string;
}

interface RecordingMock {
  port: number;
  requests: Array<{ messages: LlmMessage[] }>;
  close(): Promise<void>;
}

/** 只回一句纯文本、并记录本次请求 messages 的最小 mock：本文件的判据全落在「模型收到了什么」。 */
function startRecordingMock(): Promise<RecordingMock> {
  const requests: Array<{ messages: LlmMessage[] }> = [];
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
      requests.push(JSON.parse(raw) as { messages: LlmMessage[] });
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
      send({ index: 0, delta: { content: '好的。' }, finish_reason: null });
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

let mock: RecordingMock;
let server: RunningServer;
let baseUrl = '';
let prevBaseUrl: string | undefined;

beforeAll(async () => {
  mock = await startRecordingMock();
  prevBaseUrl = process.env['ZA_LLM_BASE_URL'];
  process.env['ZA_LLM_BASE_URL'] = `http://127.0.0.1:${mock.port}/v1`;
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
    userConfigDir,
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server?.close();
  await mock?.close();
  if (prevBaseUrl !== undefined) process.env['ZA_LLM_BASE_URL'] = prevBaseUrl;
});

async function signToken(hostUserId: string): Promise<string> {
  return new SignJWT({ tenant: TENANT, roles: ['ops'], hostUserId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(`sub-${hostUserId}`)
    .setIssuer(ISS)
    .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
    .sign(key);
}

function authHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...extra };
}

async function createSession(token: string): Promise<string> {
  const res = await fetch(`${baseUrl}/v1/sessions`, { method: 'POST', headers: authHeaders(token) });
  expect(res.status).toBe(201);
  return ((await res.json()) as { sessionId: string }).sessionId;
}

function postFrame(token: string, sessionId: string, frame: unknown): Promise<Response> {
  return fetch(`${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/frames`, {
    method: 'POST',
    headers: authHeaders(token, { 'content-type': 'application/json' }),
    body: JSON.stringify(frame),
  });
}

async function putOverlay(token: string, hostUserId: string, packs: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${baseUrl}/v1/user-config`, {
    method: 'PUT',
    headers: authHeaders(token, { 'content-type': 'application/json' }),
    body: JSON.stringify({ schemaVersion: 1, subject: { tenant: TENANT, hostUserId }, packs }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
}

interface TurnCapture {
  system: string;
  lastUser: string;
}

/** 发一轮消息并等 mock 收到该轮请求；返回本轮送到模型的 system 与末条 user 文本。 */
async function runTurn(token: string, sessionId: string, frame: Record<string, unknown>): Promise<TurnCapture> {
  const before = mock.requests.length;
  const res = await postFrame(token, sessionId, { type: 'user-message', sessionId, ...frame });
  expect(res.status, await res.clone().text()).toBe(202);
  const deadline = Date.now() + 8000;
  while (mock.requests.length === before) {
    if (Date.now() > deadline) throw new Error('mock LLM 未收到本轮请求');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const messages = mock.requests[before]!.messages;
  const users = messages.filter((message) => message.role === 'user');
  return {
    system: messages.filter((message) => message.role === 'system').map((m) => m.content).join('\n'),
    lastUser: users[users.length - 1]?.content ?? '',
  };
}

interface AssemblyEventData {
  quickActionId?: string;
  quickActionUnresolved?: true;
}

function lastAssemblyEvent(sessionId: string): AssemblyEventData {
  const lines = readFileSync(AUDIT_SINK, 'utf8').split('\n').filter((line) => line.trim() !== '');
  const events = lines
    .map((line) => JSON.parse(line) as { type: string; sessionId: string; data: AssemblyEventData })
    .filter((event) => event.type === 'assembly' && event.sessionId === sessionId);
  return events[events.length - 1]?.data ?? {};
}

async function newSession(hostUserId: string): Promise<{ token: string; sessionId: string }> {
  const token = await signToken(hostUserId);
  const sessionId = await createSession(token);
  await postFrame(token, sessionId, { type: 'context-report', sessionId, url: PAGE_URL });
  return { token, sessionId };
}

const L1_SUMMARIZE_HEAD = '请总结当前页面';

describe('快捷提问展开（L1 站点包声明）', () => {
  it('模板进用户轮、system 注入不含它（U8 零触碰）', async () => {
    const { token, sessionId } = await newSession('qa-l1');
    const capture = await runTurn(token, sessionId, {
      text: '总结本页',
      quickActionId: 'summarize-page',
    });
    expect(capture.lastUser).toContain(L1_SUMMARIZE_HEAD);
    expect(capture.lastUser).toContain(PAGE_URL);
    expect(capture.lastUser).not.toContain('{{url}}');
    expect(capture.system).not.toContain(L1_SUMMARIZE_HEAD);
    expect(lastAssemblyEvent(sessionId)).toMatchObject({ quickActionId: 'summarize-page' });
    expect(lastAssemblyEvent(sessionId).quickActionUnresolved).toBeUndefined();
  });

  it('selectionText 代入 {{selection}}', async () => {
    const { token, sessionId } = await newSession('qa-sel');
    const capture = await runTurn(token, sessionId, {
      text: '解释选中内容',
      quickActionId: 'explain-selection',
      selectionText: '本单已完成，不可取消',
    });
    expect(capture.lastUser).toContain('本单已完成，不可取消');
    expect(capture.lastUser).not.toContain('{{selection}}');
  });
});

describe('快捷提问展开（L2 用户覆盖层）', () => {
  it('用户自建条目按同一通道展开', async () => {
    const hostUserId = 'qa-l2';
    const token = await signToken(hostUserId);
    await putOverlay(token, hostUserId, {
      '*': {
        quickActions: [
          { id: 'my-checklist', label: '按我的清单核对', template: '按我的核对清单逐条检查这一页。', context: 'none' },
        ],
      },
    });
    const sessionId = await createSession(token);
    await postFrame(token, sessionId, { type: 'context-report', sessionId, url: PAGE_URL });
    const capture = await runTurn(token, sessionId, { text: '按我的清单核对', quickActionId: 'my-checklist' });
    expect(capture.lastUser).toBe('按我的核对清单逐条检查这一页。');
    expect(capture.system).not.toContain('按我的核对清单逐条检查这一页。');
  });

  it('被用户停用的 L1 条目按未知 id 回退：原文原样 + 审计标注', async () => {
    const hostUserId = 'qa-disabled';
    const token = await signToken(hostUserId);
    await putOverlay(token, hostUserId, { '*': { disabledQuickActions: ['summarize-page'] } });
    const sessionId = await createSession(token);
    await postFrame(token, sessionId, { type: 'context-report', sessionId, url: PAGE_URL });
    const capture = await runTurn(token, sessionId, { text: '总结本页', quickActionId: 'summarize-page' });
    expect(capture.lastUser).toBe('总结本页');
    expect(capture.lastUser).not.toContain(L1_SUMMARIZE_HEAD);
    expect(lastAssemblyEvent(sessionId)).toMatchObject({
      quickActionId: 'summarize-page',
      quickActionUnresolved: true,
    });
  });
});

describe('未知 id 与自动回合', () => {
  it('未知 id → 原文原样发起并标注 quickActionUnresolved', async () => {
    const { token, sessionId } = await newSession('qa-unknown');
    const capture = await runTurn(token, sessionId, {
      text: '这是我自己敲的原话',
      quickActionId: 'no-such-action',
    });
    expect(capture.lastUser).toBe('这是我自己敲的原话');
    expect(lastAssemblyEvent(sessionId)).toMatchObject({
      quickActionId: 'no-such-action',
      quickActionUnresolved: true,
    });
  });

  it('自动回合不接受快捷提问：带 automationId 同发即拒，未启动回合', async () => {
    const { token, sessionId } = await newSession('qa-automation');
    const before = mock.requests.length;
    const res = await postFrame(token, sessionId, {
      type: 'user-message',
      sessionId,
      text: 'x',
      quickActionId: 'summarize-page',
      automationId: 'some-watch',
      automationRunId: 'run-000000001',
    });
    expect(res.status).toBe(400);
    expect(mock.requests.length).toBe(before);
  });
});

describe('GET /v1/packs 投影 quickActions（配置中心数据源）', () => {
  it('generic-web 的预置条目随 pack 卡片下发', async () => {
    const token = await signToken('qa-packs');
    const res = await fetch(`${baseUrl}/v1/packs`, { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { packs: Array<{ packId: string; quickActions?: Array<{ id: string }> }> };
    const generic = body.packs.find((pack) => pack.packId === 'generic-web');
    expect(generic?.quickActions?.map((action) => action.id)).toEqual([
      'explain-selection',
      'summarize-page',
    ]);
  });
});
