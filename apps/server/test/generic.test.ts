/**
 * generic-web 兜底 pack 的服务端准入闭环（U7 fail-closed）：
 * 活跃页 origin 在准入名单内才激活 generic pack；名单外/未设名单/取不到 origin 一律回落仅基座。
 * 激活后 packOrigin 以活跃页 origin 动态绑定——快照 origin 越界由 toolgate deny，
 * every-call 工具逐批独立确认、授权不复用。用 acceptance 快照（含 generic-web pack）驱动。
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseGenericAllowlist, startServer, type RunningServer } from '../src/index.js';
import { canonicalizeOrigin } from '../src/gateway.js';

const repoRoot = new URL('../../../', import.meta.url).pathname;
const snapshotRoot = join(repoRoot, 'examples/acceptance');
const systemPromptPath = join(repoRoot, 'assets/system-prompt.md');
const AUDIT_SINK = join(mkdtempSync(join(tmpdir(), 'za-generic-audit-')), 'events.jsonl');

const JWT_SECRET = 'za-test-secret';
const SIGNING_SECRET = 'za-test-signing-secret';
const ISS = 'zen-agent-demo';
const key = new TextEncoder().encode(JWT_SECRET);

const GENERIC_ORIGIN = 'http://127.0.0.1:4173';
const GENERIC_URL = `${GENERIC_ORIGIN}/order-list.html`;
const OUTSIDE_URL = 'https://outside.example/page';
const TOOL_BROWSE = 'browse.page-operate';

interface MockLlmHandle {
  port: number;
  close(): Promise<void>;
}

let mock: MockLlmHandle;
let server: RunningServer;
let bareServer: RunningServer;
let baseUrl = '';
let bareBaseUrl = '';

beforeAll(async () => {
  const mockLlmUrl = pathToFileURL(join(repoRoot, 'scripts/mock-llm/server.mjs')).href;
  const mockModule = (await import(mockLlmUrl)) as {
    startMockLlm(options?: { port?: number }): Promise<MockLlmHandle>;
  };
  mock = await mockModule.startMockLlm({ port: 0 });
  process.env['ZA_LLM_BASE_URL'] = `http://127.0.0.1:${mock.port}/v1`;
  process.env['ZA_LLM_MODEL'] = 'mock-model';
  const options = {
    port: 0,
    jwtSecret: JWT_SECRET,
    signingSecret: SIGNING_SECRET,
    issAllowlist: [ISS],
    snapshotRoot,
    systemPromptPath,
    auditSinkPath: AUDIT_SINK,
    allowedProviders: ['openai-compatible'],
    heartbeatMs: 60_000,
  };
  server = await startServer({ ...options, genericAllowlist: [GENERIC_ORIGIN] });
  bareServer = await startServer(options);
  baseUrl = `http://127.0.0.1:${server.port}`;
  bareBaseUrl = `http://127.0.0.1:${bareServer.port}`;
});

afterAll(async () => {
  await server?.close();
  await bareServer?.close();
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

async function createSession(base: string, token: string): Promise<string> {
  const res = await fetch(`${base}/v1/sessions`, { method: 'POST', headers: authHeaders(token) });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { sessionId: string };
  return body.sessionId;
}

async function postFrame(
  base: string,
  token: string,
  sessionId: string,
  frame: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${base}/v1/sessions/${encodeURIComponent(sessionId)}/frames`, {
    method: 'POST',
    headers: authHeaders(token, { 'content-type': 'application/json' }),
    body: JSON.stringify(frame),
  });
}

async function getInjection(
  base: string,
  token: string,
  sessionId: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}/v1/sessions/${encodeURIComponent(sessionId)}/injection`, {
    headers: authHeaders(token),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

interface SseHandle {
  frames: Array<Record<string, unknown>>;
  waitFor(predicate: () => boolean, timeoutMs?: number): Promise<void>;
  close(): void;
}

async function openSse(base: string, token: string, sessionId: string): Promise<SseHandle> {
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

function lastCardStatus(
  frames: Array<Record<string, unknown>>,
  toolId: string,
): string | undefined {
  const cards = framesByType(frames, 'tool-card').filter((f) => f['toolId'] === toolId);
  return cards.length > 0 ? String(cards[cards.length - 1]!['status']) : undefined;
}

/** 读共享审计落点，取属于指定 session 的事件（按 sessionId 隔离本测试流）。 */
function auditEventsFor(sessionId: string): Array<Record<string, unknown>> {
  const raw = readFileSync(AUDIT_SINK, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((event) => event['sessionId'] === sessionId);
}

/** 单回合 generic dom 驱动：user-message → 快照往返 → 等 hitl-request（返回本回合新增的那条）。 */
async function driveToHitl(
  token: string,
  sessionId: string,
  sse: SseHandle,
  snapshotUrl: string,
): Promise<Record<string, unknown>> {
  const snapshotCountBefore = framesByType(sse.frames, 'snapshot-request').length;
  const hitlCountBefore = framesByType(sse.frames, 'hitl-request').length;
  await postFrame(baseUrl, token, sessionId, {
    type: 'user-message',
    sessionId,
    text: '请在页面上点一下那个按钮',
  });
  await sse.waitFor(
    () => framesByType(sse.frames, 'snapshot-request').length > snapshotCountBefore,
  );
  const request = framesByType(sse.frames, 'snapshot-request')[snapshotCountBefore]!;
  await postFrame(baseUrl, token, sessionId, {
    type: 'snapshot-report',
    sessionId,
    requestId: String(request['requestId']),
    url: snapshotUrl,
    title: '通用页面',
    elements: [{ ref: 'za-1', role: 'button', label: '目标按钮' }],
  });
  await sse.waitFor(() => framesByType(sse.frames, 'hitl-request').length > hitlCountBefore);
  return framesByType(sse.frames, 'hitl-request')[hitlCountBefore]!;
}

/** 批准 hitl → 等 exec-instruction → 回传结果 → 等卡片收尾成功（返回签发的指令帧）。 */
async function approveAndFinish(
  token: string,
  sessionId: string,
  sse: SseHandle,
  hitl: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const instrCountBefore = framesByType(sse.frames, 'exec-instruction').length;
  await postFrame(baseUrl, token, sessionId, {
    type: 'hitl-decision',
    sessionId,
    hitlId: String(hitl['hitlId']),
    decision: 'approve',
  });
  await sse.waitFor(
    () => framesByType(sse.frames, 'exec-instruction').length > instrCountBefore,
  );
  const instr = framesByType(sse.frames, 'exec-instruction')[instrCountBefore]!;
  await postFrame(baseUrl, token, sessionId, {
    type: 'exec-result',
    sessionId,
    nonce: String(instr['nonce']),
    ok: true,
    body: { completedSteps: 1 },
  });
  await sse.waitFor(() => lastCardStatus(sse.frames, TOOL_BROWSE) === 'succeeded');
  return instr;
}

describe('parseGenericAllowlist（ZA_GENERIC_ALLOWLIST 解析）', () => {
  it('空/未设 → []（generic 永不激活）', () => {
    expect(parseGenericAllowlist(undefined)).toEqual([]);
    expect(parseGenericAllowlist('')).toEqual([]);
  });

  it('逗号分隔 + 空白容忍 → origin 精确值列表', () => {
    expect(parseGenericAllowlist(' http://127.0.0.1:8080 , https://example.com ')).toEqual([
      'http://127.0.0.1:8080',
      'https://example.com',
    ]);
  });

  it('非 origin 精确值（带路径/非 URL）→ 启动期抛错 fail-fast', () => {
    expect(() => parseGenericAllowlist('https://example.com/')).toThrow(/ZA_GENERIC_ALLOWLIST/);
    expect(() => parseGenericAllowlist('not-a-url')).toThrow(/ZA_GENERIC_ALLOWLIST/);
  });
});

describe('canonicalizeOrigin（准入比对 www/裸域互认）', () => {
  it('剥一层前导 www.，scheme/port 保留', () => {
    expect(canonicalizeOrigin('https://www.example.com')).toBe('https://example.com');
    expect(canonicalizeOrigin('https://example.com')).toBe('https://example.com');
    expect(canonicalizeOrigin('http://www.example.com:8080')).toBe('http://example.com:8080');
  });

  it('非 www 子域不互认；解析失败原样返回', () => {
    expect(canonicalizeOrigin('https://m.example.com')).toBe('https://m.example.com');
    expect(canonicalizeOrigin('not-a-url')).toBe('not-a-url');
  });
});

describe('generic 准入判定（服务端 fail-closed，U7）', () => {
  it('活跃页 origin 在名单内 → 激活 generic-web/browse，工具面含 browse.page-operate', async () => {
    const token = await signToken();
    const sessionId = await createSession(baseUrl, token);
    const report = await postFrame(baseUrl, token, sessionId, {
      type: 'context-report',
      sessionId,
      url: GENERIC_URL,
    });
    expect(report.status).toBe(204);
    const injection = await getInjection(baseUrl, token, sessionId);
    expect(injection['packId']).toBe('generic-web');
    expect(injection['featureId']).toBe('browse');
    expect(injection['toolIds']).toContain(TOOL_BROWSE);
  });

  it('活跃页 origin 不在名单内 → 回落仅基座（packId=null、无工具面）', async () => {
    const token = await signToken();
    const sessionId = await createSession(baseUrl, token);
    await postFrame(baseUrl, token, sessionId, {
      type: 'context-report',
      sessionId,
      url: OUTSIDE_URL,
    });
    const injection = await getInjection(baseUrl, token, sessionId);
    expect(injection['packId']).toBeNull();
    expect(injection['featureId']).toBeNull();
    expect(injection['toolIds']).toEqual([]);
  });

  it('仅基座回合的 system 附注当前站点上下文（防从站点索引臆断所在站点）', async () => {
    const token = await signToken();
    const sessionId = await createSession(baseUrl, token);
    const sse = await openSse(baseUrl, token, sessionId);
    try {
      await postFrame(baseUrl, token, sessionId, {
        type: 'context-report',
        sessionId,
        url: OUTSIDE_URL,
      });
      await postFrame(baseUrl, token, sessionId, {
        type: 'user-message',
        sessionId,
        text: '报告当前站点身份',
      });
      const joined = (): string =>
        sse.frames
          .filter((f) => f['type'] === 'text-delta')
          .map((f) => String(f['delta']))
          .join('');
      await sse.waitFor(() => joined().includes('MOCK-BASEONLY-NOTICE'));
      expect(joined()).toContain('MOCK-BASEONLY-NOTICE-HIT');
    } finally {
      sse.close();
    }
  });

  it('名单配 www 形态可放行裸域页面（互认），非 www 子域仍拒', async () => {
    const wwwServer = await startServer({
      port: 0,
      jwtSecret: JWT_SECRET,
      signingSecret: SIGNING_SECRET,
      issAllowlist: [ISS],
      snapshotRoot,
      systemPromptPath,
      auditSinkPath: AUDIT_SINK,
      allowedProviders: ['openai-compatible'],
      heartbeatMs: 60_000,
      genericAllowlist: ['https://www.canon-test.example'],
    });
    const wwwBase = `http://127.0.0.1:${wwwServer.port}`;
    try {
      const token = await signToken();
      const probe = async (url: string): Promise<unknown> => {
        const sessionId = await createSession(wwwBase, token);
        await postFrame(wwwBase, token, sessionId, { type: 'context-report', sessionId, url });
        return (await getInjection(wwwBase, token, sessionId))['packId'];
      };
      expect(await probe('https://canon-test.example/page')).toBe('generic-web');
      expect(await probe('https://www.canon-test.example/page')).toBe('generic-web');
      expect(await probe('https://m.canon-test.example/page')).toBeNull();
    } finally {
      await wwwServer.close();
    }
  });

  it('未设名单的 server：名单内同 URL 也永不激活 generic', async () => {
    const token = await signToken();
    const sessionId = await createSession(bareBaseUrl, token);
    const report = await fetch(
      `${bareBaseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/frames`,
      {
        method: 'POST',
        headers: authHeaders(token, { 'content-type': 'application/json' }),
        body: JSON.stringify({ type: 'context-report', sessionId, url: GENERIC_URL }),
      },
    );
    expect(report.status).toBe(204);
    const injection = await getInjection(bareBaseUrl, token, sessionId);
    expect(injection['packId']).toBeNull();
    expect(injection['featureId']).toBeNull();
  });

  it('无活跃页（未上报 context）→ 取不到 origin，fail-closed 仅基座', async () => {
    const token = await signToken();
    const sessionId = await createSession(baseUrl, token);
    const injection = await getInjection(baseUrl, token, sessionId);
    expect(injection['packId']).toBeNull();
  });
});

describe('generic dom 代操作闭环（packOrigin=活跃页 origin 动态围栏）', () => {
  it('快照 → hitl 确认 → kind=dom 签名指令 → 结果回收；审计 tool-decision 非 deny 且归属 generic-web', async () => {
    const token = await signToken();
    const sessionId = await createSession(baseUrl, token);
    const sse = await openSse(baseUrl, token, sessionId);
    try {
      await postFrame(baseUrl, token, sessionId, {
        type: 'context-report',
        sessionId,
        url: GENERIC_URL,
      });
      const hitl = await driveToHitl(token, sessionId, sse, GENERIC_URL);
      expect(hitl['toolId']).toBe(TOOL_BROWSE);
      const instr = await approveAndFinish(token, sessionId, sse, hitl);
      const request = instr['request'] as { kind: string; steps: Array<Record<string, unknown>> };
      expect(request.kind).toBe('dom');
      expect(request.steps).toEqual([{ action: 'click', ref: 'za-1' }]);
      expect(instr['signature']).toBeTruthy();
    } finally {
      sse.close();
    }
    const events = auditEventsFor(sessionId);
    const decisionEvent = events.find((e) => e['type'] === 'tool-decision')!;
    expect(decisionEvent['packId']).toBe('generic-web');
    const decision = decisionEvent['data'] as Record<string, unknown>;
    expect(decision['toolId']).toBe(TOOL_BROWSE);
    expect(decision['verdict']).not.toBe('deny');
  });

  it('快照 origin ≠ 活跃页 origin → toolgate deny（origin-fence-violation），不弹确认卡', async () => {
    const token = await signToken();
    const sessionId = await createSession(baseUrl, token);
    const sse = await openSse(baseUrl, token, sessionId);
    try {
      await postFrame(baseUrl, token, sessionId, {
        type: 'context-report',
        sessionId,
        url: GENERIC_URL,
      });
      await postFrame(baseUrl, token, sessionId, {
        type: 'user-message',
        sessionId,
        text: '请在页面上点一下那个按钮',
      });
      await sse.waitFor(() => framesByType(sse.frames, 'snapshot-request').length > 0);
      const request = framesByType(sse.frames, 'snapshot-request')[0]!;
      await postFrame(baseUrl, token, sessionId, {
        type: 'snapshot-report',
        sessionId,
        requestId: String(request['requestId']),
        url: 'http://127.0.0.1:9999/x',
        title: '越界页面',
        elements: [{ ref: 'za-1', role: 'button', label: '目标按钮' }],
      });
      await sse.waitFor(() => lastCardStatus(sse.frames, TOOL_BROWSE) === 'failed');
      expect(framesByType(sse.frames, 'hitl-request')).toHaveLength(0);
    } finally {
      sse.close();
    }
    const events = auditEventsFor(sessionId);
    const decision = events.find((e) => e['type'] === 'tool-decision')!['data'] as Record<
      string,
      unknown
    >;
    expect(decision['verdict']).toBe('deny');
    expect(decision['reason']).toBe('origin-fence-violation');
  });

  it('every-call：同任务两批操作触发两次独立确认（hitlId 不同、授权不复用）', async () => {
    const token = await signToken();
    const sessionId = await createSession(baseUrl, token);
    const sse = await openSse(baseUrl, token, sessionId);
    try {
      await postFrame(baseUrl, token, sessionId, {
        type: 'context-report',
        sessionId,
        url: GENERIC_URL,
      });
      const firstHitl = await driveToHitl(token, sessionId, sse, GENERIC_URL);
      await approveAndFinish(token, sessionId, sse, firstHitl);
      const secondHitl = await driveToHitl(token, sessionId, sse, GENERIC_URL);
      expect(secondHitl['toolId']).toBe(TOOL_BROWSE);
      expect(secondHitl['hitlId']).not.toBe(firstHitl['hitlId']);
      await approveAndFinish(token, sessionId, sse, secondHitl);
    } finally {
      sse.close();
    }
  });
});
