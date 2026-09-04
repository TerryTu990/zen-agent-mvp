/**
 * generic-web 兜底 pack 的服务端装配闭环：无站点 pack 命中且活跃页是 http/https 即无条件激活 generic pack；
 * 静默页（非 http/https、无活跃页）回落仅基座——那是协议判定，不是部署级名单。
 * 激活后 packOrigin 以活跃页 origin 动态绑定——快照 origin 越界由 toolgate deny，
 * every-call 工具逐批独立确认、授权不复用。用 acceptance 快照（含 generic-web pack）驱动。
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseFulfillmentProductKeys, startServer, type RunningServer } from '../src/index.js';
import { isSilentPageUrl } from '../src/gateway.js';

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
/** 静默页（非 http/https）：generic 不绑非 http/https origin，回落仅基座。 */
const SILENT_URL = 'chrome://newtab/';
const TOOL_BROWSE = 'browse.page-operate';
/** 送达 LLM 的 wire 名（toolId 的点替换为 '__'）。 */
const TOOL_BROWSE_WIRE = 'browse__page-operate';

describe('parseFulfillmentProductKeys（服务端商品闭集）', () => {
  it('空值关闭工具；合法对象规范化值；数组、空键值和非字符串 fail-fast', () => {
    expect(parseFulfillmentProductKeys(undefined)).toEqual({});
    expect(parseFulfillmentProductKeys('{"item-a":" product-a "}')).toEqual({ 'item-a': 'product-a' });
    for (const raw of ['[]', '{"":"p"}', '{" item":"p"}', '{"item":""}', '{"item":1}']) {
      expect(() => parseFulfillmentProductKeys(raw)).toThrow(/ZA_FULFILLMENT_PRODUCT_KEYS_JSON/);
    }
  });
});

interface MockLlmHandle {
  port: number;
  /** 原始请求体只留在测试进程内，供断言送达 LLM 的工具面；永不打印或写盘。 */
  requests: string[];
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

/**
 * 已有任务级授权时的第二批：同样走「提问 → 快照回传」，但**不等 hitl-request**，
 * 直接等新的 exec-instruction——若服务端仍要求确认，这里会等到超时而非静默放过。
 */
async function driveToExecWithoutHitl(
  token: string,
  sessionId: string,
  sse: SseHandle,
  snapshotUrl: string,
): Promise<void> {
  const snapshotCountBefore = framesByType(sse.frames, 'snapshot-request').length;
  const instrCountBefore = framesByType(sse.frames, 'exec-instruction').length;
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
  await sse.waitFor(
    () => framesByType(sse.frames, 'exec-instruction').length > instrCountBefore,
  );
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

describe('isSilentPageUrl（静默页判定）', () => {
  it('空串 / 不可解析 / 非 http-https scheme 一律静默', () => {
    expect(isSilentPageUrl('')).toBe(true);
    expect(isSilentPageUrl('not-a-url')).toBe(true);
    expect(isSilentPageUrl('chrome://newtab/')).toBe(true);
    expect(isSilentPageUrl('chrome://extensions')).toBe(true);
    expect(isSilentPageUrl('about:blank')).toBe(true);
    expect(isSilentPageUrl('file:///tmp/a.html')).toBe(true);
  });

  it('http/https 页非静默', () => {
    expect(isSilentPageUrl('https://example.com/page')).toBe(false);
    expect(isSilentPageUrl('http://127.0.0.1:4173/order-list.html')).toBe(false);
  });
});

describe('generic 装配判定（http/https 无条件激活；静默页仍回落仅基座）', () => {
  it('活跃页是 http/https → 激活 generic-web/browse，工具面含 browse.page-operate', async () => {
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

  it('任意站点 origin（无任何部署侧准入配置）→ 同样激活 generic-web/browse', async () => {
    const token = await signToken();
    const sessionId = await createSession(baseUrl, token);
    await postFrame(baseUrl, token, sessionId, {
      type: 'context-report',
      sessionId,
      url: OUTSIDE_URL,
    });
    const injection = await getInjection(baseUrl, token, sessionId);
    expect(injection['packId']).toBe('generic-web');
    expect(injection['featureId']).toBe('browse');
    expect(injection['toolIds']).toContain(TOOL_BROWSE);
  });

  it('仅基座回合（静默页）的 system 附注仅基座上下文（防从站点索引臆断所在站点）', async () => {
    const token = await signToken();
    const sessionId = await createSession(baseUrl, token);
    const sse = await openSse(baseUrl, token, sessionId);
    try {
      await postFrame(baseUrl, token, sessionId, {
        type: 'context-report',
        sessionId,
        url: SILENT_URL,
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

  it('静默页（chrome://newtab）→ 不把 generic pack 绑到非 http/https origin，回落仅基座', async () => {
    const token = await signToken();
    const sessionId = await createSession(baseUrl, token);
    await postFrame(baseUrl, token, sessionId, {
      type: 'context-report',
      sessionId,
      url: SILENT_URL,
    });
    const injection = await getInjection(baseUrl, token, sessionId);
    expect(injection['packId']).toBeNull();
    expect(injection['featureId']).toBeNull();
    expect(injection['toolIds']).toEqual([]);
  });

  it('无活跃页（未上报 context）→ 按静默页判定回落仅基座', async () => {
    const token = await signToken();
    const sessionId = await createSession(baseUrl, token);
    const injection = await getInjection(baseUrl, token, sessionId);
    expect(injection['packId']).toBeNull();
  });
});

/**
 * 驱动一回合到 LLM 调用，返回送达 LLM 的工具名清单（wire 名，点已替换为 '__'；open_url 无点不受影响）。
 * url=null 模拟静默页冷启动（会话从未上报 context）。
 */
async function toolNamesSentToLlm(url: string | null, base = baseUrl): Promise<string[]> {
  const token = await signToken();
  const sessionId = await createSession(base, token);
  if (url !== null) {
    await postFrame(base, token, sessionId, { type: 'context-report', sessionId, url });
  }
  const before = mock.requests.length;
  await postFrame(base, token, sessionId, { type: 'user-message', sessionId, text: '你好' });
  const deadline = Date.now() + 8000;
  while (mock.requests.length <= before) {
    if (Date.now() > deadline) throw new Error('等待 LLM 请求捕获超时');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const request = JSON.parse(mock.requests[mock.requests.length - 1]!) as {
    tools?: Array<{ name?: string; function?: { name?: string } }>;
  };
  return (request.tools ?? []).map((tool) => tool.function?.name ?? tool.name ?? '');
}

describe('open_url 注入门（与 generic 装配同门）', () => {
  it('generic 激活回合：送达 LLM 的工具面含 open_url 与 pack 工具', async () => {
    const toolNames = await toolNamesSentToLlm(GENERIC_URL);
    expect(toolNames).toContain('open_url');
    expect(toolNames).toContain(TOOL_BROWSE_WIRE);
  });

  it('任意站点 origin 同样激活 generic → 工具面含 open_url', async () => {
    const toolNames = await toolNamesSentToLlm(OUTSIDE_URL);
    expect(toolNames).toContain('open_url');
  });
});

describe('静默页冷启动 open_url 注入门（无条件放行，仅基座装配不变）', () => {
  it('静默页（未上报 context）：保持仅基座装配（packId=null、无 pack 工具），但工具面含 open_url', async () => {
    const token = await signToken();
    const sessionId = await createSession(baseUrl, token);
    const injection = await getInjection(baseUrl, token, sessionId);
    expect(injection['packId']).toBeNull();
    expect(injection['toolIds']).toEqual([]);
    const toolNames = await toolNamesSentToLlm(null);
    expect(toolNames).toContain('open_url');
    expect(toolNames).not.toContain(TOOL_BROWSE_WIRE);
  });

  it('静默页（chrome://newtab 上报）：不把 generic pack 绑到非 http/https origin，仍只注入 open_url', async () => {
    const toolNames = await toolNamesSentToLlm(SILENT_URL);
    expect(toolNames).toContain('open_url');
    expect(toolNames).not.toContain(TOOL_BROWSE_WIRE);
  });
});

/**
 * open_url 全链路专用脚本化 mock LLM：历史中尚无 tool 观察时产出 open_url 调用；
 * 回喂轮把最后一条 observation 原样回显（MOCK-OPEN-OBS 前缀），供机械断言回喂内容。
 * 按「历史含 tool 观察」而非「末条是 tool」判轮次：落点换 pack 时观测后还会追加站点边界标记（user 角色）。
 */
function startScriptedOpenUrlMock(targetUrl: string): Promise<{ port: number; close(): Promise<void> }> {
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
      const lastObservation = [...messages].reverse().find((m) => m.role === 'tool');
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
      if (lastObservation !== undefined) {
        send({
          index: 0,
          delta: { content: `MOCK-OPEN-OBS ${String(lastObservation.content ?? '')}` },
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
                id: 'call_open_url',
                type: 'function',
                function: {
                  name: 'open_url',
                  arguments: JSON.stringify({
                    url: targetUrl,
                    task: '打开外部文章',
                    reason: '需要查看用户给出的外部页面',
                  }),
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

describe('generic open_url 全链路（任意 http/https 开页，每次确认）', () => {
  const OPEN_TARGET = 'https://opentarget.example/article?id=1';
  let scripted: { port: number; close(): Promise<void> };
  let openUrlServer: RunningServer;
  let openUrlBase = '';
  let prevBaseUrl: string | undefined;

  beforeAll(async () => {
    scripted = await startScriptedOpenUrlMock(OPEN_TARGET);
    prevBaseUrl = process.env['ZA_LLM_BASE_URL'];
    process.env['ZA_LLM_BASE_URL'] = `http://127.0.0.1:${scripted.port}/v1`;
    openUrlServer = await startServer({
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
    openUrlBase = `http://127.0.0.1:${openUrlServer.port}`;
  });

  afterAll(async () => {
    await openUrlServer?.close();
    await scripted?.close();
    if (prevBaseUrl !== undefined) process.env['ZA_LLM_BASE_URL'] = prevBaseUrl;
  });

  it('调用 → hitl 确认 → 单步 navigate 签名指令 → {url} 结果回收 → observation 回喂（落点按 generic 重绑）', async () => {
    const token = await signToken();
    const sessionId = await createSession(openUrlBase, token);
    const sse = await openSse(openUrlBase, token, sessionId);
    try {
      await postFrame(openUrlBase, token, sessionId, {
        type: 'context-report',
        sessionId,
        url: GENERIC_URL,
      });
      await postFrame(openUrlBase, token, sessionId, {
        type: 'user-message',
        sessionId,
        text: '帮我打开那篇外部文章',
      });
      await sse.waitFor(() => framesByType(sse.frames, 'hitl-request').length > 0);
      const hitl = framesByType(sse.frames, 'hitl-request')[0]!;
      expect(hitl['toolId']).toBe('open_url');
      expect((hitl['params'] as Record<string, unknown>)['url']).toBe(OPEN_TARGET);
      await postFrame(openUrlBase, token, sessionId, {
        type: 'hitl-decision',
        sessionId,
        hitlId: String(hitl['hitlId']),
        decision: 'approve',
      });
      await sse.waitFor(() => framesByType(sse.frames, 'exec-instruction').length > 0);
      const instr = framesByType(sse.frames, 'exec-instruction')[0]!;
      expect(instr['request']).toEqual({
        kind: 'dom',
        steps: [{ action: 'navigate', url: OPEN_TARGET }],
      });
      expect(instr['signature']).toBeTruthy();
      await postFrame(openUrlBase, token, sessionId, {
        type: 'exec-result',
        sessionId,
        nonce: String(instr['nonce']),
        ok: true,
        body: { url: OPEN_TARGET },
      });
      const joined = (): string =>
        sse.frames
          .filter((f) => f['type'] === 'text-delta')
          .map((f) => String(f['delta']))
          .join('');
      await sse.waitFor(() => joined().includes('MOCK-OPEN-OBS'));
      expect(joined()).toContain(OPEN_TARGET);
      // 落点是 http/https：generic 无条件激活并按落点 origin 重绑围栏，不再附「未安装专属配置」。
      expect(joined()).not.toContain('落点站点未安装专属配置');
      const injection = await getInjection(openUrlBase, token, sessionId);
      expect(injection['packId']).toBe('generic-web');
    } finally {
      sse.close();
    }
  });
});

describe('静默页冷启动 open_url 调用门（与注入门共用同一谓词）', () => {
  const OPEN_TARGET = 'https://coldstart.example/article?id=1';
  let scripted: { port: number; close(): Promise<void> };
  let coldServer: RunningServer;
  let coldBase = '';
  let prevBaseUrl: string | undefined;

  beforeAll(async () => {
    scripted = await startScriptedOpenUrlMock(OPEN_TARGET);
    prevBaseUrl = process.env['ZA_LLM_BASE_URL'];
    process.env['ZA_LLM_BASE_URL'] = `http://127.0.0.1:${scripted.port}/v1`;
    coldServer = await startServer({
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
    coldBase = `http://127.0.0.1:${coldServer.port}`;
  });

  afterAll(async () => {
    await coldServer?.close();
    await scripted?.close();
    if (prevBaseUrl !== undefined) process.env['ZA_LLM_BASE_URL'] = prevBaseUrl;
  });

  it('静默页调用过门直到 HITL，批准后签发单步 navigate 指令', async () => {
    const token = await signToken();
    const sessionId = await createSession(coldBase, token);
    const sse = await openSse(coldBase, token, sessionId);
    try {
      await postFrame(coldBase, token, sessionId, {
        type: 'user-message',
        sessionId,
        text: '帮我打开那篇外部文章',
      });
      await sse.waitFor(() => framesByType(sse.frames, 'hitl-request').length > 0);
      const hitl = framesByType(sse.frames, 'hitl-request')[0]!;
      expect(hitl['toolId']).toBe('open_url');
      expect((hitl['params'] as Record<string, unknown>)['url']).toBe(OPEN_TARGET);
      await postFrame(coldBase, token, sessionId, {
        type: 'hitl-decision',
        sessionId,
        hitlId: String(hitl['hitlId']),
        decision: 'approve',
      });
      await sse.waitFor(() => framesByType(sse.frames, 'exec-instruction').length > 0);
      const instr = framesByType(sse.frames, 'exec-instruction')[0]!;
      expect(instr['request']).toEqual({
        kind: 'dom',
        steps: [{ action: 'navigate', url: OPEN_TARGET }],
      });
      expect(instr['signature']).toBeTruthy();
    } finally {
      sse.close();
    }
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

  it('per-task：同任务第二批复用首批授权，不再弹卡但仍逐批签发指令', async () => {
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
      expect(firstHitl['toolId']).toBe(TOOL_BROWSE);
      // 首卡即授权范围：plan 必须随卡下发，否则用户批准的是一份看不见的计划。
      const params = firstHitl['params'] as Record<string, unknown>;
      expect(Array.isArray(params['plan'])).toBe(true);
      expect((params['plan'] as unknown[]).length).toBeGreaterThan(0);
      await approveAndFinish(token, sessionId, sse, firstHitl);

      const instrBefore = framesByType(sse.frames, 'exec-instruction').length;
      await driveToExecWithoutHitl(token, sessionId, sse, GENERIC_URL);

      // 第二批：新签发一条指令，且全程只出现过一张确认卡（授权按 sessionId+task 复用）。
      expect(framesByType(sse.frames, 'exec-instruction').length).toBe(instrBefore + 1);
      expect(framesByType(sse.frames, 'hitl-request')).toHaveLength(1);
    } finally {
      sse.close();
    }
  });
});

describe('平台内建投递记录工具的注入门（pack 声明驱动，A-ASM-01/A-ARCH-01）', () => {
  it('声明了 capabilities.builtinTools 的 pack 激活 → 两工具在工具面内', async () => {
    const toolNames = await toolNamesSentToLlm('https://www.zhipin.com/job_detail/abc123.html');
    expect(toolNames).toContain('record_application');
    expect(toolNames).toContain('list_applications');
  });

  it('未声明的 pack（generic-web）激活 → 两工具不注入（缺省即不注入）', async () => {
    const toolNames = await toolNamesSentToLlm(GENERIC_URL);
    expect(toolNames).toContain(TOOL_BROWSE_WIRE);
    expect(toolNames).not.toContain('record_application');
    expect(toolNames).not.toContain('list_applications');
  });

  it('仅基座回合 → 两工具不注入', async () => {
    const toolNames = await toolNamesSentToLlm(OUTSIDE_URL);
    expect(toolNames).not.toContain('record_application');
    expect(toolNames).not.toContain('list_applications');
  });
});

/**
 * site_navigate 落地重校验专用脚本化 mock LLM：首轮产出对围栏内目标的 site_navigate 调用；
 * 回喂轮把 observation 原样回显（MOCK-NAV-OBS 前缀）。requests 保留每轮请求体，供断言落地后的工具面。
 */
function startScriptedNavigateMock(
  targetUrl: string,
): Promise<{ port: number; requests: string[]; close(): Promise<void> }> {
  const requests: string[] = [];
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
      requests.push(raw);
      let body: { messages?: Array<{ role?: string; content?: unknown }> };
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        body = {};
      }
      const messages = body.messages ?? [];
      const last = messages[messages.length - 1];
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
      if (last?.role === 'tool') {
        send({ index: 0, delta: { content: `MOCK-NAV-OBS ${String(last.content ?? '')}` }, finish_reason: null });
        send({ index: 0, delta: {}, finish_reason: 'stop' });
      } else {
        send({
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_site_navigate',
                type: 'function',
                function: {
                  name: 'site_navigate',
                  arguments: JSON.stringify({ url: targetUrl, task: '跨站续作同一任务' }),
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
      resolve({ port, requests, close: () => new Promise((r) => httpServer.close(() => r())) });
    });
  });
}

describe('site_navigate 落地后围栏重校验（PC-GOV-04：捕 302 逃逸）', () => {
  const NAV_TARGET = 'https://www.zhipin.com/web/geek/job';
  let scripted: { port: number; requests: string[]; close(): Promise<void> };
  let navServer: RunningServer;
  let navBase = '';
  let prevBaseUrl: string | undefined;

  beforeAll(async () => {
    scripted = await startScriptedNavigateMock(NAV_TARGET);
    prevBaseUrl = process.env['ZA_LLM_BASE_URL'];
    process.env['ZA_LLM_BASE_URL'] = `http://127.0.0.1:${scripted.port}/v1`;
    navServer = await startServer({
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
    navBase = `http://127.0.0.1:${navServer.port}`;
  });

  afterAll(async () => {
    await navServer?.close();
    await scripted?.close();
    if (prevBaseUrl !== undefined) process.env['ZA_LLM_BASE_URL'] = prevBaseUrl;
  });

  /** 走完一次 site_navigate（hitl 批准 → 指令 → 客户端上报落点），返回本回合送达 LLM 的末轮工具名。 */
  async function navigateLandingAt(landedUrl: string): Promise<{ toolNames: string[]; text: string }> {
    const token = await signToken();
    const sessionId = await createSession(navBase, token);
    const sse = await openSse(navBase, token, sessionId);
    try {
      await postFrame(navBase, token, sessionId, {
        type: 'context-report',
        sessionId,
        url: 'https://www.zhipin.com/job_detail/abc123.html',
      });
      await postFrame(navBase, token, sessionId, {
        type: 'user-message',
        sessionId,
        text: '回到列表页继续',
      });
      await sse.waitFor(() => framesByType(sse.frames, 'hitl-request').length > 0);
      const hitl = framesByType(sse.frames, 'hitl-request')[0]!;
      expect(hitl['toolId']).toBe('site_navigate');
      await postFrame(navBase, token, sessionId, {
        type: 'hitl-decision',
        sessionId,
        hitlId: String(hitl['hitlId']),
        decision: 'approve',
      });
      await sse.waitFor(() => framesByType(sse.frames, 'exec-instruction').length > 0);
      const instr = framesByType(sse.frames, 'exec-instruction')[0]!;
      await postFrame(navBase, token, sessionId, {
        type: 'exec-result',
        sessionId,
        nonce: String(instr['nonce']),
        ok: true,
        // 客户端如实上报落点：302 后的实际 URL 与签发目标不同。
        body: { url: landedUrl },
      });
      const text = (): string =>
        sse.frames
          .filter((f) => f['type'] === 'text-delta')
          .map((f) => String(f['delta']))
          .join('');
      await sse.waitFor(() => text().includes('MOCK-NAV-OBS'));
      const request = JSON.parse(scripted.requests[scripted.requests.length - 1]!) as {
        tools?: Array<{ name?: string; function?: { name?: string } }>;
      };
      return {
        toolNames: (request.tools ?? []).map((tool) => tool.function?.name ?? tool.name ?? ''),
        text: text(),
      };
    } finally {
      sse.close();
    }
  }

  it('落点仍在围栏内（无重定向）→ 照常按落点换装（回归锚）', async () => {
    const { toolNames, text } = await navigateLandingAt(NAV_TARGET);
    expect(toolNames.some((name) => name.startsWith('job-search__'))).toBe(true);
    expect(text).not.toContain('越出已安装站点围栏');
  });

  it('302 落到围栏外 → 不按新落点授予 pack 工具面（回落仅基座）且如实告知模型', async () => {
    const { toolNames, text } = await navigateLandingAt(GENERIC_URL);
    expect(text).toContain('越出已安装站点围栏');
    expect(toolNames).not.toContain(TOOL_BROWSE_WIRE);
    expect(toolNames.some((name) => name.startsWith('job-search__') || name.startsWith('job-detail__'))).toBe(false);
  });
});
