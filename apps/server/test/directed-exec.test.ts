/**
 * adr-023 D3 定向副作用服务端闭环：同站多 tab 定向 dom 全链路（流程 B——目标页围栏命中、
 * HITL 目标页标注、签名指令带 page 且可复算）、越围栏拒签、silent 页定向 dom 拒签与引导（流程 C 前半）、
 * silent 页定向单步 navigate 获签、定向指令超时如实回喂（流程 D 语义）、缺省调用零变化回归、
 * HITL 卡目标 URL、定向 domContext 与活跃页 domContext 互相隔离、句柄退役清上下文。
 * 自带确定性 mock LLM（按用户哨兵语驱动 tool_call），不依赖 scripts/mock-llm 剧本面。
 */
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeExecSignature } from '@zen-agent/toolgate';
import { OPEN_URL_TOOL_ID } from '@zen-agent/contracts';
import type {
  ClientToolDefinition,
  DomToolDefinition,
  JsonObject,
  JsonValue,
} from '@zen-agent/contracts';
import { hitlTargetUrl } from '../src/gateway.js';
import { startServer, type RunningServer } from '../src/index.js';

const repoRoot = new URL('../../../', import.meta.url).pathname;
const snapshotRoot = join(repoRoot, 'examples/acceptance');
const systemPromptPath = join(repoRoot, 'assets/system-prompt.md');
const AUDIT_SINK = join(mkdtempSync(join(tmpdir(), 'za-directed-exec-audit-')), 'events.jsonl');

// 每次运行现生成：仓库内不留固定密钥串（SEC-01），值本身对断言无意义。
const JWT_SECRET = randomUUID();
const SIGNING_SECRET = randomUUID();
const ISS = 'zen-agent-demo';
const key = new TextEncoder().encode(JWT_SECRET);

const SITE_ORIGIN = 'https://mail.126.com';
const ACTIVE_URL = `${SITE_ORIGIN}/main`;
const DOM_TOOL = 'mail-126.page-operate';
const SNAPSHOT_TOOL = 'page_snapshot';
const OBS_ECHO_PREFIX = 'MOCK-DEXEC-OBS';
/** 代执行指令 TTL（毫秒）：流程 D 超时用例的时间窗；其余用例须在此窗内完成回传。 */
const EXEC_TTL_MS = 2000;

/** 异形句柄（非 p<N> 形状）：服务端只作等值比对，无按句柄结构分支（U5 续锚）。 */
const BG_HANDLE = 'ws-bg-01';
const BG_URL = `${SITE_ORIGIN}/folder?box=1`;
/** 竖线 + 控制字符：HITL targetPage.title 消毒防线的输入。 */
const BG_TITLE = '邮|箱\u0007夹';
const OUT_HANDLE = 'p-out';
const OUT_URL = 'https://other.example/page';
const SILENT_HANDLE = 'p-silent';
const SILENT_URL = `${SITE_ORIGIN}/box`;
const NAV_TARGET_URL = `${SITE_ORIGIN}/box`;
/** 右到左覆盖符（U+202E）：由码点构造，避免源码内嵌不可见字面量。 */
const RLO = String.fromCodePoint(0x202e);
/** 带双向控制符的围栏内导航目标：卡上呈现须归一为百分号编码，不得原样透出控制符。 */
const BIDI_NAV_URL = `${SITE_ORIGIN}/box?q=${RLO}exe.gnp`;
/** 超长导航目标：卡上呈现须按上限截断标注。 */
const LONG_NAV_URL = `${SITE_ORIGIN}/box?q=${RLO}${'a'.repeat(300)}`;
/** 另一已安装 pack（zhipin）围栏内 URL：定向跨站导航不得把活跃站点上下文切过去。 */
const CROSS_SITE_URL = 'https://www.zhipin.com/web/geek/job';

/** 有界履约工具（authorization.kind=bounded-fulfillment）：契约上不支持定向，targetPage 是被忽略的无效实参。 */
const BOUNDED_TOOL = 'xianyu-fulfillment.execute-intent';
const BOUNDED_ORIGIN = 'https://seller.goofish.com';
const BOUNDED_ACTIVE_URL = `${BOUNDED_ORIGIN}/#/im`;
const BOUNDED_BG_HANDLE = 'xy-bg';

interface DirectedMockHandle {
  port: number;
  close(): Promise<void>;
}

type MockDecision = { text: string } | { toolCall: { id: string; name: string; arguments: string } };

function domCall(id: string, params: Record<string, unknown>): MockDecision {
  return { toolCall: { id, name: DOM_TOOL, arguments: JSON.stringify(params) } };
}

/**
 * 首轮按用户哨兵语产出 tool_call；回喂轮按 observation 形态推进：
 * 定向快照观测（首行 `[来自 `）→ 发定向 dom 批次；缺省快照观测（`{"url"` 开头）→ 发后续 dom 批次；
 * 其余观测原样回显，供对回喂内容做机械断言。
 */
function decide(u: string, messages: Array<Record<string, unknown>>): MockDecision {
  const last = messages[messages.length - 1] as { role?: string; content?: unknown } | undefined;
  const obs = last?.role === 'tool' ? String(last.content ?? '') : null;
  if (obs !== null) {
    const directedOp = u.match(/定向操作\s+(\S+)/);
    if (obs.startsWith('[来自 ') && directedOp !== null) {
      return domCall('call_dom_directed', {
        task: '定向操作任务',
        plan: ['在目标页点击目标按钮'],
        steps: [{ action: 'click', ref: 'za-9' }],
        summary: '点击目标页按钮',
        targetPage: directedOp[1],
      });
    }
    if (obs.startsWith('{"url"') && u.includes('缺省快照后操作')) {
      return domCall('call_dom_default', {
        task: '活跃页操作任务',
        steps: [{ action: 'click', ref: 'za-9' }],
        summary: '点击活跃页按钮',
      });
    }
    if (obs.startsWith('{"url"') && u.includes('缺省快照后隔离定向')) {
      return domCall('call_dom_isolated', {
        task: '隔离定向任务',
        steps: [{ action: 'click', ref: 'za-9' }],
        summary: '定向点击目标页',
        targetPage: BG_HANDLE,
      });
    }
    return { text: `${OBS_ECHO_PREFIX} ${obs}` };
  }
  const directedOp = u.match(/定向操作\s+(\S+)/);
  if (directedOp !== null) {
    return {
      toolCall: {
        id: 'call_snap_directed',
        name: SNAPSHOT_TOOL,
        arguments: JSON.stringify({ targetPage: directedOp[1] }),
      },
    };
  }
  const directedSnap = u.match(/定向快照\s+(\S+)/);
  if (directedSnap !== null) {
    return {
      toolCall: {
        id: 'call_snap_only',
        name: SNAPSHOT_TOOL,
        arguments: JSON.stringify({ targetPage: directedSnap[1] }),
      },
    };
  }
  const boundedDirected = u.match(/有界履约带页参数\s+(\S+)/);
  if (boundedDirected !== null) {
    return {
      toolCall: {
        id: 'call_bounded_page',
        name: BOUNDED_TOOL,
        arguments: JSON.stringify({ intentId: 'intent-not-prepared', targetPage: boundedDirected[1] }),
      },
    };
  }
  const directClick = u.match(/直接定向点击\s+(\S+)/);
  if (directClick !== null) {
    return domCall('call_dom_direct', {
      task: '直接定向任务',
      steps: [{ action: 'click', ref: 'za-9' }],
      summary: '定向点击目标页',
      targetPage: directClick[1],
    });
  }
  const directedSiteNav = u.match(/定向跨站导航\s+(\S+)/);
  if (directedSiteNav !== null) {
    return {
      toolCall: {
        id: 'call_site_nav_directed',
        name: 'site_navigate',
        arguments: JSON.stringify({
          url: CROSS_SITE_URL,
          task: '定向跨站任务',
          targetPage: directedSiteNav[1],
        }),
      },
    };
  }
  const bidiNav = u.match(/定向导航伪装\s+(\S+)/);
  if (bidiNav !== null) {
    return domCall('call_dom_nav_bidi', {
      task: '导航激活任务',
      steps: [{ action: 'navigate', url: BIDI_NAV_URL }],
      summary: '导航激活目标页',
      targetPage: bidiNav[1],
    });
  }
  const longNav = u.match(/定向导航超长\s+(\S+)/);
  if (longNav !== null) {
    return domCall('call_dom_nav_long', {
      task: '导航激活任务',
      steps: [{ action: 'navigate', url: LONG_NAV_URL }],
      summary: '导航激活目标页',
      targetPage: longNav[1],
    });
  }
  const directedNav = u.match(/定向导航\s+(\S+)/);
  if (directedNav !== null) {
    return domCall('call_dom_nav', {
      task: '导航激活任务',
      steps: [{ action: 'navigate', url: NAV_TARGET_URL }],
      summary: '导航激活目标页',
      targetPage: directedNav[1],
    });
  }
  if (u.includes('缺省快照后')) {
    return { toolCall: { id: 'call_snap_default', name: SNAPSHOT_TOOL, arguments: JSON.stringify({}) } };
  }
  if (u.includes('跨站导航')) {
    return {
      toolCall: {
        id: 'call_site_nav',
        name: 'site_navigate',
        arguments: JSON.stringify({ url: `${SITE_ORIGIN}/write`, task: '跨站导航任务' }),
      },
    };
  }
  return { text: 'MOCK-DEXEC-DEFAULT' };
}

/** mock 收到的每次 LLM 请求侧写：工具面与历史中是否已注入站点边界标记（装配切换的可观测面）。 */
const mockSeen: Array<{ user: string; toolNames: string[]; boundary: boolean }> = [];

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
      const body = JSON.parse(raw) as {
        messages: Array<Record<string, unknown>>;
        tools?: Array<{ function?: { name?: string } }>;
      };
      const lastUser = [...body.messages].reverse().find((m) => m['role'] === 'user');
      mockSeen.push({
        user: String(lastUser?.['content'] ?? ''),
        toolNames: (body.tools ?? []).map((tool) => String(tool.function?.name ?? '')),
        boundary: body.messages.some((m) => String(m['content'] ?? '').includes('【站点边界】')),
      });
      const decision = decide(String(lastUser?.['content'] ?? ''), body.messages);
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const base = {
        id: 'chatcmpl-directed-exec-mock',
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
let baseUrl = '';

beforeAll(async () => {
  mock = await startDirectedMock();
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
    execInstructionTtlMs: EXEC_TTL_MS,
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

async function postFrame(
  token: string,
  sessionId: string,
  frame: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/frames`, {
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

/** 建会话并上报组页面状态表（active 活跃页 + 同站 background + 越围栏 background + 同站 silent）。 */
async function startGroupSession(token: string): Promise<{ sessionId: string; sse: SseHandle }> {
  const sessionId = await createSession(token);
  const sse = await openSse(token, sessionId);
  await postFrame(token, sessionId, { type: 'context-report', sessionId, url: ACTIVE_URL });
  await postFrame(token, sessionId, {
    type: 'group-pages',
    sessionId,
    pages: [
      { handle: 'act-1', url: ACTIVE_URL, title: '写信页', status: 'active' },
      { handle: BG_HANDLE, url: BG_URL, title: BG_TITLE, status: 'background' },
      { handle: OUT_HANDLE, url: OUT_URL, title: '外站页', status: 'background' },
      { handle: SILENT_HANDLE, url: SILENT_URL, status: 'silent' },
    ],
  });
  return { sessionId, sse };
}

/** 建会话并上报状态表：活跃页在有界履约 pack 的功能路由上，另有同站 background 页。 */
async function startBoundedSession(token: string): Promise<{ sessionId: string; sse: SseHandle }> {
  const sessionId = await createSession(token);
  const sse = await openSse(token, sessionId);
  await postFrame(token, sessionId, {
    type: 'context-report',
    sessionId,
    url: BOUNDED_ACTIVE_URL,
  });
  await postFrame(token, sessionId, {
    type: 'group-pages',
    sessionId,
    pages: [
      { handle: 'xy-act', url: BOUNDED_ACTIVE_URL, title: '消息页', status: 'active' },
      { handle: BOUNDED_BG_HANDLE, url: `${BOUNDED_ORIGIN}/#/im?x=1`, title: '另一消息页', status: 'background' },
    ],
  });
  return { sessionId, sse };
}

async function driveTurn(token: string, sessionId: string, text: string): Promise<Response> {
  return postFrame(token, sessionId, { type: 'user-message', sessionId, text });
}

async function awaitTurnComplete(sse: SseHandle): Promise<void> {
  await sse.waitFor(() => framesByType(sse.frames, 'turn-complete').length > 0);
}

function auditEventsFor(sessionId: string): Array<Record<string, unknown>> {
  const raw = readFileSync(AUDIT_SINK, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((event) => event['sessionId'] === sessionId);
}

function eventsOf(sessionId: string, type: string, toolKey: string, toolId: string) {
  return auditEventsFor(sessionId).filter(
    (event) =>
      event['type'] === type &&
      (event['data'] as Record<string, unknown>)[toolKey] === toolId,
  );
}

/** 与 toolgate 同一签名 payload 形状（定向落点以 targetPage 键取本帧 page 值）复算签名。 */
function recomputeSignature(
  sessionId: string,
  frame: Record<string, unknown>,
  withPage: boolean,
): string {
  return computeExecSignature(SIGNING_SECRET, {
    sessionId,
    nonce: frame['nonce'],
    issuedAt: frame['issuedAt'],
    expiresAt: frame['expiresAt'],
    ttl: frame['ttl'],
    toolCallId: frame['toolCallId'],
    ...(withPage && frame['page'] !== undefined ? { targetPage: frame['page'] } : {}),
    request: frame['request'],
  } as JsonValue);
}

describe('流程 B：同站多 tab 定向 dom 全链路', () => {
  it('定向快照建基准 → HITL 标注目标页（消毒 title+origin）→ 签名指令带 page 且可复算 → 审计三类事件填目标页', async () => {
    const token = await signToken();
    const { sessionId, sse } = await startGroupSession(token);
    try {
      await driveTurn(token, sessionId, `定向操作 ${BG_HANDLE}`);
      await sse.waitFor(() => framesByType(sse.frames, 'snapshot-request').length > 0);
      const snapRequest = framesByType(sse.frames, 'snapshot-request')[0]!;
      expect(snapRequest['page']).toBe(BG_HANDLE);
      await postFrame(token, sessionId, {
        type: 'snapshot-report',
        sessionId,
        requestId: String(snapRequest['requestId']),
        url: BG_URL,
        title: '文件夹页',
        elements: [{ ref: 'za-9', role: 'button', label: '目标按钮' }],
      });
      await sse.waitFor(() => framesByType(sse.frames, 'hitl-request').length > 0);
      const hitl = framesByType(sse.frames, 'hitl-request')[0]!;
      expect(hitl['toolId']).toBe(DOM_TOOL);
      // 目标页标注：title 消毒（竖线→¦、控制字符剔除）+ origin；navigate 类之外不发 targetUrl。
      expect(hitl['targetPage']).toEqual({ title: '邮¦箱夹', origin: SITE_ORIGIN });
      expect(hitl).not.toHaveProperty('targetUrl');
      await postFrame(token, sessionId, {
        type: 'hitl-decision',
        sessionId,
        hitlId: String(hitl['hitlId']),
        decision: 'approve',
      });
      await sse.waitFor(() => framesByType(sse.frames, 'exec-instruction').length > 0);
      const instruction = framesByType(sse.frames, 'exec-instruction')[0]!;
      expect(instruction['page']).toBe(BG_HANDLE);
      // 定向批次钉状态表目标页 URL：执行侧在副作用前就地核对，页走样即拒。
      expect(instruction['request']).toEqual({
        kind: 'dom',
        expectedPageUrl: BG_URL,
        steps: [{ action: 'click', ref: 'za-9' }],
      });
      // 一次性签名覆盖 targetPage：同 payload 可复算；剥落点复算即不等（篡改落点=验签失败）。
      expect(recomputeSignature(sessionId, instruction, true)).toBe(instruction['signature']);
      expect(recomputeSignature(sessionId, instruction, false)).not.toBe(instruction['signature']);
      await postFrame(token, sessionId, {
        type: 'exec-result',
        sessionId,
        nonce: String(instruction['nonce']),
        ok: true,
        body: { completedSteps: 1, url: BG_URL },
      });
      await sse.waitFor(() => joinedText(sse).includes(OBS_ECHO_PREFIX));
      await awaitTurnComplete(sse);
    } finally {
      sse.close();
    }
    const targetRef = { handle: BG_HANDLE, origin: SITE_ORIGIN };
    const decisions = eventsOf(sessionId, 'tool-decision', 'toolId', DOM_TOOL);
    expect(decisions).toHaveLength(1);
    expect((decisions[0]!['data'] as Record<string, unknown>)['verdict']).toBe('hitl');
    expect(decisions[0]!['page']).toEqual(targetRef);
    const verdicts = auditEventsFor(sessionId).filter((event) => event['type'] === 'hitl-verdict');
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!['page']).toEqual(targetRef);
    const executions = eventsOf(sessionId, 'tool-execution', 'toolId', DOM_TOOL);
    expect(executions).toHaveLength(1);
    expect((executions[0]!['data'] as Record<string, unknown>)['outcome']).toBe('ok');
    expect(executions[0]!['page']).toEqual(targetRef);
  });

  it('定向到活跃页自身句柄：同样按定向签发（帧带 page），HITL 不加目标页标注', async () => {
    const token = await signToken();
    const { sessionId, sse } = await startGroupSession(token);
    try {
      await driveTurn(token, sessionId, '定向操作 act-1');
      await sse.waitFor(() => framesByType(sse.frames, 'snapshot-request').length > 0);
      const snapRequest = framesByType(sse.frames, 'snapshot-request')[0]!;
      await postFrame(token, sessionId, {
        type: 'snapshot-report',
        sessionId,
        requestId: String(snapRequest['requestId']),
        url: ACTIVE_URL,
        title: '写信页',
        elements: [{ ref: 'za-9', role: 'button', label: '发送' }],
      });
      await sse.waitFor(() => framesByType(sse.frames, 'hitl-request').length > 0);
      const hitl = framesByType(sse.frames, 'hitl-request')[0]!;
      expect(hitl).not.toHaveProperty('targetPage');
      await postFrame(token, sessionId, {
        type: 'hitl-decision',
        sessionId,
        hitlId: String(hitl['hitlId']),
        decision: 'approve',
      });
      await sse.waitFor(() => framesByType(sse.frames, 'exec-instruction').length > 0);
      const instruction = framesByType(sse.frames, 'exec-instruction')[0]!;
      expect(instruction['page']).toBe('act-1');
      await postFrame(token, sessionId, {
        type: 'exec-result',
        sessionId,
        nonce: String(instruction['nonce']),
        ok: true,
        body: { completedSteps: 1, url: ACTIVE_URL },
      });
      await sse.waitFor(() => joinedText(sse).includes(OBS_ECHO_PREFIX));
      await awaitTurnComplete(sse);
    } finally {
      sse.close();
    }
  });
});

describe('定向拒签（U7：签发前 fail-closed、不下发帧、不回退活跃页）', () => {
  it('越围栏：目标页 origin 越出 pack 围栏即拒签，审计 deny 填目标页', async () => {
    const token = await signToken();
    const { sessionId, sse } = await startGroupSession(token);
    try {
      await driveTurn(token, sessionId, `直接定向点击 ${OUT_HANDLE}`);
      await sse.waitFor(() => joinedText(sse).includes(OBS_ECHO_PREFIX));
      await awaitTurnComplete(sse);
    } finally {
      sse.close();
    }
    expect(framesByType(sse.frames, 'exec-instruction')).toHaveLength(0);
    expect(framesByType(sse.frames, 'hitl-request')).toHaveLength(0);
    expect(joinedText(sse)).toContain('target-page-fence-violation');
    const decisions = eventsOf(sessionId, 'tool-decision', 'toolId', DOM_TOOL);
    expect(decisions).toHaveLength(1);
    expect((decisions[0]!['data'] as Record<string, unknown>)['verdict']).toBe('deny');
    expect(decisions[0]!['page']).toEqual({ handle: OUT_HANDLE, origin: 'https://other.example' });
  });

  it('句柄未命中：page-not-in-group 拒签，审计 page 仅带 handle', async () => {
    const token = await signToken();
    const { sessionId, sse } = await startGroupSession(token);
    try {
      await driveTurn(token, sessionId, '直接定向点击 p-ghost');
      await sse.waitFor(() => joinedText(sse).includes(OBS_ECHO_PREFIX));
      await awaitTurnComplete(sse);
    } finally {
      sse.close();
    }
    expect(framesByType(sse.frames, 'exec-instruction')).toHaveLength(0);
    expect(joinedText(sse)).toContain('page-not-in-group');
    const decisions = eventsOf(sessionId, 'tool-decision', 'toolId', DOM_TOOL);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!['page']).toEqual({ handle: 'p-ghost' });
  });

  it('silent 页定向 dom：拒签且回喂引导措辞（流程 C 前半），不发任何下行执行帧', async () => {
    const token = await signToken();
    const { sessionId, sse } = await startGroupSession(token);
    try {
      await driveTurn(token, sessionId, `直接定向点击 ${SILENT_HANDLE}`);
      await sse.waitFor(() => joinedText(sse).includes(OBS_ECHO_PREFIX));
      await awaitTurnComplete(sse);
    } finally {
      sse.close();
    }
    expect(framesByType(sse.frames, 'exec-instruction')).toHaveLength(0);
    expect(framesByType(sse.frames, 'hitl-request')).toHaveLength(0);
    const failedCards = framesByType(sse.frames, 'tool-card').filter(
      (frame) => frame['toolId'] === DOM_TOOL && frame['status'] === 'failed',
    );
    expect(failedCards.length).toBeGreaterThan(0);
    const text = joinedText(sse);
    expect(text).toContain('目标页不可交互');
    expect(text).toContain('导航激活');
    const decisions = eventsOf(sessionId, 'tool-decision', 'toolId', DOM_TOOL);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!['page']).toEqual({ handle: SILENT_HANDLE, origin: SITE_ORIGIN });
  });

  it('定向 domContext 隔离：只有活跃页快照时，定向 ref 批次 deny dom-context-missing（禁回退）', async () => {
    const token = await signToken();
    const { sessionId, sse } = await startGroupSession(token);
    try {
      await driveTurn(token, sessionId, '缺省快照后隔离定向');
      await sse.waitFor(() => framesByType(sse.frames, 'snapshot-request').length > 0);
      const snapRequest = framesByType(sse.frames, 'snapshot-request')[0]!;
      expect(snapRequest).not.toHaveProperty('page');
      await postFrame(token, sessionId, {
        type: 'snapshot-report',
        sessionId,
        requestId: String(snapRequest['requestId']),
        url: ACTIVE_URL,
        title: '写信页',
        elements: [{ ref: 'za-9', role: 'button', label: '发送' }],
      });
      await sse.waitFor(() => joinedText(sse).includes(OBS_ECHO_PREFIX));
      await awaitTurnComplete(sse);
    } finally {
      sse.close();
    }
    expect(joinedText(sse)).toContain('dom-context-missing');
    expect(framesByType(sse.frames, 'exec-instruction')).toHaveLength(0);
    expect(framesByType(sse.frames, 'hitl-request')).toHaveLength(0);
  });

  it('句柄退役即清定向快照上下文：同名句柄重入组后 ref 批次仍 deny dom-context-missing', async () => {
    const token = await signToken();
    const { sessionId, sse } = await startGroupSession(token);
    try {
      await driveTurn(token, sessionId, `定向快照 ${BG_HANDLE}`);
      await sse.waitFor(() => framesByType(sse.frames, 'snapshot-request').length > 0);
      const snapRequest = framesByType(sse.frames, 'snapshot-request')[0]!;
      await postFrame(token, sessionId, {
        type: 'snapshot-report',
        sessionId,
        requestId: String(snapRequest['requestId']),
        url: BG_URL,
        title: '文件夹页',
        elements: [{ ref: 'za-9', role: 'button', label: '目标按钮' }],
      });
      await sse.waitFor(() => joinedText(sse).includes(OBS_ECHO_PREFIX));
      await awaitTurnComplete(sse);
      // 句柄退役（新状态表不含 BG_HANDLE）→ 再重入组：per-handle 上下文须已被清除。
      await postFrame(token, sessionId, {
        type: 'group-pages',
        sessionId,
        pages: [{ handle: 'act-1', url: ACTIVE_URL, title: '写信页', status: 'active' }],
      });
      await postFrame(token, sessionId, {
        type: 'group-pages',
        sessionId,
        pages: [
          { handle: 'act-1', url: ACTIVE_URL, title: '写信页', status: 'active' },
          { handle: BG_HANDLE, url: BG_URL, title: '文件夹页', status: 'background' },
        ],
      });
      await driveTurn(token, sessionId, `直接定向点击 ${BG_HANDLE}`);
      await sse.waitFor(() =>
        joinedText(sse).includes('dom-context-missing'),
      );
      await awaitTurnComplete(sse);
    } finally {
      sse.close();
    }
    expect(framesByType(sse.frames, 'exec-instruction')).toHaveLength(0);
  });
});

describe('流程 C 后半与流程 D：silent 页定向 navigate', () => {
  it('silent 页定向单步 navigate 获签：HITL 带目标 URL 与目标页标注，指令带 page', async () => {
    const token = await signToken();
    const { sessionId, sse } = await startGroupSession(token);
    try {
      await driveTurn(token, sessionId, `定向导航 ${SILENT_HANDLE}`);
      await sse.waitFor(() => framesByType(sse.frames, 'hitl-request').length > 0);
      const hitl = framesByType(sse.frames, 'hitl-request')[0]!;
      expect(hitl['targetUrl']).toBe(NAV_TARGET_URL);
      // silent 行无 title：targetPage 只有 origin。
      expect(hitl['targetPage']).toEqual({ origin: SITE_ORIGIN });
      await postFrame(token, sessionId, {
        type: 'hitl-decision',
        sessionId,
        hitlId: String(hitl['hitlId']),
        decision: 'approve',
      });
      await sse.waitFor(() => framesByType(sse.frames, 'exec-instruction').length > 0);
      const instruction = framesByType(sse.frames, 'exec-instruction')[0]!;
      expect(instruction['page']).toBe(SILENT_HANDLE);
      expect(instruction['request']).toEqual({
        kind: 'dom',
        steps: [{ action: 'navigate', url: NAV_TARGET_URL }],
      });
      expect(recomputeSignature(sessionId, instruction, true)).toBe(instruction['signature']);
      await postFrame(token, sessionId, {
        type: 'exec-result',
        sessionId,
        nonce: String(instruction['nonce']),
        ok: true,
        body: { url: NAV_TARGET_URL },
      });
      await sse.waitFor(() => joinedText(sse).includes(OBS_ECHO_PREFIX));
      await awaitTurnComplete(sse);
    } finally {
      sse.close();
    }
    const executions = eventsOf(sessionId, 'tool-execution', 'toolId', DOM_TOOL);
    expect(executions).toHaveLength(1);
    expect((executions[0]!['data'] as Record<string, unknown>)['outcome']).toBe('ok');
    expect(executions[0]!['page']).toEqual({ handle: SILENT_HANDLE, origin: SITE_ORIGIN });
  });

  it('流程 D：签发后目标不可达（无 exec-result）→ 超时如实回喂，不改投、无第二道指令', async () => {
    const token = await signToken();
    const { sessionId, sse } = await startGroupSession(token);
    try {
      await driveTurn(token, sessionId, `定向导航 ${SILENT_HANDLE}`);
      await sse.waitFor(() => framesByType(sse.frames, 'hitl-request').length > 0);
      const hitl = framesByType(sse.frames, 'hitl-request')[0]!;
      await postFrame(token, sessionId, {
        type: 'hitl-decision',
        sessionId,
        hitlId: String(hitl['hitlId']),
        decision: 'approve',
      });
      await sse.waitFor(() => framesByType(sse.frames, 'exec-instruction').length > 0);
      // 不回传 exec-result：等待器按指令 TTL 主动超时，观测如实回喂失败。
      await sse.waitFor(
        () => joinedText(sse).includes(OBS_ECHO_PREFIX),
        EXEC_TTL_MS + 8000,
      );
      await awaitTurnComplete(sse);
    } finally {
      sse.close();
    }
    expect(framesByType(sse.frames, 'exec-instruction')).toHaveLength(1);
    expect(joinedText(sse)).toContain('"error":"timeout"');
    const executions = eventsOf(sessionId, 'tool-execution', 'toolId', DOM_TOOL);
    expect(executions).toHaveLength(1);
    expect((executions[0]!['data'] as Record<string, unknown>)['outcome']).toBe('timeout');
    expect(executions[0]!['page']).toEqual({ handle: SILENT_HANDLE, origin: SITE_ORIGIN });
  });
});

describe('签发时刻重校验与定向导航上下文（fail-closed 收口）', () => {
  it('HITL 等待期间目标句柄退役：批准后签发拒绝如实回喂，无 exec-instruction', async () => {
    const token = await signToken();
    const { sessionId, sse } = await startGroupSession(token);
    try {
      await driveTurn(token, sessionId, `定向导航 ${SILENT_HANDLE}`);
      await sse.waitFor(() => framesByType(sse.frames, 'hitl-request').length > 0);
      const hitl = framesByType(sse.frames, 'hitl-request')[0]!;
      // HITL 挂起期间目标页关闭：状态表退役该句柄，批准后签发须按新表拒绝。
      await postFrame(token, sessionId, {
        type: 'group-pages',
        sessionId,
        pages: [
          { handle: 'act-1', url: ACTIVE_URL, title: '写信页', status: 'active' },
          { handle: BG_HANDLE, url: BG_URL, title: BG_TITLE, status: 'background' },
        ],
      });
      await postFrame(token, sessionId, {
        type: 'hitl-decision',
        sessionId,
        hitlId: String(hitl['hitlId']),
        decision: 'approve',
      });
      await sse.waitFor(() => joinedText(sse).includes('page-not-in-group'));
      await awaitTurnComplete(sse);
    } finally {
      sse.close();
    }
    expect(framesByType(sse.frames, 'exec-instruction')).toHaveLength(0);
    const executions = eventsOf(sessionId, 'tool-execution', 'toolId', DOM_TOOL);
    expect(executions).toHaveLength(1);
    expect((executions[0]!['data'] as Record<string, unknown>)['outcome']).toBe('error');
  });

  it('定向 site_navigate 成功不切活跃站点上下文：无边界标记、下一轮工具面仍按活跃页装配', async () => {
    const token = await signToken();
    const { sessionId, sse } = await startGroupSession(token);
    try {
      await driveTurn(token, sessionId, `定向跨站导航 ${SILENT_HANDLE}`);
      await sse.waitFor(() => framesByType(sse.frames, 'hitl-request').length > 0);
      const hitl = framesByType(sse.frames, 'hitl-request')[0]!;
      expect(hitl['targetUrl']).toBe(CROSS_SITE_URL);
      await postFrame(token, sessionId, {
        type: 'hitl-decision',
        sessionId,
        hitlId: String(hitl['hitlId']),
        decision: 'approve',
      });
      await sse.waitFor(() => framesByType(sse.frames, 'exec-instruction').length > 0);
      const instruction = framesByType(sse.frames, 'exec-instruction')[0]!;
      expect(instruction['page']).toBe(SILENT_HANDLE);
      await postFrame(token, sessionId, {
        type: 'exec-result',
        sessionId,
        nonce: String(instruction['nonce']),
        ok: true,
        body: { url: CROSS_SITE_URL },
      });
      await sse.waitFor(() => joinedText(sse).includes(OBS_ECHO_PREFIX));
      await awaitTurnComplete(sse);
      await driveTurn(token, sessionId, '上下文检查');
      await sse.waitFor(() => framesByType(sse.frames, 'turn-complete').length > 1);
    } finally {
      sse.close();
    }
    const check = mockSeen.filter((request) => request.user === '上下文检查').at(-1);
    expect(check).toBeDefined();
    // 定向导航不改变活跃页：装配仍按活跃页（mail-126 dom 工具在面）、历史无站点边界标记。
    expect(check!.toolNames).toContain('mail-126__page-operate');
    expect(check!.boundary).toBe(false);
  });
});

describe('不支持定向的工具带 targetPage：不作目标页标注', () => {
  it('有界履约工具的 targetPage 是无效实参：审计仍按活跃页归因，不标成被传入的句柄', async () => {
    const token = await signToken();
    const { sessionId, sse } = await startBoundedSession(token);
    try {
      await driveTurn(token, sessionId, `有界履约带页参数 ${BOUNDED_BG_HANDLE}`);
      await sse.waitFor(() => joinedText(sse).includes(OBS_ECHO_PREFIX));
      await awaitTurnComplete(sse);
    } finally {
      sse.close();
    }
    expect(framesByType(sse.frames, 'exec-instruction')).toHaveLength(0);
    const decisions = eventsOf(sessionId, 'tool-decision', 'toolId', BOUNDED_TOOL);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!['page']).toEqual({ handle: 'xy-act', origin: BOUNDED_ORIGIN });
  });
});

describe('HITL 卡目标 URL 与缺省零变化回归', () => {
  it('site_navigate：HITL 卡恒带 targetUrl=params.url，缺省不带 targetPage', async () => {
    const token = await signToken();
    const { sessionId, sse } = await startGroupSession(token);
    try {
      await driveTurn(token, sessionId, '跨站导航');
      await sse.waitFor(() => framesByType(sse.frames, 'hitl-request').length > 0);
      const hitl = framesByType(sse.frames, 'hitl-request')[0]!;
      expect(hitl['toolId']).toBe('site_navigate');
      expect(hitl['targetUrl']).toBe(`${SITE_ORIGIN}/write`);
      expect(hitl).not.toHaveProperty('targetPage');
      await postFrame(token, sessionId, {
        type: 'hitl-decision',
        sessionId,
        hitlId: String(hitl['hitlId']),
        decision: 'reject',
      });
      await sse.waitFor(() => joinedText(sse).includes(OBS_ECHO_PREFIX));
      await awaitTurnComplete(sse);
    } finally {
      sse.close();
    }
    expect(joinedText(sse)).toContain('user-rejected');
    expect(framesByType(sse.frames, 'exec-instruction')).toHaveLength(0);
  });

  it('缺省调用零变化：exec 帧无 page 键、签名按缺省 payload 可复算、HITL 无目标页字段、审计回落活跃页', async () => {
    const token = await signToken();
    const { sessionId, sse } = await startGroupSession(token);
    try {
      await driveTurn(token, sessionId, '缺省快照后操作');
      await sse.waitFor(() => framesByType(sse.frames, 'snapshot-request').length > 0);
      const snapRequest = framesByType(sse.frames, 'snapshot-request')[0]!;
      expect(snapRequest).not.toHaveProperty('page');
      await postFrame(token, sessionId, {
        type: 'snapshot-report',
        sessionId,
        requestId: String(snapRequest['requestId']),
        url: ACTIVE_URL,
        title: '写信页',
        elements: [{ ref: 'za-9', role: 'button', label: '发送' }],
      });
      await sse.waitFor(() => framesByType(sse.frames, 'hitl-request').length > 0);
      const hitl = framesByType(sse.frames, 'hitl-request')[0]!;
      expect(hitl).not.toHaveProperty('targetPage');
      expect(hitl).not.toHaveProperty('targetUrl');
      await postFrame(token, sessionId, {
        type: 'hitl-decision',
        sessionId,
        hitlId: String(hitl['hitlId']),
        decision: 'approve',
      });
      await sse.waitFor(() => framesByType(sse.frames, 'exec-instruction').length > 0);
      const instruction = framesByType(sse.frames, 'exec-instruction')[0]!;
      expect(instruction).not.toHaveProperty('page');
      expect(recomputeSignature(sessionId, instruction, false)).toBe(instruction['signature']);
      await postFrame(token, sessionId, {
        type: 'exec-result',
        sessionId,
        nonce: String(instruction['nonce']),
        ok: true,
        body: { completedSteps: 1, url: ACTIVE_URL },
      });
      await sse.waitFor(() => joinedText(sse).includes(OBS_ECHO_PREFIX));
      await awaitTurnComplete(sse);
    } finally {
      sse.close();
    }
    const executions = eventsOf(sessionId, 'tool-execution', 'toolId', DOM_TOOL);
    expect(executions).toHaveLength(1);
    // 缺省调用审计仍按活跃页填充（D1 语义零变化）。
    expect(executions[0]!['page']).toEqual({ handle: 'act-1', origin: SITE_ORIGIN });
  });

  it('带双向控制符的导航目标：卡上呈现归一后的 URL（控制符不透出），签发仍用原始 URL', async () => {
    const token = await signToken();
    const { sessionId, sse } = await startGroupSession(token);
    try {
      await driveTurn(token, sessionId, `定向导航伪装 ${SILENT_HANDLE}`);
      await sse.waitFor(() => framesByType(sse.frames, 'hitl-request').length > 0);
      const hitl = framesByType(sse.frames, 'hitl-request')[0]!;
      expect(hitl['targetUrl']).toBe(`${SITE_ORIGIN}/box?q=%E2%80%AEexe.gnp`);
      expect(String(hitl['targetUrl'])).not.toContain(RLO);
      await postFrame(token, sessionId, {
        type: 'hitl-decision',
        sessionId,
        hitlId: String(hitl['hitlId']),
        decision: 'approve',
      });
      await sse.waitFor(() => framesByType(sse.frames, 'exec-instruction').length > 0);
      // 展示归一是呈现层的事：签发指令仍是原始参数，签名与执行语义不受影响。
      const instruction = framesByType(sse.frames, 'exec-instruction')[0]!;
      expect(instruction['request']).toEqual({
        kind: 'dom',
        steps: [{ action: 'navigate', url: BIDI_NAV_URL }],
      });
      await postFrame(token, sessionId, {
        type: 'exec-result',
        sessionId,
        nonce: String(instruction['nonce']),
        ok: true,
        body: { url: BIDI_NAV_URL },
      });
      await sse.waitFor(() => joinedText(sse).includes(OBS_ECHO_PREFIX));
      await awaitTurnComplete(sse);
    } finally {
      sse.close();
    }
  });

  it('超长导航目标：卡上呈现按上限截断并标注，不透出双向控制符', async () => {
    const token = await signToken();
    const { sessionId, sse } = await startGroupSession(token);
    try {
      await driveTurn(token, sessionId, `定向导航超长 ${SILENT_HANDLE}`);
      await sse.waitFor(() => framesByType(sse.frames, 'hitl-request').length > 0);
      const hitl = framesByType(sse.frames, 'hitl-request')[0]!;
      const shown = String(hitl['targetUrl']);
      expect(shown.startsWith(`${SITE_ORIGIN}/box?q=%E2%80%AE`)).toBe(true);
      expect(shown.endsWith('…')).toBe(true);
      expect(shown).toHaveLength(201);
      expect(shown).not.toContain(RLO);
      await postFrame(token, sessionId, {
        type: 'hitl-decision',
        sessionId,
        hitlId: String(hitl['hitlId']),
        decision: 'reject',
      });
      await sse.waitFor(() => joinedText(sse).includes(OBS_ECHO_PREFIX));
      await awaitTurnComplete(sse);
    } finally {
      sse.close();
    }
  });
});

/**
 * HITL 卡目标地址的取值口径（纯函数）：卡上只呈现本次将被签发执行的目标。
 * 有界履约的步骤由服务端可信意图决定、params.steps 不参与签发，故其 params 中的 URL 不得呈现——
 * 该形态在当前 toolgate 裁决下不产出 hitl 判定，只能就取值口径本身断言。
 */
describe('hitlTargetUrl 取值口径', () => {
  const domFixture: DomToolDefinition = {
    id: 'mail-126.page-operate',
    featureIds: ['mail-compose'],
    description: '',
    params: {},
    riskTier: 'hitl',
    execution: 'client',
    adapter: { kind: 'dom', pathPrefixes: ['/'] },
    resultSchema: {},
  };
  const boundedFixture: DomToolDefinition = {
    ...domFixture,
    id: 'xianyu-fulfillment.execute-intent',
    authorization: {
      kind: 'bounded-fulfillment',
      workflow: 'delivery',
      intentIdParam: 'intentId',
    },
  };
  const openUrlFixture: ClientToolDefinition = {
    id: OPEN_URL_TOOL_ID,
    featureIds: [],
    description: '',
    params: {},
    riskTier: 'hitl',
    execution: 'client',
    adapter: { method: 'GET', urlTemplate: 'https://example.com' },
    resultSchema: {},
  };
  const navParams = (url: string): JsonObject => ({
    task: '导航任务',
    summary: '导航',
    steps: [{ action: 'navigate', url }],
  });

  it('无 authorization 的 dom 单步 navigate：取 steps[0].url 并归一后呈现', () => {
    expect(hitlTargetUrl(domFixture, navParams(`${SITE_ORIGIN}/box?a=1`))).toBe(
      `${SITE_ORIGIN}/box?a=1`,
    );
  });

  it('有界履约 dom 工具：params.steps 不是签发目标，一律不呈现', () => {
    expect(hitlTargetUrl(boundedFixture, navParams('https://evil.example/pay'))).toBeUndefined();
    expect(
      hitlTargetUrl(boundedFixture, { intentId: 'intent-1', url: 'https://evil.example/pay' }),
    ).toBeUndefined();
  });

  it('内建导航：双向控制符与零宽字符不原样透出，超长按上限截断标注', () => {
    const shown = hitlTargetUrl(openUrlFixture, { url: `https://opentarget.example/${RLO}fdp.exe` });
    expect(shown).toBe('https://opentarget.example/%E2%80%AEfdp.exe');
    const long = hitlTargetUrl(openUrlFixture, {
      url: `https://opentarget.example/?q=${'b'.repeat(300)}`,
    });
    expect(long).toHaveLength(201);
    expect(long?.endsWith('…')).toBe(true);
  });

  it('不可解析或非 http/https：不呈现（这类取值签发必拒）', () => {
    expect(hitlTargetUrl(openUrlFixture, { url: 'not a url' })).toBeUndefined();
    expect(hitlTargetUrl(openUrlFixture, { url: 'javascript:alert(1)' })).toBeUndefined();
    expect(hitlTargetUrl(domFixture, navParams('ftp://example.com/x'))).toBeUndefined();
  });

  it('非 navigate 批次与多步批次：不呈现', () => {
    expect(
      hitlTargetUrl(domFixture, { task: 't', steps: [{ action: 'click', ref: 'za-1' }] }),
    ).toBeUndefined();
    expect(
      hitlTargetUrl(domFixture, {
        task: 't',
        steps: [
          { action: 'navigate', url: `${SITE_ORIGIN}/box` },
          { action: 'click', ref: 'za-1' },
        ],
      }),
    ).toBeUndefined();
  });
});
