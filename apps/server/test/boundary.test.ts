/**
 * ADR-013 批次④：站点边界标记注入的集成验证——同一会话跨 pack 切站时，
 * 回合开始向历史注入一条 BOUNDARY_MARKER 开头的结构消息（"以下对话发生在 <origin> 站点"）。
 * 用 acceptance 快照（codeflow + mail 两 pack）驱动：先在 codeflow 页发一回合，再切到 mail 页发一回合，
 * 断言持久化历史里出现指向 mail origin 的边界标记（首回合无标记）。
 */
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../src/index.js';

const repoRoot = new URL('../../../', import.meta.url).pathname;
const snapshotRoot = join(repoRoot, 'examples/acceptance');
const systemPromptPath = join(repoRoot, 'assets/system-prompt.md');

const JWT_SECRET = 'za-test-secret';
const SIGNING_SECRET = 'za-test-signing-secret';
const ISS = 'zen-agent-demo';
const key = new TextEncoder().encode(JWT_SECRET);

const CODEFLOW_URL = 'https://codeflow.asia/console/log';
const MAIL_URL = 'https://mail.126.com/js6/main.jsp';
const GENERIC_A_ORIGIN = 'https://generic-a.example';
const GENERIC_B_ORIGIN = 'https://generic-b.example';
const BOUNDARY_MARKER = '【站点边界】';

interface MockLlmHandle {
  port: number;
  close(): Promise<void>;
}

let mock: MockLlmHandle;
let server: RunningServer;
let baseUrl = '';
let sessionDir = '';

beforeAll(async () => {
  const mockLlmUrl = pathToFileURL(join(repoRoot, 'scripts/mock-llm/server.mjs')).href;
  const mockModule = (await import(mockLlmUrl)) as {
    startMockLlm(options?: { port?: number }): Promise<MockLlmHandle>;
  };
  mock = await mockModule.startMockLlm({ port: 0 });
  process.env['ZA_LLM_BASE_URL'] = `http://127.0.0.1:${mock.port}/v1`;
  process.env['ZA_LLM_MODEL'] = 'mock-model';
  sessionDir = mkdtempSync(join(tmpdir(), 'za-boundary-'));
  server = await startServer({
    port: 0,
    jwtSecret: JWT_SECRET,
    signingSecret: SIGNING_SECRET,
    issAllowlist: [ISS],
    snapshotRoot,
    systemPromptPath,
    auditSinkPath: join(sessionDir, 'events.jsonl'),
    allowedProviders: ['openai-compatible'],
    heartbeatMs: 60_000,
    sessionDir,
    genericAllowlist: [GENERIC_A_ORIGIN, GENERIC_B_ORIGIN],
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server?.close();
  await mock?.close();
});

async function signToken(): Promise<string> {
  return new SignJWT({ tenant: 'codeflow', roles: ['ops'], hostUserId: 'host-u1' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('user-1')
    .setIssuer(ISS)
    .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
    .sign(key);
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

function postFrame(token: string, sessionId: string, frame: unknown): Promise<Response> {
  return fetch(`${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/frames`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(frame),
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 轮询持久化会话文件直至谓词成立或超时（回合异步落盘边界，无需 SSE）。 */
async function waitForFile(file: string, predicate: (raw: string) => boolean): Promise<string> {
  const deadline = Date.now() + 8000;
  for (;;) {
    const raw = existsSync(file) ? readFileSync(file, 'utf8') : '';
    if (predicate(raw)) return raw;
    if (Date.now() > deadline) throw new Error(`等待会话落盘超时：${file}`);
    await sleep(60);
  }
}

/** 某 role:user 文本消息在持久化 history 事件里的出现次数（粗匹配子串）。 */
function countHistoryLines(raw: string): number {
  return raw.split('\n').filter((l) => l.includes('"t":"history"')).length;
}

describe('ADR-013 站点边界标记（跨 pack 切站注入）', () => {
  it('首回合无标记；切到 mail pack 的回合注入指向 mail origin 的边界标记', async () => {
    const token = await signToken();
    const created = await (
      await fetch(`${baseUrl}/v1/sessions`, { method: 'POST', headers: authHeaders(token) })
    ).json();
    const sessionId = (created as { sessionId: string }).sessionId;
    const file = join(sessionDir, `${sessionId}.jsonl`);

    // 回合①：codeflow 页（prev=null → 不注入边界标记）。
    await postFrame(token, sessionId, { type: 'context-report', sessionId, url: CODEFLOW_URL });
    await sleep(80);
    await postFrame(token, sessionId, { type: 'user-message', sessionId, text: '你好' });
    const afterTurn1 = await waitForFile(file, (raw) => countHistoryLines(raw) >= 1);
    expect(afterTurn1).not.toContain(BOUNDARY_MARKER);

    // 回合②：切到 mail 页（prev=codeflow ≠ mail → 注入边界标记）。
    await postFrame(token, sessionId, { type: 'context-report', sessionId, url: MAIL_URL });
    await sleep(80);
    await postFrame(token, sessionId, { type: 'user-message', sessionId, text: '你好' });
    const afterTurn2 = await waitForFile(file, (raw) => raw.includes(BOUNDARY_MARKER));
    expect(afterTurn2).toContain(BOUNDARY_MARKER);
    expect(afterTurn2).toContain('https://mail.126.com');
  });

  it('generic pack 跨 origin 切换（packId 恒定）：注入指向新 origin 的边界标记', async () => {
    const token = await signToken();
    const created = await (
      await fetch(`${baseUrl}/v1/sessions`, { method: 'POST', headers: authHeaders(token) })
    ).json();
    const sessionId = (created as { sessionId: string }).sessionId;
    const file = join(sessionDir, `${sessionId}.jsonl`);

    // 回合①：generic origin A（prev=null → 不注入）。
    await postFrame(token, sessionId, {
      type: 'context-report',
      sessionId,
      url: `${GENERIC_A_ORIGIN}/page-1`,
    });
    await sleep(80);
    await postFrame(token, sessionId, { type: 'user-message', sessionId, text: '你好' });
    const afterTurn1 = await waitForFile(file, (raw) => countHistoryLines(raw) >= 1);
    expect(afterTurn1).not.toContain(BOUNDARY_MARKER);

    // 回合②：切到 generic origin B（packId 不变、genericOrigin 变 → 注入指向 B 的标记）。
    await postFrame(token, sessionId, {
      type: 'context-report',
      sessionId,
      url: `${GENERIC_B_ORIGIN}/page-2`,
    });
    await sleep(80);
    await postFrame(token, sessionId, { type: 'user-message', sessionId, text: '你好' });
    const afterTurn2 = await waitForFile(file, (raw) =>
      raw.includes(`以下对话发生在 ${GENERIC_B_ORIGIN} 站点`),
    );
    expect(afterTurn2).toContain(BOUNDARY_MARKER);
  });
});
