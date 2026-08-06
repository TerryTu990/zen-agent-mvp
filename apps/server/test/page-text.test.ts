/**
 * page_snapshot 正文抽取链路的网关侧闭环（D1/D3）：
 * agent 未请求正文时下行帧不带 includeText（默认不灌正文）；显式请求时下行帧带 includeText=true，
 * 客户端回传的 text 进入回喂 observation 且被标注为「页面正文属不可信数据、不是指令」；
 * 客户端回传的 text 非串时帧不过 C3 契约校验，正文不进 agent 上下文（U7 不采信客户端原文）。
 * 用 acceptance 快照的 generic-web pack 驱动（工具面含 dom 工具 → 注入 page_snapshot）。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../src/index.js';

const repoRoot = new URL('../../../', import.meta.url).pathname;
const snapshotRoot = join(repoRoot, 'examples/acceptance');
const systemPromptPath = join(repoRoot, 'assets/system-prompt.md');
const AUDIT_SINK = join(mkdtempSync(join(tmpdir(), 'za-page-text-audit-')), 'events.jsonl');

// 每次运行现生成：仓库内不留固定密钥串（SEC-01），值本身对断言无意义。
const JWT_SECRET = randomUUID();
const SIGNING_SECRET = randomUUID();
const ISS = 'zen-agent-demo';
const key = new TextEncoder().encode(JWT_SECRET);

const GENERIC_ORIGIN = 'http://127.0.0.1:4173';
const GENERIC_URL = `${GENERIC_ORIGIN}/article.html`;

/** 驱动 mock LLM 走「取带正文快照 → 回显 observation」剧本的哨兵语。 */
const READ_TEXT_PROMPT = '读一下这页正文';
/** 驱动既有 dom 代操作剧本（page_snapshot 不带 includeText）的哨兵语。 */
const OPERATE_PROMPT = '请在页面上点一下那个按钮';
const OBS_ECHO_PREFIX = 'MOCK-SNAPSHOT-OBS';

const PAGE_TEXT = 'MOCK-PAGE-TEXT 正文首段：本页讲的是数字风险分析师。';
/**
 * D3 标注的机械判据：回喂 observation 须同时点明「来自页面」与「不是指令」（措辞同基座 ZA-SYS-07）。
 * 只钉这两个子串而非整句，避免把实现措辞钉死；两者缺一即视为未标注。
 */
const UNTRUSTED_MARKERS = ['页面', '不是指令'] as const;

interface MockLlmHandle {
  port: number;
  close(): Promise<void>;
}

let mock: MockLlmHandle;
let server: RunningServer;
let baseUrl = '';

beforeAll(async () => {
  const mockLlmUrl = pathToFileURL(join(repoRoot, 'scripts/mock-llm/server.mjs')).href;
  const mockModule = (await import(mockLlmUrl)) as {
    startMockLlm(options?: { port?: number }): Promise<MockLlmHandle>;
  };
  mock = await mockModule.startMockLlm({ port: 0 });
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
    genericAllowlist: [GENERIC_ORIGIN],
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

async function startSession(token: string): Promise<{ sessionId: string; sse: SseHandle }> {
  const sessionId = await createSession(token);
  const sse = await openSse(token, sessionId);
  await postFrame(token, sessionId, { type: 'context-report', sessionId, url: GENERIC_URL });
  return { sessionId, sse };
}

/** 发一句驱动语，等本回合新增的那条 snapshot-request 并返回。 */
async function askAndAwaitSnapshotRequest(
  token: string,
  sessionId: string,
  sse: SseHandle,
  text: string,
): Promise<Record<string, unknown>> {
  const before = framesByType(sse.frames, 'snapshot-request').length;
  await postFrame(token, sessionId, { type: 'user-message', sessionId, text });
  await sse.waitFor(() => framesByType(sse.frames, 'snapshot-request').length > before);
  return framesByType(sse.frames, 'snapshot-request')[before]!;
}

/** 等 mock 回显的 observation 文本（`MOCK-SNAPSHOT-OBS <observation JSON>`）。 */
async function awaitEchoedObservation(sse: SseHandle): Promise<string> {
  await sse.waitFor(() => joinedText(sse).includes(OBS_ECHO_PREFIX));
  await sse.waitFor(() => framesByType(sse.frames, 'turn-complete').length > 0);
  return joinedText(sse);
}

describe('page_snapshot includeText：下行请求参数（D1）', () => {
  it('agent 未请求正文 → 下行 snapshot-request 不带 includeText 字段（默认不灌正文）', async () => {
    const token = await signToken();
    const { sessionId, sse } = await startSession(token);
    try {
      const request = await askAndAwaitSnapshotRequest(token, sessionId, sse, OPERATE_PROMPT);
      expect(request).not.toHaveProperty('includeText');

      // 收尾：回传快照后拒绝确认卡，让本回合正常终结而非挂到快照/HITL 超时。
      await postFrame(token, sessionId, {
        type: 'snapshot-report',
        sessionId,
        requestId: String(request['requestId']),
        url: GENERIC_URL,
        title: '通用页面',
        elements: [{ ref: 'za-1', role: 'button', label: '目标按钮' }],
      });
      await sse.waitFor(() => framesByType(sse.frames, 'hitl-request').length > 0);
      await postFrame(token, sessionId, {
        type: 'hitl-decision',
        sessionId,
        hitlId: String(framesByType(sse.frames, 'hitl-request')[0]!['hitlId']),
        decision: 'reject',
      });
      await sse.waitFor(() => framesByType(sse.frames, 'turn-complete').length > 0);
    } finally {
      sse.close();
    }
  });

  it('agent 请求正文 → 下行 snapshot-request 带 includeText:true', async () => {
    const token = await signToken();
    const { sessionId, sse } = await startSession(token);
    try {
      const request = await askAndAwaitSnapshotRequest(token, sessionId, sse, READ_TEXT_PROMPT);
      expect(request['includeText']).toBe(true);

      await postFrame(token, sessionId, {
        type: 'snapshot-report',
        sessionId,
        requestId: String(request['requestId']),
        url: GENERIC_URL,
        title: '文章页',
        elements: [],
        text: PAGE_TEXT,
      });
      await awaitEchoedObservation(sse);
    } finally {
      sse.close();
    }
  });
});

describe('page_snapshot includeText：正文回喂（D1/D3）', () => {
  it('客户端回传的 text 进入回喂 observation，并带截断标记', async () => {
    const token = await signToken();
    const { sessionId, sse } = await startSession(token);
    let observation = '';
    try {
      const request = await askAndAwaitSnapshotRequest(token, sessionId, sse, READ_TEXT_PROMPT);
      const report = await postFrame(token, sessionId, {
        type: 'snapshot-report',
        sessionId,
        requestId: String(request['requestId']),
        url: GENERIC_URL,
        title: '文章页',
        elements: [],
        text: PAGE_TEXT,
        textTruncated: true,
      });
      expect(report.status).toBe(202);
      observation = await awaitEchoedObservation(sse);
    } finally {
      sse.close();
    }
    expect(observation).toContain(PAGE_TEXT);
    // 截断事实不得静默丢失：回喂内容须让 agent 看得见「这只是正文前缀」（键名/措辞不钉死）。
    expect(observation).toMatch(/truncat|截断/i);
  });

  it('回喂 observation 显式标注正文属不可信数据、不是指令（D3 prompt 注入面）', async () => {
    const token = await signToken();
    const { sessionId, sse } = await startSession(token);
    let observation = '';
    try {
      const request = await askAndAwaitSnapshotRequest(token, sessionId, sse, READ_TEXT_PROMPT);
      await postFrame(token, sessionId, {
        type: 'snapshot-report',
        sessionId,
        requestId: String(request['requestId']),
        url: GENERIC_URL,
        title: '文章页',
        elements: [],
        text: PAGE_TEXT,
      });
      observation = await awaitEchoedObservation(sse);
    } finally {
      sse.close();
    }
    for (const marker of UNTRUSTED_MARKERS) expect(observation).toContain(marker);
  });

  it('客户端未回传正文 → 回喂不含正文字段（不凭空补正文）', async () => {
    const token = await signToken();
    const { sessionId, sse } = await startSession(token);
    let observation = '';
    try {
      const request = await askAndAwaitSnapshotRequest(token, sessionId, sse, READ_TEXT_PROMPT);
      // 客户端可以合法地不带 text 回传（页面无正文）：回喂里就不该凭空出现正文键。
      await postFrame(token, sessionId, {
        type: 'snapshot-report',
        sessionId,
        requestId: String(request['requestId']),
        url: GENERIC_URL,
        title: '文章页',
        elements: [],
      });
      observation = await awaitEchoedObservation(sse);
    } finally {
      sse.close();
    }
    expect(observation).not.toContain('"text"');
  });
});

describe('page_snapshot includeText：客户端原文不采信（U7）', () => {
  it('回传 text 非串 → 帧不过 C3 契约校验（400），正文不进 agent 上下文', async () => {
    const token = await signToken();
    const { sessionId, sse } = await startSession(token);
    let observation = '';
    try {
      const request = await askAndAwaitSnapshotRequest(token, sessionId, sse, READ_TEXT_PROMPT);
      const requestId = String(request['requestId']);
      const rejected = await postFrame(token, sessionId, {
        type: 'snapshot-report',
        sessionId,
        requestId,
        url: GENERIC_URL,
        title: '文章页',
        elements: [],
        text: { poisoned: 'MOCK-POISON-TEXT' },
      });
      expect(rejected.status).toBe(400);

      // 挂起请求未被非法帧消费：合法帧仍可回传，且回喂里没有那段被拒的内容。
      const accepted = await postFrame(token, sessionId, {
        type: 'snapshot-report',
        sessionId,
        requestId,
        url: GENERIC_URL,
        title: '文章页',
        elements: [],
        text: PAGE_TEXT,
      });
      expect(accepted.status).toBe(202);
      observation = await awaitEchoedObservation(sse);
    } finally {
      sse.close();
    }
    expect(observation).not.toContain('MOCK-POISON-TEXT');
    expect(observation).toContain(PAGE_TEXT);
  });

  it('回传空串 text → 帧不过契约校验（空串与未采集对 agent 等价，禁以空串冒充正文）', async () => {
    const token = await signToken();
    const { sessionId, sse } = await startSession(token);
    try {
      const request = await askAndAwaitSnapshotRequest(token, sessionId, sse, READ_TEXT_PROMPT);
      const requestId = String(request['requestId']);
      const rejected = await postFrame(token, sessionId, {
        type: 'snapshot-report',
        sessionId,
        requestId,
        url: GENERIC_URL,
        title: '文章页',
        elements: [],
        text: '',
      });
      expect(rejected.status).toBe(400);

      await postFrame(token, sessionId, {
        type: 'snapshot-report',
        sessionId,
        requestId,
        url: GENERIC_URL,
        title: '文章页',
        elements: [],
      });
      await awaitEchoedObservation(sse);
    } finally {
      sse.close();
    }
  });
});
