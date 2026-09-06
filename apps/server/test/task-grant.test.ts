/**
 * adr-028 任务级一次授权的服务端闭环：任务首个动作（带 task + 整任务 plan 的 open_url）弹唯一一张确认卡，
 * 批准即登记任务级授权；落点重装配后授权随任务延续到新作用域（packId/packOrigin 随站切换），
 * 同任务内的页面操作与再次导航自动放行；无 plan 的导航批准只覆盖本次、不登记。
 * 自带确定性 mock LLM（按用户哨兵语选剧本、按已发出的 tool_call 数推进），不依赖 scripts/mock-llm 剧本面。
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
const snapshotRoot = join(repoRoot, 'assets');
const systemPromptPath = join(repoRoot, 'assets/system-prompt.md');
const AUDIT_SINK = join(mkdtempSync(join(tmpdir(), 'za-task-grant-audit-')), 'events.jsonl');

// 每次运行现生成：仓库内不留固定密钥串（SEC-01），值本身对断言无意义。
const JWT_SECRET = randomUUID();
const SIGNING_SECRET = randomUUID();
const ISS = 'zen-agent-demo';
const key = new TextEncoder().encode(JWT_SECRET);

const SITE_A_ORIGIN = 'https://search-a.example';
const SITE_A_URL = `${SITE_A_ORIGIN}/search`;
const SITE_B_ORIGIN = 'https://article-b.example';
const SITE_B_URL = `${SITE_B_ORIGIN}/post/1`;
const TASK = '在 A 站检索并打开结果 B';
const PLAN = ['打开 A 站搜索页', '填入关键词并搜索', '打开结果页 B', '读取正文并总结'];
const BROWSE_TOOL = 'browse.page-operate';
const SNAPSHOT_TOOL = 'page_snapshot';
const DONE_TEXT = 'MOCK-TASK-GRANT-DONE';

type ToolCall = { id: string; name: string; arguments: string };
type MockDecision = { text: string } | { toolCall: ToolCall };

/** 已发出的 tool_call 数（跨观测轮累计），据此推进剧本：第 n 次调用固定为剧本第 n 步。 */
function toolCallsSoFar(messages: Array<Record<string, unknown>>): number {
  return messages.reduce((count, message) => {
    const calls = message['tool_calls'];
    return message['role'] === 'assistant' && Array.isArray(calls) ? count + calls.length : count;
  }, 0);
}

function lastObservation(messages: Array<Record<string, unknown>>): string | null {
  let index = messages.length - 1;
  while (index >= 0 && String(messages[index]?.['content'] ?? '').startsWith('【站点边界】')) index -= 1;
  const last = messages[index];
  return last?.['role'] === 'tool' ? String(last['content'] ?? '') : null;
}

const call = (name: string, params: Record<string, unknown>): ToolCall => ({
  id: `call_${randomUUID().slice(0, 8)}`,
  name,
  arguments: JSON.stringify(params),
});

const browseStep = (name: string): ToolCall =>
  call(BROWSE_TOOL, {
    task: TASK,
    plan: PLAN,
    steps: [{ action: 'read', ref: 'za-1', name }],
    summary: '读取页面元素',
  });

/** 剧本 A（带 plan）：open_url A（task+plan）→ 快照 → 操作 → open_url B（同 task，无 plan）→ 快照 → 操作 → 总结。 */
const PLANNED_SCRIPT: ToolCall[] = [
  call('open_url', { url: SITE_A_URL, task: TASK, plan: PLAN, reason: '先打开搜索站' }),
  call(SNAPSHOT_TOOL, {}),
  browseStep('searchBox'),
  call('open_url', { url: SITE_B_URL, task: TASK }),
  call(SNAPSHOT_TOOL, {}),
  browseStep('article'),
];

/** 剧本 B（无 plan）：open_url A（仅 task）→ 快照 → 同 task 页面操作 → 总结。 */
const UNPLANNED_SCRIPT: ToolCall[] = [
  call('open_url', { url: SITE_A_URL, task: TASK }),
  call(SNAPSHOT_TOOL, {}),
  browseStep('searchBox'),
];

function decide(u: string, messages: Array<Record<string, unknown>>): MockDecision {
  const script = u.includes('不带计划') ? UNPLANNED_SCRIPT : u.includes('带计划') ? PLANNED_SCRIPT : null;
  if (script === null) return { text: 'MOCK-TASK-GRANT-DEFAULT' };
  const obs = lastObservation(messages);
  if (obs !== null && obs.includes('"error"')) return { text: `MOCK-TASK-GRANT-ERROR ${obs}` };
  const next = script[toolCallsSoFar(messages)];
  return next === undefined ? { text: DONE_TEXT } : { toolCall: next };
}

/** mock 在历史里见到的站点边界标记正文（服务端换站注入）：落点装配切换的可观测面。 */
const boundariesSeen: string[] = [];

function startScriptedMock(): Promise<{ port: number; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404).end();
      return;
    }
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const body = JSON.parse(raw) as { messages: Array<Record<string, unknown>> };
      for (const message of body.messages) {
        const content = String(message['content'] ?? '');
        if (message['role'] === 'user' && content.startsWith('【站点边界】') && !boundariesSeen.includes(content)) {
          boundariesSeen.push(content);
        }
      }
      const lastUser = [...body.messages]
        .reverse()
        .find((m) => m['role'] === 'user' && !String(m['content'] ?? '').startsWith('【站点边界】'));
      const decision = decide(String(lastUser?.['content'] ?? ''), body.messages);
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const base = { id: 'chatcmpl-task-grant', object: 'chat.completion.chunk', created: 0, model: 'mock-model' };
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
        close: () => new Promise((done, fail) => server.close((err) => (err ? fail(err) : done()))),
      });
    });
  });
}

let mock: { port: number; close(): Promise<void> };
let server: RunningServer;
let baseUrl = '';

beforeAll(async () => {
  mock = await startScriptedMock();
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
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server?.close();
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

async function createSession(token: string): Promise<string> {
  const res = await fetch(`${baseUrl}/v1/sessions`, { method: 'POST', headers: authHeaders(token) });
  expect(res.status).toBe(201);
  return ((await res.json()) as { sessionId: string }).sessionId;
}

async function postFrame(token: string, sessionId: string, frame: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/frames`, {
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
  const response = await fetch(`${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/events`, {
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
            if (line.startsWith('data: ')) frames.push(JSON.parse(line.slice('data: '.length)) as Record<string, unknown>);
          }
        }
      }
    } catch {
      // abort 断开属正常收尾
    }
  })();
  return {
    frames,
    async waitFor(predicate, timeoutMs = 10_000) {
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

function auditEventsFor(sessionId: string): Array<Record<string, unknown>> {
  return readFileSync(AUDIT_SINK, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((event) => event['sessionId'] === sessionId);
}

function decisionsOf(sessionId: string): Array<{ toolId: string; verdict: string }> {
  return auditEventsFor(sessionId)
    .filter((event) => event['type'] === 'tool-decision')
    .map((event) => {
      const data = event['data'] as Record<string, unknown>;
      return { toolId: String(data['toolId']), verdict: String(data['verdict']) };
    });
}

/**
 * 代插件之职驱动一回合到 turn-complete：hitl-request 一律批准，snapshot-request 按当前落点页回一份
 * 含一个可读元素的快照，exec-instruction 按批次形态回结果（单步 navigate 回 {url} 并记为新落点）。
 */
async function driveTurn(token: string, sessionId: string, sse: SseHandle, text: string): Promise<void> {
  await postFrame(token, sessionId, { type: 'user-message', sessionId, text });
  const handled = new Set<string>();
  let landedUrl = '';
  const deadline = Date.now() + 15_000;
  for (;;) {
    for (const frame of sse.frames) {
      const type = String(frame['type']);
      if (type === 'hitl-request' && !handled.has(String(frame['hitlId']))) {
        handled.add(String(frame['hitlId']));
        await postFrame(token, sessionId, {
          type: 'hitl-decision',
          sessionId,
          hitlId: frame['hitlId'],
          decision: 'approve',
        });
      }
      if (type === 'snapshot-request' && !handled.has(String(frame['requestId']))) {
        handled.add(String(frame['requestId']));
        await postFrame(token, sessionId, {
          type: 'snapshot-report',
          sessionId,
          requestId: frame['requestId'],
          url: landedUrl,
          elements: [{ ref: 'za-1', role: 'textbox', label: '关键词' }],
          notices: [],
        });
      }
      if (type === 'exec-instruction' && !handled.has(String(frame['nonce']))) {
        handled.add(String(frame['nonce']));
        const request = frame['request'] as { steps?: Array<{ action?: string; url?: string }> };
        const steps = request.steps ?? [];
        const navigate = steps.length === 1 && steps[0]?.action === 'navigate' ? steps[0] : null;
        if (navigate !== null) landedUrl = String(navigate.url);
        await postFrame(token, sessionId, {
          type: 'exec-result',
          sessionId,
          nonce: frame['nonce'],
          ok: true,
          body: navigate !== null ? { url: navigate.url } : { reads: { value: 'x' }, completedSteps: steps.length },
        });
      }
    }
    if (framesByType(sse.frames, 'turn-complete').length > 0) return;
    if (Date.now() > deadline) throw new Error(`回合未收口；已收帧：${JSON.stringify(sse.frames)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function joinedText(sse: SseHandle): string {
  return framesByType(sse.frames, 'text-delta')
    .map((frame) => String(frame['delta']))
    .join('');
}

describe('adr-028 任务级一次授权：首个动作带 task+plan 的 open_url 一卡授权整任务', () => {
  it('冷启动 open_url(task+plan) 仅弹一张卡；批准后同任务的页面操作与跨站导航自动放行，授权随落点延续', async () => {
    const token = await signToken();
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    try {
      await driveTurn(token, sessionId, sse, '带计划：在 A 站搜索并打开结果 B，告诉我核心内容');
      expect(joinedText(sse)).toContain(DONE_TEXT);

      const hitl = framesByType(sse.frames, 'hitl-request');
      expect(hitl).toHaveLength(1);
      expect(hitl[0]!['toolId']).toBe('open_url');
      expect((hitl[0]!['params'] as Record<string, unknown>)['plan']).toEqual(PLAN);
      expect(hitl[0]!['targetUrl']).toBe(SITE_A_URL);

      const verdicts = auditEventsFor(sessionId).filter((event) => event['type'] === 'hitl-verdict');
      expect(verdicts).toHaveLength(1);
      expect(decisionsOf(sessionId)).toEqual([
        { toolId: 'open_url', verdict: 'hitl' },
        { toolId: BROWSE_TOOL, verdict: 'allow' },
        { toolId: 'open_url', verdict: 'allow' },
        { toolId: BROWSE_TOOL, verdict: 'allow' },
      ]);
      const executions = auditEventsFor(sessionId).filter((event) => event['type'] === 'tool-execution');
      expect(executions.map((event) => (event['data'] as Record<string, unknown>)['outcome'])).toEqual(
        ['ok', 'ok', 'ok', 'ok'],
      );
      // 落点已切到 B（历史含指向 B origin 的站点边界标记，generic 围栏重绑），而 B 上的页面操作仍被放行：
      // 授权随任务延续到了新作用域——否则 (packId, packOrigin=B, task) 无授权、该批必弹卡。
      expect(boundariesSeen.some((boundary) => boundary.includes(SITE_B_ORIGIN))).toBe(true);
      const injection = await fetch(`${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/injection`, {
        headers: authHeaders(token),
      });
      expect(((await injection.json()) as { packId?: string }).packId).toBe('generic-web');
    } finally {
      sse.close();
    }
  });

  it('无 plan 的 open_url 批准只覆盖本次：同任务的后续页面操作仍弹卡（不登记授权）', async () => {
    const token = await signToken();
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    try {
      await driveTurn(token, sessionId, sse, '不带计划：在 A 站打开搜索页后操作');
      expect(joinedText(sse)).toContain(DONE_TEXT);

      const hitl = framesByType(sse.frames, 'hitl-request');
      expect(hitl.map((frame) => frame['toolId'])).toEqual(['open_url', BROWSE_TOOL]);
      expect(decisionsOf(sessionId)).toEqual([
        { toolId: 'open_url', verdict: 'hitl' },
        { toolId: BROWSE_TOOL, verdict: 'hitl' },
      ]);
    } finally {
      sse.close();
    }
  });
});
