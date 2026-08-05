/**
 * G3（P2.5-c）E2E-B 服务集成级：teach 草稿 → config-draft 帧 → config-decision → 落盘/审计 →
 * 下轮注入与透明视图互证；收紧路径 accept 后 auto 工具判 hitl。
 * 驱动：可编程脚本 mock LLM（逐请求出队响应，支持 tool_call 分片流式，与 llm-port 聚合契约对齐）。
 * 工具命名：llm-port 出网把点分 toolId 的 '.' 替换为 '__'；config_draft 无点，名称原样。
 */
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignJWT } from 'jose';
import { CONFIG_DRAFT_TOOL_ID } from '@zen-agent/contracts';
import type { UserOverlay, UserOverlayEntry, UserOverlayPackScope } from '@zen-agent/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../src/index.js';

const repoRoot = new URL('../../../', import.meta.url).pathname;
const snapshotRoot = join(repoRoot, 'examples/host-demo/config');
const systemPromptPath = join(repoRoot, 'assets/system-prompt.md');
const AUDIT_SINK = join(mkdtempSync(join(tmpdir(), 'za-teach-audit-')), 'events.jsonl');
const ORDER_LIST_URL = 'http://127.0.0.1:4173/order-list.html';

const JWT_SECRET = 'za-test-secret';
const SIGNING_SECRET = 'za-test-signing-secret';
const ISS = 'zen-agent-demo';
const key = new TextEncoder().encode(JWT_SECRET);
const TENANT = 'demo-tenant';

// ---- 可编程脚本 mock LLM ----

interface ScriptedResponse {
  text?: string;
  toolCall?: { id: string; name: string; arguments: string };
}

interface ScriptedMock {
  port: number;
  queue: ScriptedResponse[];
  requests: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

function startScriptedMock(): Promise<ScriptedMock> {
  const queue: ScriptedResponse[] = [];
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
        /* 非 JSON 请求体不应发生 */
      }
      const scripted = queue.shift() ?? { text: 'ok' };
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
      if (scripted.toolCall !== undefined) {
        send({
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: scripted.toolCall.id,
              type: 'function',
              function: { name: scripted.toolCall.name, arguments: scripted.toolCall.arguments },
            }],
          },
          finish_reason: null,
        });
        send({ index: 0, delta: {}, finish_reason: 'tool_calls' });
      } else {
        send({ index: 0, delta: { content: scripted.text ?? 'ok' }, finish_reason: null });
        send({ index: 0, delta: {}, finish_reason: 'stop' });
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve({
        port,
        queue,
        requests,
        close: () => new Promise((r) => httpServer.close(() => r())),
      });
    });
  });
}

// ---- 会话与 SSE 辅助 ----

let mock: ScriptedMock;
let server: RunningServer;
let baseUrl = '';
let prevBaseUrl: string | undefined;
const userConfigDir = mkdtempSync(join(tmpdir(), 'za-teach-store-'));

beforeAll(async () => {
  mock = await startScriptedMock();
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

function postFrame(token: string, sessionId: string, frame: unknown): Promise<Response> {
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
      /* abort 断开属正常收尾 */
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

async function getUserConfig(token: string): Promise<{ overlay: UserOverlay | null; revision: string }> {
  const res = await fetch(`${baseUrl}/v1/user-config`, { headers: authHeaders(token) });
  expect(res.status).toBe(200);
  return (await res.json()) as { overlay: UserOverlay | null; revision: string };
}

function auditEvents(sessionId: string): Array<Record<string, unknown>> {
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

function userConfigWriteEventsBySubject(hostUserId: string): Array<Record<string, unknown>> {
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
    .filter((event) => event['type'] === 'user-config-write')
    .filter(
      (event) =>
        ((event['data'] as Record<string, unknown>)['subject'] as Record<string, unknown>)['hostUserId'] ===
        hostUserId,
    );
}

async function waitUntil(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待条件超时');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** 驱动一轮 user-message 并等待 turn-complete（messageId 关联）。 */
async function runTurn(
  token: string,
  sessionId: string,
  sse: SseHandle,
  text: string,
  messageId: string,
): Promise<void> {
  const res = await postFrame(token, sessionId, { type: 'user-message', sessionId, messageId, text });
  expect(res.status).toBe(202);
  await sse.waitFor(() =>
    sse.frames.some((frame) => frame['type'] === 'turn-complete' && frame['messageId'] === messageId),
  );
}

describe('E2E-B teach 全链路（config_draft 工具 → 草稿帧 → 确认写入 → 下轮注入互证）', () => {
  it('契约常量：CONFIG_DRAFT_TOOL_ID = config_draft（内建工具沿 site_navigate 先例）', () => {
    expect(CONFIG_DRAFT_TOOL_ID).toBe('config_draft');
  });

  it('accept：草稿帧齐备 → 落盘 + user-config-write(origin=teach) → 下轮 system 注入含规则 → /injection user-rules 同 id → draftId 一次性', async () => {
    const hostUserId = 'teach-accept';
    const token = await signToken(hostUserId);
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    try {
      await postFrame(token, sessionId, { type: 'context-report', sessionId, url: ORDER_LIST_URL });

      const ruleText = '回复买家时引用运费模板。';
      mock.queue.length = 0;
      mock.queue.push(
        {
          toolCall: {
            id: 'call_draft_1',
            name: CONFIG_DRAFT_TOOL_ID,
            arguments: JSON.stringify({
              packId: 'host-demo',
              featureId: 'order-list',
              rules: [{ text: ruleText }],
            }),
          },
        },
        { text: '已生成配置草稿，等待你的确认。' },
      );
      await runTurn(token, sessionId, sse, '以后回复买家都要引用运费模板', 'm-teach-1');

      // 草稿帧：scope/summary/change 齐备；条目 id/origin/createdAt/sourceSessionId 由服务端生成
      const drafts = framesByType(sse.frames, 'config-draft');
      expect(drafts).toHaveLength(1);
      const draft = drafts[0]!;
      expect(draft['sessionId']).toBe(sessionId);
      const draftId = String(draft['draftId']);
      expect(draftId).toBeTruthy();
      expect(draft['scope']).toMatchObject({ packId: 'host-demo', featureId: 'order-list' });
      expect(String(draft['summary'])).not.toBe('');
      const change = draft['change'] as { rules: UserOverlayEntry[] };
      expect(change.rules).toHaveLength(1);
      const entry = change.rules[0]!;
      expect(entry.text).toBe(ruleText);
      expect(entry.origin).toBe('teach');
      expect(entry.id).toMatch(/^r-/);
      expect(entry.sourceSessionId).toBe(sessionId);
      expect(Number.isNaN(Date.parse(entry.createdAt))).toBe(false);

      // 确认写入
      const decided = await postFrame(token, sessionId, {
        type: 'config-decision',
        sessionId,
        draftId,
        decision: 'accept',
      });
      expect(decided.status).toBe(202);

      // 落盘：GET /v1/user-config 可见该条目
      await waitUntil(() => {
        return userConfigWriteEventsBySubject(hostUserId).length === 1;
      });
      const state = await getUserConfig(token);
      expect(state.overlay).not.toBeNull();
      const packScope = state.overlay!.packs['host-demo'] as UserOverlayPackScope;
      expect(packScope.rules).toEqual([entry]);

      // 审计：user-config-write origin=teach，revision 与 GET 一致，快照含该条目
      const writeEvent = userConfigWriteEventsBySubject(hostUserId)[0]!;
      const writeData = writeEvent['data'] as Record<string, unknown>;
      expect(writeData['origin']).toBe('teach');
      expect(writeData['revision']).toBe(state.revision);
      expect(JSON.stringify(writeData['overlay'])).toContain(ruleText);

      // 下轮注入：system 文本含规则与条目 id
      mock.requests.length = 0;
      mock.queue.push({ text: '第二轮回答。' });
      await runTurn(token, sessionId, sse, '你好', 'm-teach-2');
      const lastReq = mock.requests[mock.requests.length - 1]!;
      const messages = (lastReq['messages'] ?? []) as Array<{ role: string; content: string }>;
      const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
      expect(system).toContain('用户个人规则');
      expect(system).toContain(ruleText);
      expect(system).toContain(entry.id);

      // 透明视图：user-rules 块含该条目 id 且 origin=L2
      const injection = await fetch(`${baseUrl}/v1/sessions/${sessionId}/injection`, {
        headers: authHeaders(token),
      });
      expect(injection.status).toBe(200);
      const view = (await injection.json()) as {
        blocks?: Array<{ kind: string; id?: string; origin?: string }>;
      };
      const userRuleBlocks = (view.blocks ?? []).filter((block) => block.kind === 'user-rules');
      expect(userRuleBlocks.map((block) => block.id)).toContain(entry.id);
      expect(userRuleBlocks.every((block) => block.origin === 'L2')).toBe(true);

      // draftId 一次性：二次使用 → 409
      const replay = await postFrame(token, sessionId, {
        type: 'config-decision',
        sessionId,
        draftId,
        decision: 'accept',
      });
      expect(replay.status).toBe(409);
    } finally {
      sse.close();
    }
  });

  it('reject：弃草稿不落盘、无 user-config-write 事件；弃后 draftId 亦失效', async () => {
    const hostUserId = 'teach-reject';
    const token = await signToken(hostUserId);
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    try {
      await postFrame(token, sessionId, { type: 'context-report', sessionId, url: ORDER_LIST_URL });
      mock.queue.length = 0;
      mock.queue.push(
        {
          toolCall: {
            id: 'call_draft_reject',
            name: CONFIG_DRAFT_TOOL_ID,
            arguments: JSON.stringify({ packId: 'host-demo', rules: [{ text: '拒绝掉的规则。' }] }),
          },
        },
        { text: '草稿已提交。' },
      );
      await runTurn(token, sessionId, sse, '记住这个偏好', 'm-reject-1');
      const draft = framesByType(sse.frames, 'config-draft')[0]!;
      const draftId = String(draft['draftId']);

      const decided = await postFrame(token, sessionId, {
        type: 'config-decision',
        sessionId,
        draftId,
        decision: 'reject',
      });
      expect(decided.status).toBe(202);

      const state = await getUserConfig(token);
      expect(state.overlay).toBeNull();
      expect(userConfigWriteEventsBySubject(hostUserId)).toHaveLength(0);

      const replay = await postFrame(token, sessionId, {
        type: 'config-decision',
        sessionId,
        draftId,
        decision: 'accept',
      });
      expect(replay.status).toBe(409);
    } finally {
      sse.close();
    }
  });

  it('收紧路径：draft riskTierRaise(auto→hitl) accept 后，该工具调用判 hitl（弹确认卡、不直发指令）', async () => {
    const hostUserId = 'teach-tighten';
    const token = await signToken(hostUserId);
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    try {
      await postFrame(token, sessionId, { type: 'context-report', sessionId, url: ORDER_LIST_URL });

      mock.queue.length = 0;
      mock.queue.push(
        {
          toolCall: {
            id: 'call_draft_tighten',
            name: CONFIG_DRAFT_TOOL_ID,
            arguments: JSON.stringify({
              packId: 'host-demo',
              riskTierRaise: { 'order-list.refresh-orders': 'hitl' },
            }),
          },
        },
        { text: '收紧草稿已提交。' },
      );
      await runTurn(token, sessionId, sse, '以后刷新订单都要先问我', 'm-tighten-1');
      const draft = framesByType(sse.frames, 'config-draft')[0]!;
      const change = draft['change'] as {
        restrictions: { riskTierRaise: Record<string, string> };
      };
      expect(change.restrictions.riskTierRaise).toEqual({ 'order-list.refresh-orders': 'hitl' });

      const decided = await postFrame(token, sessionId, {
        type: 'config-decision',
        sessionId,
        draftId: String(draft['draftId']),
        decision: 'accept',
      });
      expect(decided.status).toBe(202);
      await waitUntil(() => userConfigWriteEventsBySubject(hostUserId).length === 1);

      // 下一轮：auto 工具经 L2 收紧后判 hitl —— 先弹确认卡，不直接下发签名指令
      mock.queue.push(
        { toolCall: { id: 'call_refresh', name: 'order-list.refresh-orders', arguments: '{}' } },
        { text: '好的，已取消刷新。' },
      );
      const posted = await postFrame(token, sessionId, {
        type: 'user-message',
        sessionId,
        messageId: 'm-tighten-2',
        text: '刷新订单列表',
      });
      expect(posted.status).toBe(202);
      await sse.waitFor(() => framesByType(sse.frames, 'hitl-request').length === 1);
      const hitl = framesByType(sse.frames, 'hitl-request')[0]!;
      expect(hitl['toolId']).toBe('order-list.refresh-orders');
      expect(framesByType(sse.frames, 'exec-instruction')).toHaveLength(0);

      await postFrame(token, sessionId, {
        type: 'hitl-decision',
        sessionId,
        hitlId: String(hitl['hitlId']),
        decision: 'reject',
      });
      await sse.waitFor(() =>
        sse.frames.some(
          (frame) => frame['type'] === 'turn-complete' && frame['messageId'] === 'm-tighten-2',
        ),
      );
      expect(framesByType(sse.frames, 'exec-instruction')).toHaveLength(0);

      // 审计互证：tool-decision 记 hitl 判定与生效分级（静态 auto → 生效 hitl），revision 与写入互证
      const state = await getUserConfig(token);
      const decisions = auditEvents(sessionId)
        .filter((event) => event['type'] === 'tool-decision')
        .map((event) => event['data'] as Record<string, unknown>)
        .filter((data) => data['toolId'] === 'order-list.refresh-orders');
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({
        riskTier: 'auto',
        verdict: 'hitl',
        effectiveTier: 'hitl',
        userConfigRevision: state.revision,
      });
    } finally {
      sse.close();
    }
  });
});

describe('草稿创建守卫（草稿期 fail-closed，agent 即时纠正）', () => {
  async function draftAttempt(
    hostUserId: string,
    args: Record<string, unknown>,
  ): Promise<{ sse: SseHandle; sessionId: string; token: string }> {
    const token = await signToken(hostUserId);
    const sessionId = await createSession(token);
    const sse = await openSse(token, sessionId);
    await postFrame(token, sessionId, { type: 'context-report', sessionId, url: ORDER_LIST_URL });
    mock.queue.length = 0;
    mock.queue.push(
      {
        toolCall: {
          id: 'call_guard',
          name: CONFIG_DRAFT_TOOL_ID,
          arguments: JSON.stringify(args),
        },
      },
      { text: '好的。' },
    );
    await runTurn(token, sessionId, sse, '记住这个偏好', `m-guard-${hostUserId}`);
    return { sse, sessionId, token };
  }

  function lastToolObservation(): string {
    const last = mock.requests[mock.requests.length - 1]!;
    const messages = (last['messages'] ?? []) as Array<{ role: string; content: string }>;
    return messages.filter((m) => m.role === 'tool').map((m) => m.content).join('\n');
  }

  it('featureId 与 riskTierRaise 同用 → 拒（收紧恒为 pack 级，scope 不失真）', async () => {
    const { sse } = await draftAttempt('guard-combo', {
      packId: 'host-demo',
      featureId: 'order-list',
      riskTierRaise: { 'order-list.refresh-orders': 'hitl' },
    });
    try {
      expect(framesByType(sse.frames, 'config-draft')).toHaveLength(0);
      expect(lastToolObservation()).toContain('config-draft-pack-level-restrictions');
    } finally {
      sse.close();
    }
  });

  it('packId 不在快照 → 拒（写入永不生效的惰性条目不产草稿）', async () => {
    const { sse } = await draftAttempt('guard-scope', {
      packId: 'no-such-pack',
      rules: [{ text: '不该出现的规则。' }],
    });
    try {
      expect(framesByType(sse.frames, 'config-draft')).toHaveLength(0);
      expect(lastToolObservation()).toContain('config-draft-unknown-scope');
    } finally {
      sse.close();
    }
  });

  it('base 已是 forbidden 的工具声明 hitl → 拒（不构成收紧，写入期必败提前拦）', async () => {
    const { sse } = await draftAttempt('guard-tighten', {
      packId: 'host-demo',
      riskTierRaise: { 'order-list.purge-orders': 'hitl' },
    });
    try {
      expect(framesByType(sse.frames, 'config-draft')).toHaveLength(0);
      expect(lastToolObservation()).toContain('config-draft-not-tightening');
    } finally {
      sse.close();
    }
  });
});

describe('草稿生命周期（TTL 过期 / 失败不吞噬草稿）', () => {
  it('TTL 过期后 accept → 409（一次性挂起过期语义）', async () => {
    const shortTtl = await startServer({
      port: 0,
      jwtSecret: JWT_SECRET,
      signingSecret: SIGNING_SECRET,
      issAllowlist: [ISS],
      snapshotRoot,
      systemPromptPath,
      auditSinkPath: AUDIT_SINK,
      allowedProviders: ['openai-compatible'],
      heartbeatMs: 60_000,
      userConfigDir: mkdtempSync(join(tmpdir(), 'za-teach-ttl-')),
      configDraftTtlMs: 60,
    });
    const ttlBase = `http://127.0.0.1:${shortTtl.port}`;
    try {
      const token = await signToken('ttl-expire');
      const created = await fetch(`${ttlBase}/v1/sessions`, { method: 'POST', headers: authHeaders(token) });
      const { sessionId } = (await created.json()) as { sessionId: string };
      const post = (frame: unknown): Promise<Response> =>
        fetch(`${ttlBase}/v1/sessions/${sessionId}/frames`, {
          method: 'POST',
          headers: authHeaders(token, { 'content-type': 'application/json' }),
          body: JSON.stringify(frame),
        });
      await post({ type: 'context-report', sessionId, url: ORDER_LIST_URL });
      mock.queue.length = 0;
      mock.queue.push(
        {
          toolCall: {
            id: 'call_ttl',
            name: CONFIG_DRAFT_TOOL_ID,
            arguments: JSON.stringify({ packId: 'host-demo', rules: [{ text: 'TTL 规则。' }] }),
          },
        },
        { text: '草稿已发出。' },
      );
      const sseRes = await fetch(`${ttlBase}/v1/sessions/${sessionId}/events`, {
        headers: authHeaders(token),
      });
      expect(sseRes.status).toBe(200);
      await post({ type: 'user-message', sessionId, messageId: 'm-ttl-0001', text: '记住' });
      // 从 SSE 流读出 draftId
      let draftId = '';
      const decoder = new TextDecoder();
      const reader = sseRes.body!.getReader();
      const deadline = Date.now() + 8000;
      let buffer = '';
      while (draftId === '' && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const match = buffer.match(/"type":"config-draft".*?"draftId":"([^"]+)"/);
        if (match !== null) draftId = match[1]!;
      }
      await reader.cancel();
      expect(draftId).not.toBe('');
      await new Promise((resolve) => setTimeout(resolve, 120));
      const decision = await post({ type: 'config-decision', sessionId, draftId, decision: 'accept' });
      expect(decision.status).toBe(409);
    } finally {
      await shortTtl.close();
    }
  });

  it('存储写入不可用时 accept → 503 且草稿不被吞噬（重试仍 503 而非 409）', async () => {
    // userConfigDir 指向普通文件：store 读写恒失败——draft 创建不受阻（过滤预检容错），accept 走 503。
    const brokenDirParent = mkdtempSync(join(tmpdir(), 'za-teach-broken-'));
    const brokenDir = join(brokenDirParent, 'not-a-dir');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(brokenDir, 'occupied', 'utf8');
    const broken = await startServer({
      port: 0,
      jwtSecret: JWT_SECRET,
      signingSecret: SIGNING_SECRET,
      issAllowlist: [ISS],
      snapshotRoot,
      systemPromptPath,
      auditSinkPath: AUDIT_SINK,
      allowedProviders: ['openai-compatible'],
      heartbeatMs: 60_000,
      userConfigDir: brokenDir,
    });
    const brokenBase = `http://127.0.0.1:${broken.port}`;
    try {
      const token = await signToken('store-broken');
      const created = await fetch(`${brokenBase}/v1/sessions`, { method: 'POST', headers: authHeaders(token) });
      const { sessionId } = (await created.json()) as { sessionId: string };
      const post = (frame: unknown): Promise<Response> =>
        fetch(`${brokenBase}/v1/sessions/${sessionId}/frames`, {
          method: 'POST',
          headers: authHeaders(token, { 'content-type': 'application/json' }),
          body: JSON.stringify(frame),
        });
      await post({ type: 'context-report', sessionId, url: ORDER_LIST_URL });
      mock.queue.length = 0;
      mock.queue.push(
        {
          toolCall: {
            id: 'call_broken',
            name: CONFIG_DRAFT_TOOL_ID,
            arguments: JSON.stringify({ packId: 'host-demo', rules: [{ text: '存储故障规则。' }] }),
          },
        },
        { text: '草稿已发出。' },
      );
      const sseRes = await fetch(`${brokenBase}/v1/sessions/${sessionId}/events`, {
        headers: authHeaders(token),
      });
      await post({ type: 'user-message', sessionId, messageId: 'm-broken-1', text: '记住' });
      let draftId = '';
      const decoder = new TextDecoder();
      const reader = sseRes.body!.getReader();
      const deadline = Date.now() + 8000;
      let buffer = '';
      while (draftId === '' && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const match = buffer.match(/"type":"config-draft".*?"draftId":"([^"]+)"/);
        if (match !== null) draftId = match[1]!;
      }
      await reader.cancel();
      expect(draftId).not.toBe('');
      const first = await post({ type: 'config-decision', sessionId, draftId, decision: 'accept' });
      expect(first.status).toBe(503);
      const retry = await post({ type: 'config-decision', sessionId, draftId, decision: 'accept' });
      expect(retry.status).toBe(503);
    } finally {
      await broken.close();
    }
  });
});
