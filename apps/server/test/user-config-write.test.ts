/**
 * G3（P2.5-c）写入通道端点测试：PUT/GET /v1/user-config 与 config-decision 拒收闭集。
 * subject 一律取自 JWT claims（tenant + hostUserId）；body.subject 与 claims 推导值不一致即 400。
 * 校验链 = validateUserOverlay（含 configSchemas）+ validateOverlayAgainstL1（基线自 assembly 全量工具/自动化）。
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignJWT } from 'jose';
import type { UserOverlay, UserOverlayPackScope } from '@zen-agent/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../src/index.js';

const repoRoot = new URL('../../../', import.meta.url).pathname;
const snapshotRoot = join(repoRoot, 'examples/host-demo/config');
const systemPromptPath = join(repoRoot, 'assets/system-prompt.md');
const AUDIT_SINK = join(mkdtempSync(join(tmpdir(), 'za-ucw-audit-')), 'events.jsonl');

const JWT_SECRET = 'za-test-secret';
const SIGNING_SECRET = 'za-test-signing-secret';
const ISS = 'zen-agent-demo';
const key = new TextEncoder().encode(JWT_SECRET);
const TENANT = 'demo-tenant';

/** fs store 空态 revision 语义：sha256('null') 的 hex（user-config-store 同口径）。 */
const EMPTY_REVISION = createHash('sha256').update('null').digest('hex');

let server: RunningServer;
let baseUrl = '';
const userConfigDir = mkdtempSync(join(tmpdir(), 'za-ucw-store-'));

beforeAll(async () => {
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

function putOverlay(token: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/v1/user-config`, {
    method: 'PUT',
    headers: authHeaders(token, { 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
}

async function getOverlay(token: string): Promise<{ overlay: UserOverlay | null; revision: string }> {
  const res = await fetch(`${baseUrl}/v1/user-config`, { headers: authHeaders(token) });
  expect(res.status).toBe(200);
  return (await res.json()) as { overlay: UserOverlay | null; revision: string };
}

function overlayFor(hostUserId: string, packScope: Record<string, unknown>): UserOverlay {
  return {
    schemaVersion: 1,
    subject: { tenant: TENANT, hostUserId },
    packs: { 'host-demo': packScope },
  } as UserOverlay;
}

function ruleEntry(id: string, text: string): Record<string, unknown> {
  return { id, text, origin: 'manual', createdAt: '2026-08-05T00:00:00.000Z' };
}

function userConfigWriteEvents(hostUserId: string): Array<Record<string, unknown>> {
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

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待条件超时');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('PUT /v1/user-config（面板结构化编辑，R3）', () => {
  it('合法 overlay → 200 {revision}，并落 user-config-write 审计（origin=panel，写后全量快照）', async () => {
    const hostUserId = 'ucw-panel-ok';
    const token = await signToken(hostUserId);
    const overlay = overlayFor(hostUserId, {
      rules: [ruleEntry('r-panel-1', '回复统一使用敬语。')],
      restrictions: { riskTierRaise: { 'order-list.cancel-order': 'forbidden' } },
    });
    const res = await putOverlay(token, overlay);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revision: string };
    expect(body.revision).toMatch(/^[0-9a-f]{64}$/);

    await waitFor(() => userConfigWriteEvents(hostUserId).length === 1);
    const event = userConfigWriteEvents(hostUserId)[0]!;
    const data = event['data'] as Record<string, unknown>;
    expect(data['origin']).toBe('panel');
    expect(data['revision']).toBe(body.revision);
    expect(data['subject']).toEqual({ tenant: TENANT, hostUserId });
    expect(data['overlay']).toEqual(overlay);
  });

  it('body.subject 与 JWT claims 推导值不一致 → 400 且不落盘', async () => {
    const hostUserId = 'ucw-subject-mismatch';
    const token = await signToken(hostUserId);
    const res = await putOverlay(
      token,
      overlayFor('someone-else', { rules: [ruleEntry('r-x', '冒名写入。')] }),
    );
    expect(res.status).toBe(400);
    const state = await getOverlay(token);
    expect(state.overlay).toBeNull();
    expect(userConfigWriteEvents(hostUserId)).toHaveLength(0);
  });

  it('schema 不过（enabled:true 违反只收紧闭集）→ 400 拒收不落盘', async () => {
    const hostUserId = 'ucw-schema-bad';
    const token = await signToken(hostUserId);
    const res = await putOverlay(token, overlayFor(hostUserId, { enabled: true }));
    expect(res.status).toBe(400);
    const state = await getOverlay(token);
    expect(state.overlay).toBeNull();
  });

  it('riskTierRaise 低于 L1 基线（forbidden 工具声明 hitl）→ 400（validateOverlayAgainstL1）', async () => {
    const hostUserId = 'ucw-lower-tier';
    const token = await signToken(hostUserId);
    const res = await putOverlay(
      token,
      overlayFor(hostUserId, {
        restrictions: { riskTierRaise: { 'order-list.purge-orders': 'hitl' } },
      }),
    );
    expect(res.status).toBe(400);
    const state = await getOverlay(token);
    expect(state.overlay).toBeNull();
  });

  it('packConfig 无对应 configSchema 声明 → 400（fail-closed）', async () => {
    const hostUserId = 'ucw-packconfig';
    const token = await signToken(hostUserId);
    const res = await putOverlay(
      token,
      overlayFor(hostUserId, { packConfig: { theme: 'dark' } }),
    );
    expect(res.status).toBe(400);
    const state = await getOverlay(token);
    expect(state.overlay).toBeNull();
  });

  it('无鉴权 PUT/GET → 401（fail-closed）', async () => {
    const put = await fetch(`${baseUrl}/v1/user-config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(put.status).toBe(401);
    const get = await fetch(`${baseUrl}/v1/user-config`);
    expect(get.status).toBe(401);
  });
});

describe('GET /v1/user-config（配置中心读取面）', () => {
  it('空态 → {overlay:null, revision:sha256("null")}（与 fs store 空态 revision 同口径）', async () => {
    const token = await signToken('ucw-empty');
    const state = await getOverlay(token);
    expect(state.overlay).toBeNull();
    expect(state.revision).toBe(EMPTY_REVISION);
  });

  it('PUT 后立即 GET：revision 与 overlay 一致（边界：写读闭环）', async () => {
    const hostUserId = 'ucw-roundtrip';
    const token = await signToken(hostUserId);
    const overlay = overlayFor(hostUserId, { rules: [ruleEntry('r-rt-1', '报价引用运费模板。')] });
    const put = await putOverlay(token, overlay);
    expect(put.status).toBe(200);
    const { revision } = (await put.json()) as { revision: string };
    const state = await getOverlay(token);
    expect(state.revision).toBe(revision);
    expect(state.overlay).toEqual(overlay);
  });

  it('两 subject 隔离：A 写入不影响 B 的空态', async () => {
    const tokenA = await signToken('ucw-iso-a');
    const tokenB = await signToken('ucw-iso-b');
    const put = await putOverlay(
      tokenA,
      overlayFor('ucw-iso-a', { rules: [ruleEntry('r-iso', 'A 的规则。')] }),
    );
    expect(put.status).toBe(200);
    const stateB = await getOverlay(tokenB);
    expect(stateB.overlay).toBeNull();
  });
});

describe('config-decision 拒收闭集（teach 全链路见 teach-flow.test.ts）', () => {
  it('未知 draftId → 409（一次性草稿等待器闭集，与 hitl/exec 无挂起同口径 fail-closed）', async () => {
    const token = await signToken('ucw-decision');
    const created = await fetch(`${baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: authHeaders(token),
    });
    expect(created.status).toBe(201);
    const { sessionId } = (await created.json()) as { sessionId: string };
    const res = await fetch(`${baseUrl}/v1/sessions/${sessionId}/frames`, {
      method: 'POST',
      headers: authHeaders(token, { 'content-type': 'application/json' }),
      body: JSON.stringify({
        type: 'config-decision',
        sessionId,
        draftId: 'd-no-such-draft',
        decision: 'accept',
      }),
    });
    expect(res.status).toBe(409);
  });
});

describe('PUT 并发控制 / 来源保真 / 体积守卫（G3 评审修复项）', () => {
  it('expectedRevision 乐观并发：不符 409 不落盘，相符 200（防面板旧态覆盖）', async () => {
    const hostUserId = 'put-optimistic';
    const token = await signToken(hostUserId);
    const first = await putOverlay(
      token,
      overlayFor(hostUserId, { rules: [ruleEntry('r-oc-1', '第一版规则。')] }),
    );
    expect(first.status).toBe(200);
    const { revision } = (await first.json()) as { revision: string };

    const stale = await fetch(`${baseUrl}/v1/user-config?expectedRevision=deadbeef`, {
      method: 'PUT',
      headers: authHeaders(token, { 'content-type': 'application/json' }),
      body: JSON.stringify(overlayFor(hostUserId, { rules: [ruleEntry('r-oc-2', '旧态覆盖。')] })),
    });
    expect(stale.status).toBe(409);
    expect((await getOverlay(token)).revision).toBe(revision);

    const fresh = await fetch(
      `${baseUrl}/v1/user-config?expectedRevision=${encodeURIComponent(revision)}`,
      {
        method: 'PUT',
        headers: authHeaders(token, { 'content-type': 'application/json' }),
        body: JSON.stringify(overlayFor(hostUserId, { rules: [ruleEntry('r-oc-3', '第二版规则。')] })),
      },
    );
    expect(fresh.status).toBe(200);
  });

  it('来源保真（R4）：新增条目 origin 强制 manual 并剥离 sourceSessionId；既有 teach 条目原样保留', async () => {
    const hostUserId = 'put-origin';
    const token = await signToken(hostUserId);
    const forged = await putOverlay(
      token,
      overlayFor(hostUserId, {
        rules: [
          {
            id: 'r-forged-1',
            text: '伪饰来源的规则。',
            origin: 'teach',
            sourceSessionId: 'session-forged',
            createdAt: '2026-08-05T00:00:00.000Z',
          },
        ],
      }),
    );
    expect(forged.status).toBe(200);
    const state = await getOverlay(token);
    const scope = state.overlay?.packs['host-demo'] as UserOverlayPackScope;
    expect(scope.rules?.[0]).toMatchObject({ id: 'r-forged-1', origin: 'manual' });
    expect(scope.rules?.[0]?.sourceSessionId).toBeUndefined();

    // 既有条目（同 id 再次 PUT）origin 原样保留——归一只作用于新增
    const keep = await putOverlay(
      token,
      overlayFor(hostUserId, {
        rules: [
          {
            id: 'r-forged-1',
            text: '伪饰来源的规则。',
            origin: 'manual',
            createdAt: '2026-08-05T00:00:00.000Z',
          },
        ],
      }),
    );
    expect(keep.status).toBe(200);
  });

  it('体积守卫：条目总数超上限 → 400 不落盘', async () => {
    const hostUserId = 'put-oversize';
    const token = await signToken(hostUserId);
    const rules = Array.from({ length: 501 }, (_, i) => ruleEntry(`r-big-${i}`, `规则 ${i}。`));
    const res = await putOverlay(token, overlayFor(hostUserId, { rules }));
    expect(res.status).toBe(400);
    expect((await getOverlay(token)).overlay).toBeNull();
  });
});
