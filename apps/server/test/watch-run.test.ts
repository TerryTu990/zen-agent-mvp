/**
 * G5（adr-021，E2E-F 的服务集成级替身）：用户自建 watch 触发的自动回合。
 * 底线（R7 机械化）：readOnly 模板发起的 run 由服务端强制只读工具面——写工具请求一律 deny 并留审计，
 * HITL 在无人值守 run 中等价拒绝，全程不签发任何代执行指令；治理判定全在服务端（U7），
 * 客户端只提供「哪个实例、哪一轮」的运行关联标识。
 * 报告口径（R6）：与上轮快照比对，有变化才产报告并随完成帧呈现；无变化不打扰面板，只落审计。
 */
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
const AUDIT_SINK = join(mkdtempSync(join(tmpdir(), 'za-watch-audit-')), 'events.jsonl');

const JWT_SECRET = 'za-test-secret';
const SIGNING_SECRET = 'za-test-signing-secret';
const ISS = 'zen-agent-demo';
const key = new TextEncoder().encode(JWT_SECRET);
const TENANT = 'demo-tenant';

const WATCH_ORIGIN = 'http://127.0.0.1:4173';
const WATCH_URL = `${WATCH_ORIGIN}/order-list.html`;
const WATCH_ID = 'watch-orders';
const DISABLED_WATCH_ID = 'watch-orders-off';
/** 只读 run 中模型幻觉调用的写工具（host-demo 声明 riskTier=hitl）：无人值守下必须 deny 而非弹 HITL。 */
const WRITE_TOOL_ID = 'order-list.cancel-order';
const WATCH_PROMPT = '执行页面变化监测：只读读取页面并与上轮比对。';

interface MockLlmHandle {
  port: number;
  close(): Promise<void>;
}

let mock: MockLlmHandle;
let server: RunningServer;
let baseUrl = '';
const userConfigDir = mkdtempSync(join(tmpdir(), 'za-watch-store-'));

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
    userConfigDir,
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server?.close();
  await mock?.close();
});

async function signToken(hostUserId: string): Promise<string> {
  return new SignJWT({ tenant: TENANT, roles: ['ops'], hostUserId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(`user-${hostUserId}`)
    .setIssuer(ISS)
    .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
    .sign(key);
}

function authHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...extra };
}

function watchOverlay(hostUserId: string, watches: unknown): Record<string, unknown> {
  return { schemaVersion: 1, subject: { tenant: TENANT, hostUserId }, packs: {}, watches };
}

function watchEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: WATCH_ID,
    templateId: 'page-watch',
    url: WATCH_URL,
    minutes: 5,
    enabled: true,
    focus: '关注订单列表条目的增减',
    ...overrides,
  };
}

function putOverlay(token: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/v1/user-config`, {
    method: 'PUT',
    headers: authHeaders(token, { 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
}

async function createSession(token: string): Promise<string> {
  const res = await fetch(`${baseUrl}/v1/sessions`, { method: 'POST', headers: authHeaders(token) });
  expect(res.status).toBe(201);
  return ((await res.json()) as { sessionId: string }).sessionId;
}

function postFrame(
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
    async waitFor(predicate, timeoutMs = 6000) {
      const deadline = Date.now() + timeoutMs;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`SSE 等待超时；已收帧：${JSON.stringify(frames)}`);
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

function runCards(sse: SseHandle, automationId: string): Array<Record<string, unknown>> {
  return framesByType(sse.frames, 'tool-card').filter((frame) => frame['toolId'] === automationId);
}

function auditEventsFor(sessionId: string): Array<Record<string, unknown>> {
  let raw = '';
  try {
    raw = readFileSync(AUDIT_SINK, 'utf8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((event) => event['sessionId'] === sessionId);
}

function eventData(event: Record<string, unknown>): Record<string, unknown> {
  return event['data'] as Record<string, unknown>;
}

interface WatchRunOptions {
  automationId?: string;
  text?: string;
  labels: string[];
  /** 客户端实际上报的页面 URL；缺省即被监测页本身。 */
  reportUrl?: string;
}

/**
 * 驱动一轮 watch 自动回合：发起自动 user-message → 应答服务端的只读快照请求 → 等本轮完成帧。
 * labels 决定本轮快照内容（与上轮相同即「无变化」）。
 */
async function driveWatchRun(
  token: string,
  sessionId: string,
  sse: SseHandle,
  runId: string,
  options: WatchRunOptions,
): Promise<Record<string, unknown>> {
  const automationId = options.automationId ?? WATCH_ID;
  const snapshotsBefore = framesByType(sse.frames, 'snapshot-request').length;
  const cardsBefore = runCards(sse, automationId).length;
  const accepted = await postFrame(token, sessionId, {
    type: 'user-message',
    sessionId,
    text: options.text ?? WATCH_PROMPT,
    automationRunId: runId,
    automationId,
    executionPreference: 'dom-only',
  });
  expect(accepted.status).toBe(202);
  await sse.waitFor(() => framesByType(sse.frames, 'snapshot-request').length > snapshotsBefore);
  const request = framesByType(sse.frames, 'snapshot-request')[snapshotsBefore]!;
  await postFrame(token, sessionId, {
    type: 'snapshot-report',
    sessionId,
    requestId: String(request['requestId']),
    url: options.reportUrl ?? WATCH_URL,
    title: '订单列表',
    elements: options.labels.map((label, index) => ({
      ref: `za-${index}`,
      role: 'cell',
      label,
    })),
  });
  await sse.waitFor(() => runCards(sse, automationId).length > cardsBefore);
  return runCards(sse, automationId)[cardsBefore]!;
}

describe('watch 实例写入通道（复用 PUT /v1/user-config 双校验链）', () => {
  it('合法实例写入 200，且 GET 回读一致', async () => {
    const hostUserId = 'watch-write-ok';
    const token = await signToken(hostUserId);
    const overlay = watchOverlay(hostUserId, [watchEntry()]);
    const res = await putOverlay(token, overlay);
    expect(res.status, await res.clone().text()).toBe(200);

    const read = await fetch(`${baseUrl}/v1/user-config`, { headers: authHeaders(token) });
    const body = (await read.json()) as { overlay: { watches?: unknown[] } | null };
    expect(body.overlay?.watches).toEqual([watchEntry()]);
  });

  it('minutes 低于平台下限的实例写入期被拒（400，不落盘）', async () => {
    const hostUserId = 'watch-write-minutes';
    const token = await signToken(hostUserId);
    const res = await putOverlay(token, watchOverlay(hostUserId, [watchEntry({ minutes: 1 })]));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { issues?: unknown };
    expect(JSON.stringify(body.issues ?? [])).toContain('watches');

    const read = await fetch(`${baseUrl}/v1/user-config`, { headers: authHeaders(token) });
    expect(((await read.json()) as { overlay: unknown }).overlay).toBeNull();
  });

  it('模板闭集外的 templateId 写入期被拒（400）', async () => {
    const hostUserId = 'watch-write-template';
    const token = await signToken(hostUserId);
    const res = await putOverlay(
      token,
      watchOverlay(hostUserId, [watchEntry({ templateId: 'page-write' })]),
    );
    expect(res.status).toBe(400);
  });
});

describe('watch 自动回合：变化检测与报告收口（R6）', () => {
  it(
    '首轮建立基线不报告；有变化产报告随完成帧呈现；无变化不打扰面板，两者均落审计',
    async () => {
      const hostUserId = 'watch-report';
      const token = await signToken(hostUserId);
      expect((await putOverlay(token, watchOverlay(hostUserId, [watchEntry()]))).status).toBe(200);
      const sessionId = await createSession(token);
      const sse = await openSse(token, sessionId);
      try {
        await postFrame(token, sessionId, { type: 'context-report', sessionId, url: WATCH_URL });

        const baseline = await driveWatchRun(token, sessionId, sse, 'watch_run_1', {
          labels: ['ORD-1001 待发货'],
        });
        expect(baseline['summary']).toBeUndefined();

        const textDeltasBeforeChange = framesByType(sse.frames, 'text-delta').length;
        const changed = await driveWatchRun(token, sessionId, sse, 'watch_run_2', {
          labels: ['ORD-1001 已发货', 'ORD-1002 待发货'],
        });
        expect(String(changed['summary'] ?? '')).not.toBe('');
        expect(framesByType(sse.frames, 'text-delta').length).toBeGreaterThan(textDeltasBeforeChange);

        const textDeltasBeforeStable = framesByType(sse.frames, 'text-delta').length;
        const unchanged = await driveWatchRun(token, sessionId, sse, 'watch_run_3', {
          labels: ['ORD-1001 已发货', 'ORD-1002 待发货'],
        });
        expect(unchanged['summary']).toBeUndefined();
        expect(framesByType(sse.frames, 'text-delta').length).toBe(textDeltasBeforeStable);

        const runEvents = auditEventsFor(sessionId).filter(
          (event) => event['type'] === 'tool-execution' && eventData(event)['toolId'] === WATCH_ID,
        );
        expect(runEvents.map((event) => eventData(event)['toolCallId'])).toEqual([
          'watch_run_1',
          'watch_run_2',
          'watch_run_3',
        ]);
        for (const event of runEvents) {
          expect(eventData(event)['execution']).toBe('server');
          expect(eventData(event)['outcome']).toBe('ok');
        }
      } finally {
        sse.close();
      }
    },
    30_000,
  );

  it(
    '上报的不是被监测页：本轮跳过——不产报告、不推进基线，审计记 skipped 而非 ok（不可与「看过没变」同形）',
    async () => {
      const hostUserId = 'watch-offpage';
      const token = await signToken(hostUserId);
      expect((await putOverlay(token, watchOverlay(hostUserId, [watchEntry()]))).status).toBe(200);
      const sessionId = await createSession(token);
      const sse = await openSse(token, sessionId);
      try {
        await postFrame(token, sessionId, { type: 'context-report', sessionId, url: WATCH_URL });

        await driveWatchRun(token, sessionId, sse, 'offpage_run_1', { labels: ['ORD-2001 待发货'] });
        const textDeltasBefore = framesByType(sse.frames, 'text-delta').length;

        // 用户在派发与取快照之间切到了同站另一页：本轮什么都没看到。
        const skipped = await driveWatchRun(token, sessionId, sse, 'offpage_run_2', {
          labels: ['完全不同的内容'],
          reportUrl: `${WATCH_ORIGIN}/order-detail.html`,
        });
        expect(skipped['status']).toBe('succeeded');
        expect(skipped['summary']).toBeUndefined();
        expect(framesByType(sse.frames, 'text-delta').length).toBe(textDeltasBefore);

        // 基线未被跳过轮污染：回到被监测页且内容与首轮相同 → 必须判「无变化」。
        // 这一轮才有鉴别力：若跳过轮推进了基线，这里会与「完全不同的内容」相比而产出报告。
        const resumed = await driveWatchRun(token, sessionId, sse, 'offpage_run_3', {
          labels: ['ORD-2001 待发货'],
        });
        expect(resumed['summary']).toBeUndefined();
        expect(framesByType(sse.frames, 'text-delta').length).toBe(textDeltasBefore);

        // 基线仍是首轮那一份：真变化照常检出。
        const changed = await driveWatchRun(token, sessionId, sse, 'offpage_run_4', {
          labels: ['ORD-2001 已发货'],
        });
        expect(String(changed['summary'] ?? '')).toContain('待发货');

        // 上报 URL 根本不可解析是客户端故障，不是「用户切了页」：记 error，与跳过分开。
        await driveWatchRun(token, sessionId, sse, 'offpage_run_5', {
          labels: ['ORD-2001 已发货'],
          reportUrl: 'not-a-url',
        });

        const outcomes = auditEventsFor(sessionId)
          .filter((event) => event['type'] === 'tool-execution' && eventData(event)['toolId'] === WATCH_ID)
          .map((event) => eventData(event)['outcome']);
        expect(outcomes).toEqual(['ok', 'skipped', 'ok', 'ok', 'error']);
      } finally {
        sse.close();
      }
    },
    30_000,
  );
});

describe('watch 自动回合：无人值守只读底线（R7，结构强制）', () => {
  it(
    '模型请求写工具即 deny 并留审计；全程无代执行指令、无 HITL 卡',
    async () => {
      const hostUserId = 'watch-readonly';
      const token = await signToken(hostUserId);
      expect((await putOverlay(token, watchOverlay(hostUserId, [watchEntry()]))).status).toBe(200);
      const sessionId = await createSession(token);
      const sse = await openSse(token, sessionId);
      try {
        await postFrame(token, sessionId, { type: 'context-report', sessionId, url: WATCH_URL });
        await driveWatchRun(token, sessionId, sse, 'readonly_run_1', { labels: ['ORD-1001 待发货'] });
        await driveWatchRun(token, sessionId, sse, 'readonly_run_2', {
          text: `${WATCH_PROMPT} 模拟越权写调用`,
          labels: ['ORD-1001 已发货'],
        });

        const denials = auditEventsFor(sessionId).filter(
          (event) =>
            event['type'] === 'tool-decision' &&
            eventData(event)['toolId'] === WRITE_TOOL_ID &&
            eventData(event)['verdict'] === 'deny',
        );
        expect(denials.length).toBeGreaterThan(0);
        expect(String(eventData(denials[0]!)['reason'] ?? '')).not.toBe('');
        // adr-021 指定的 R7 机械证据：无人值守只读轮的拒绝须能被审计流机械识别
        expect(eventData(denials[0]!)['unattendedReadOnly']).toBe(true);

        expect(framesByType(sse.frames, 'exec-instruction')).toEqual([]);
        expect(framesByType(sse.frames, 'hitl-request')).toEqual([]);
        expect(
          auditEventsFor(sessionId).filter(
            (event) =>
              event['type'] === 'tool-execution' && eventData(event)['toolId'] === WRITE_TOOL_ID,
          ),
        ).toEqual([]);
      } finally {
        sse.close();
      }
    },
    30_000,
  );

  it('未知 automationId 一律拒绝，不回落普通回合（回落即把完整工具面交给无人值守轮）', async () => {
    const hostUserId = 'watch-unknown';
    const token = await signToken(hostUserId);
    expect((await putOverlay(token, watchOverlay(hostUserId, [watchEntry()]))).status).toBe(200);
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    try {
      await postFrame(token, sessionId, { type: 'context-report', sessionId, url: WATCH_URL });
      const res = await postFrame(token, sessionId, {
        type: 'user-message',
        sessionId,
        text: WATCH_PROMPT,
        automationRunId: 'unknown_run_1',
        automationId: 'watch-never-created',
        executionPreference: 'dom-only',
      });
      expect(res.status).toBe(403);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(framesByType(sse.frames, 'snapshot-request')).toEqual([]);
      expect(framesByType(sse.frames, 'text-delta')).toEqual([]);
    } finally {
      sse.close();
    }
  }, 15_000);

  it('只带 automationRunId 的帧被拒：归属判定的入口不能由客户端是否自愿声明决定', async () => {
    const hostUserId = 'watch-halfid';
    const token = await signToken(hostUserId);
    expect((await putOverlay(token, watchOverlay(hostUserId, [watchEntry()]))).status).toBe(200);
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    try {
      await postFrame(token, sessionId, { type: 'context-report', sessionId, url: WATCH_URL });
      const res = await postFrame(token, sessionId, {
        type: 'user-message',
        sessionId,
        text: WATCH_PROMPT,
        automationRunId: 'halfid_run_1',
        executionPreference: 'dom-only',
      });
      expect(res.status).toBe(400);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(framesByType(sse.frames, 'snapshot-request')).toEqual([]);
      expect(framesByType(sse.frames, 'text-delta')).toEqual([]);
    } finally {
      sse.close();
    }
  }, 15_000);

  it('未启用的 watch 实例不可发起自动回合（服务端拒，不依赖客户端自律）', async () => {
    const hostUserId = 'watch-disabled';
    const token = await signToken(hostUserId);
    const overlay = watchOverlay(hostUserId, [
      watchEntry({ id: DISABLED_WATCH_ID, enabled: false }),
    ]);
    expect((await putOverlay(token, overlay)).status).toBe(200);
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    try {
      await postFrame(token, sessionId, { type: 'context-report', sessionId, url: WATCH_URL });
      const res = await postFrame(token, sessionId, {
        type: 'user-message',
        sessionId,
        text: WATCH_PROMPT,
        automationRunId: 'disabled_run_1',
        automationId: DISABLED_WATCH_ID,
        executionPreference: 'dom-only',
      });
      expect(res.status).toBe(403);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(runCards(sse, DISABLED_WATCH_ID)).toEqual([]);
      expect(framesByType(sse.frames, 'snapshot-request')).toEqual([]);
    } finally {
      sse.close();
    }
  }, 15_000);
});
