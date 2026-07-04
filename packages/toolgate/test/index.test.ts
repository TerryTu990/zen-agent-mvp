import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ExecResultFrame, IdentityClaims, ToolDefinition } from '@zen-agent/contracts';
import { computeExecSignature, createToolGatePort } from '../src/index.js';

// 仅测试固定值，非真实密钥（真实密钥运行时经 env 注入，ZA-C-SEC-02）。
const SIGN_FIXTURE = 'dev-fixture-value';
const OTHER_FIXTURE = 'other-fixture-value';

const validClaims: IdentityClaims = {
  sub: 'u1',
  tenant: 'default',
  roles: ['user'],
  hostUserId: 'host-1',
  iss: 'demo',
  exp: 9999999999,
};

const autoTool: ToolDefinition = {
  id: 'order-list.refresh-orders',
  featureIds: ['order-list'],
  description: '刷新订单列表',
  params: { type: 'object', properties: {}, additionalProperties: false },
  execution: 'client',
  riskTier: 'auto',
  adapter: { method: 'GET', urlTemplate: '/api/orders' },
  resultSchema: {
    type: 'object',
    required: ['ok'],
    properties: { ok: { type: 'boolean' }, count: { type: 'number' } },
  },
};

const hitlTool: ToolDefinition = {
  id: 'order-list.cancel-order',
  featureIds: ['order-list'],
  description: '取消指定订单',
  params: {
    type: 'object',
    required: ['orderId'],
    properties: { orderId: { type: 'string' } },
    additionalProperties: false,
  },
  execution: 'client',
  riskTier: 'hitl',
  adapter: { method: 'POST', urlTemplate: '/api/orders/{{orderId}}/cancel' },
  resultSchema: {
    type: 'object',
    required: ['ok', 'orderId'],
    properties: { ok: { type: 'boolean' }, orderId: { type: 'string' } },
  },
};

const forbiddenTool: ToolDefinition = {
  id: 'order-list.purge-orders',
  featureIds: ['order-list'],
  description: '清空所有订单（危险）',
  params: { type: 'object', properties: {}, additionalProperties: false },
  execution: 'client',
  riskTier: 'forbidden',
  adapter: { method: 'DELETE', urlTemplate: '/api/orders' },
  resultSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
};

const serverTool: ToolDefinition = {
  id: 'order-list.server-op',
  featureIds: ['order-list'],
  description: 'server 通道（MVP 未实现）',
  params: { type: 'object', properties: {}, additionalProperties: false },
  execution: 'server',
  riskTier: 'auto',
  adapter: { method: 'GET', urlTemplate: 'https://host.example/api/orders' },
  resultSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
};

const unknownTierTool = {
  id: 'order-list.weird',
  featureIds: ['order-list'],
  description: 'riskTier 未知',
  params: { type: 'object', properties: {}, additionalProperties: false },
  execution: 'client',
  riskTier: 'wat',
  adapter: { method: 'GET', urlTemplate: '/api/orders' },
  resultSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
} as unknown as ToolDefinition;

const templateTool: ToolDefinition = {
  id: 'order-list.note-order',
  featureIds: ['order-list'],
  description: '给订单加备注',
  params: {
    type: 'object',
    required: ['orderId', 'memo'],
    properties: { orderId: { type: 'string' }, memo: { type: 'string' } },
    additionalProperties: false,
  },
  execution: 'client',
  riskTier: 'auto',
  adapter: {
    method: 'POST',
    urlTemplate: '/api/orders/{{orderId}}/note',
    headers: { 'X-Memo': '{{memo}}' },
    bodyTemplate: { memo: '{{memo}}', tag: 'fixed' },
  },
  resultSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
};

const allTools: ToolDefinition[] = [
  autoTool,
  hitlTool,
  forbiddenTool,
  serverTool,
  unknownTierTool,
  templateTool,
];

function makePort(overrides?: { ttlMs?: number; now?: () => number }) {
  return createToolGatePort({
    tools: allTools,
    signingSecret: SIGN_FIXTURE,
    ...(overrides?.ttlMs !== undefined ? { ttlMs: overrides.ttlMs } : {}),
    ...(overrides?.now !== undefined ? { now: overrides.now } : {}),
  });
}

describe('toolgate decide — fail-closed 分级矩阵', () => {
  it('工具不在闭集 → deny unknown-tool', async () => {
    const d = await makePort().decide({
      sessionId: 's1',
      toolCallId: 'c1',
      toolId: 'order-list.does-not-exist',
      params: {},
      claims: validClaims,
    });
    expect(d.verdict).toBe('deny');
    expect(d.reason).toBe('unknown-tool');
  });

  it('riskTier 未知 → deny', async () => {
    const d = await makePort().decide({
      sessionId: 's1',
      toolCallId: 'c1',
      toolId: unknownTierTool.id,
      params: {},
      claims: validClaims,
    });
    expect(d.verdict).toBe('deny');
    expect(d.reason).toBe('unknown-risk-tier');
  });

  it('execution 非 client → deny channel-not-implemented（U3 fail-closed）', async () => {
    const d = await makePort().decide({
      sessionId: 's1',
      toolCallId: 'c1',
      toolId: serverTool.id,
      params: {},
      claims: validClaims,
    });
    expect(d.verdict).toBe('deny');
    expect(d.reason).toBe('channel-not-implemented');
  });

  it('实参不过 params schema → deny invalid-params（reason 不含实参值）', async () => {
    const d = await makePort().decide({
      sessionId: 's1',
      toolCallId: 'c1',
      toolId: hitlTool.id,
      params: { orderId: 123 },
      claims: validClaims,
    });
    expect(d.verdict).toBe('deny');
    expect(d.reason).toBe('invalid-params');
    expect(d.reason).not.toContain('123');
  });

  it('身份缺 hostUserId → deny identity', async () => {
    const d = await makePort().decide({
      sessionId: 's1',
      toolCallId: 'c1',
      toolId: autoTool.id,
      params: {},
      claims: { ...validClaims, hostUserId: '' },
    });
    expect(d.verdict).toBe('deny');
    expect(d.reason).toBe('identity');
  });

  it('invalid-params 先于 identity 判定（顺序）', async () => {
    const d = await makePort().decide({
      sessionId: 's1',
      toolCallId: 'c1',
      toolId: hitlTool.id,
      params: {},
      claims: { ...validClaims, hostUserId: '' },
    });
    expect(d.reason).toBe('invalid-params');
  });

  it('riskTier=forbidden → deny forbidden', async () => {
    const d = await makePort().decide({
      sessionId: 's1',
      toolCallId: 'c1',
      toolId: forbiddenTool.id,
      params: {},
      claims: validClaims,
    });
    expect(d.verdict).toBe('deny');
    expect(d.reason).toBe('forbidden');
  });

  it('riskTier=auto → allow', async () => {
    const d = await makePort().decide({
      sessionId: 's1',
      toolCallId: 'c1',
      toolId: autoTool.id,
      params: {},
      claims: validClaims,
    });
    expect(d.verdict).toBe('allow');
  });

  it('riskTier=hitl → hitl', async () => {
    const d = await makePort().decide({
      sessionId: 's1',
      toolCallId: 'c1',
      toolId: hitlTool.id,
      params: { orderId: 'ORD-1001' },
      claims: validClaims,
    });
    expect(d.verdict).toBe('hitl');
  });
});

describe('toolgate issueExecInstruction — 一次性签名指令', () => {
  it('按 adapter 模板代入实参、urlencode 路径段，签名可同 secret 复算', async () => {
    const frame = await makePort().issueExecInstruction({
      sessionId: 's1',
      toolCallId: 'c1',
      toolId: hitlTool.id,
      params: { orderId: 'ORD/1001' },
    });
    expect(frame.type).toBe('exec-instruction');
    expect(frame.sessionId).toBe('s1');
    expect(frame.toolCallId).toBe('c1');
    expect(frame.request.method).toBe('POST');
    expect(frame.request.url).toBe('/api/orders/ORD%2F1001/cancel');
    expect(frame.ttl).toBe(60000);
    expect(typeof frame.nonce).toBe('string');
    expect(frame.nonce.length).toBeGreaterThan(0);

    const expected = computeExecSignature(SIGN_FIXTURE, {
      nonce: frame.nonce,
      ttl: frame.ttl,
      toolCallId: frame.toolCallId,
      request: frame.request,
    });
    expect(frame.signature).toBe(expected);
    // 错 secret 复算得不同签名（防伪造）
    const wrong = computeExecSignature(OTHER_FIXTURE, {
      nonce: frame.nonce,
      ttl: frame.ttl,
      toolCallId: frame.toolCallId,
      request: frame.request,
    });
    expect(frame.signature).not.toBe(wrong);
  });

  it('自定义 ttlMs 生效', async () => {
    const frame = await makePort({ ttlMs: 5000 }).issueExecInstruction({
      sessionId: 's1',
      toolCallId: 'c1',
      toolId: autoTool.id,
      params: {},
    });
    expect(frame.ttl).toBe(5000);
  });

  it('headers/bodyTemplate 占位符按 params 代入', async () => {
    const frame = await makePort().issueExecInstruction({
      sessionId: 's1',
      toolCallId: 'c1',
      toolId: templateTool.id,
      params: { orderId: 'ORD-9', memo: 'hello world' },
    });
    expect(frame.request.url).toBe('/api/orders/ORD-9/note');
    expect(frame.request.headers).toEqual({ 'X-Memo': 'hello world' });
    expect(frame.request.body).toEqual({ memo: 'hello world', tag: 'fixed' });
  });

  it('每次签发 nonce 唯一', async () => {
    const port = makePort();
    const a = await port.issueExecInstruction({
      sessionId: 's1',
      toolCallId: 'c1',
      toolId: autoTool.id,
      params: {},
    });
    const b = await port.issueExecInstruction({
      sessionId: 's1',
      toolCallId: 'c2',
      toolId: autoTool.id,
      params: {},
    });
    expect(a.nonce).not.toBe(b.nonce);
  });
});

async function issueAndResult(
  port: ReturnType<typeof makePort>,
  toolId: string,
  params: Record<string, unknown>,
  result: (nonce: string) => ExecResultFrame,
) {
  const frame = await port.issueExecInstruction({
    sessionId: 's1',
    toolCallId: 'c1',
    toolId,
    params: params as never,
  });
  return { frame, obs: await port.acceptExecResult({ sessionId: 's1', result: result(frame.nonce) }) };
}

describe('toolgate acceptExecResult — 核销 + 校验 + 规整', () => {
  it('ok:true 且 body 过 resultSchema → observation ok:true content=body', async () => {
    const port = makePort();
    const { frame, obs } = await issueAndResult(
      port,
      hitlTool.id,
      { orderId: 'ORD-1001' },
      (nonce) => ({
        type: 'exec-result',
        sessionId: 's1',
        nonce,
        ok: true,
        status: 200,
        body: { ok: true, orderId: 'ORD-1001' },
      }),
    );
    expect(obs.ok).toBe(true);
    expect(obs.content).toEqual({ ok: true, orderId: 'ORD-1001' });
    expect(obs.error).toBeUndefined();
    expect(obs.toolCallId).toBe(frame.toolCallId);
  });

  it('ok:true 但 body 不过 resultSchema → invalid-result（不采信上报原文，U7）', async () => {
    const { obs } = await issueAndResult(makePort(), hitlTool.id, { orderId: 'ORD-1001' }, (nonce) => ({
      type: 'exec-result',
      sessionId: 's1',
      nonce,
      ok: true,
      body: { ok: 'yes' },
    }));
    expect(obs.ok).toBe(false);
    expect(obs.error).toBe('invalid-result');
    expect(obs.content).toBeNull();
  });

  it('ok:false 带 error → 透传该 error', async () => {
    const { obs } = await issueAndResult(makePort(), hitlTool.id, { orderId: 'ORD-1001' }, (nonce) => ({
      type: 'exec-result',
      sessionId: 's1',
      nonce,
      ok: false,
      status: 500,
      error: 'HTTP 500',
    }));
    expect(obs.ok).toBe(false);
    expect(obs.error).toBe('HTTP 500');
  });

  it('ok:false 无 error → exec-failed', async () => {
    const { obs } = await issueAndResult(makePort(), hitlTool.id, { orderId: 'ORD-1001' }, (nonce) => ({
      type: 'exec-result',
      sessionId: 's1',
      nonce,
      ok: false,
    }));
    expect(obs.ok).toBe(false);
    expect(obs.error).toBe('exec-failed');
  });

  it('同 nonce 二次回收 → replayed（一次性防重放，U7）', async () => {
    const port = makePort();
    const frame = await port.issueExecInstruction({
      sessionId: 's1',
      toolCallId: 'c1',
      toolId: hitlTool.id,
      params: { orderId: 'ORD-1001' },
    });
    const good: ExecResultFrame = {
      type: 'exec-result',
      sessionId: 's1',
      nonce: frame.nonce,
      ok: true,
      body: { ok: true, orderId: 'ORD-1001' },
    };
    const first = await port.acceptExecResult({ sessionId: 's1', result: good });
    expect(first.ok).toBe(true);
    const second = await port.acceptExecResult({ sessionId: 's1', result: good });
    expect(second.ok).toBe(false);
    expect(second.error).toBe('replayed');
  });

  it('超过 ttl → timeout 并核销', async () => {
    let clock = 1000;
    const port = makePort({ ttlMs: 100, now: () => clock });
    const frame = await port.issueExecInstruction({
      sessionId: 's1',
      toolCallId: 'c1',
      toolId: hitlTool.id,
      params: { orderId: 'ORD-1001' },
    });
    clock = 1000 + 100 + 1;
    const obs = await port.acceptExecResult({
      sessionId: 's1',
      result: {
        type: 'exec-result',
        sessionId: 's1',
        nonce: frame.nonce,
        ok: true,
        body: { ok: true, orderId: 'ORD-1001' },
      },
    });
    expect(obs.ok).toBe(false);
    expect(obs.error).toBe('timeout');
    // 已核销：ttl 后再来一次走 replayed（replayed 优先于 timeout）
    const again = await port.acceptExecResult({
      sessionId: 's1',
      result: {
        type: 'exec-result',
        sessionId: 's1',
        nonce: frame.nonce,
        ok: true,
        body: { ok: true, orderId: 'ORD-1001' },
      },
    });
    expect(again.ok).toBe(false);
    expect(again.error).toBe('replayed');
  });

  it('未知 nonce → unknown-nonce', async () => {
    const obs = await makePort().acceptExecResult({
      sessionId: 's1',
      result: { type: 'exec-result', sessionId: 's1', nonce: 'nope', ok: true, body: { ok: true } },
    });
    expect(obs.ok).toBe(false);
    expect(obs.error).toBe('unknown-nonce');
  });
});

describe('computeExecSignature — 稳定键序（防篡改）', () => {
  it('键序不影响签名，值变则签名变', () => {
    const a = computeExecSignature(SIGN_FIXTURE, {
      nonce: 'n',
      ttl: 1,
      toolCallId: 'c',
      x: { p: 1, q: 2 },
    });
    const b = computeExecSignature(SIGN_FIXTURE, {
      x: { q: 2, p: 1 },
      toolCallId: 'c',
      ttl: 1,
      nonce: 'n',
    });
    expect(a).toBe(b);
    const c = computeExecSignature(SIGN_FIXTURE, {
      nonce: 'n',
      ttl: 2,
      toolCallId: 'c',
      x: { p: 1, q: 2 },
    });
    expect(a).not.toBe(c);
    // 锚定实现为 HMAC-SHA256 over 稳定键序 JSON
    const manual = createHmac('sha256', SIGN_FIXTURE)
      .update('{"nonce":"n","toolCallId":"c","ttl":1,"x":{"p":1,"q":2}}')
      .digest('hex');
    expect(a).toBe(manual);
  });
});
