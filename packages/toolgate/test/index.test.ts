import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ExecResultFrame, IdentityClaims, ToolDefinition } from '@zen-agent/contracts';
import { SITE_NAVIGATE_TOOL_ID } from '@zen-agent/contracts';
import {
  computeExecSignature,
  createToolGatePort,
  type BoundedFulfillmentPolicy,
} from '../src/index.js';

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
  description: 'server 通道（服务端直调）',
  params: { type: 'object', properties: {}, additionalProperties: false },
  execution: 'server',
  riskTier: 'auto',
  adapter: { method: 'GET', urlTemplate: 'https://host.example/api/orders' },
  resultSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
};

const serverCredTool: ToolDefinition = {
  id: 'order-list.server-fetch',
  featureIds: ['order-list'],
  description: 'server 通道：凭证经 {{credential}} 注入请求头',
  params: {
    type: 'object',
    required: ['orderId'],
    properties: { orderId: { type: 'string' } },
    additionalProperties: false,
  },
  execution: 'server',
  riskTier: 'auto',
  adapter: {
    method: 'GET',
    urlTemplate: 'https://host.example/api/orders/{{orderId}}?u={{hostUserId}}',
    headers: { Authorization: 'Bearer {{credential}}' },
    credentialRef: 'host-api-key',
  },
  resultSchema: {
    type: 'object',
    required: ['ok'],
    properties: { ok: { type: 'boolean' }, orderId: { type: 'string' } },
  },
};

// execution 非闭集值（模拟未来枚举扩张时的未实现通道）：decide 必 fail-closed 拒绝，不静默降级（U3）。
const bogusChannelTool = {
  ...serverTool,
  id: 'order-list.bogus-channel',
  execution: 'bogus',
} as unknown as ToolDefinition;

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

const identityTool: ToolDefinition = {
  id: 'host.create-key',
  featureIds: ['host'],
  description: '建 key（请求头/URL/体经 {{hostUserId}} 注入身份）',
  params: {
    type: 'object',
    required: ['name'],
    properties: { name: { type: 'string' }, hostUserId: { type: 'string' } },
    additionalProperties: false,
  },
  execution: 'client',
  riskTier: 'auto',
  adapter: {
    method: 'POST',
    urlTemplate: '/api/key?u={{hostUserId}}',
    headers: { 'New-Api-User': '{{hostUserId}}' },
    bodyTemplate: { name: '{{name}}', owner: '{{hostUserId}}' },
  },
  resultSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
};

const domTool: ToolDefinition = {
  id: 'order-list.page-operate',
  featureIds: ['order-list'],
  description: '在订单页可见地代用户操作（dom 批次）',
  params: {
    type: 'object',
    required: ['task', 'steps', 'summary'],
    properties: { task: { type: 'string' }, steps: { type: 'array' }, summary: { type: 'string' } },
    additionalProperties: false,
  },
  execution: 'client',
  riskTier: 'auto',
  adapter: { kind: 'dom', pathPrefixes: ['/console'] },
  resultSchema: {
    type: 'object',
    required: ['reads', 'completedSteps'],
    properties: { reads: { type: 'object' }, completedSteps: { type: 'number' } },
  },
};

/** hitl 级 dom 工具：任务级授权（grant）测试对象。 */
const domHitlTool: ToolDefinition = {
  ...domTool,
  id: 'order-list.page-operate-hitl',
  riskTier: 'hitl',
};

/** 带 task 参数的 hitl 级 http 工具：任务级授权跨工具共享测试对象。 */
const httpTaskHitlTool: ToolDefinition = {
  id: 'order-list.cancel-order-task',
  featureIds: ['order-list'],
  description: '取消订单（隶属某任务）',
  params: {
    type: 'object',
    required: ['task', 'orderId'],
    properties: { task: { type: 'string' }, orderId: { type: 'string' } },
    additionalProperties: false,
  },
  execution: 'client',
  riskTier: 'hitl',
  adapter: { method: 'POST', urlTemplate: '/api/orders/{{orderId}}/cancel' },
  resultSchema: {
    type: 'object',
    required: ['ok'],
    properties: { ok: { type: 'boolean' } },
  },
};

const boundedFulfillmentTool: ToolDefinition = {
  id: 'xianyu.send-delivery',
  featureIds: ['order-list'],
  description: '发送确定性履约通知',
  params: {
    type: 'object',
    required: ['productId', 'orderId', 'codeCount'],
    properties: {
      productId: { type: 'string' },
      orderId: { type: 'string' },
      codeCount: { type: 'integer', minimum: 1 },
    },
    additionalProperties: false,
  },
  execution: 'client',
  riskTier: 'hitl',
  hitlMode: 'every-call',
  authorization: {
    kind: 'bounded-fulfillment',
    productIdParam: 'productId',
    orderIdParam: 'orderId',
    quantityParam: 'codeCount',
  },
  adapter: { method: 'POST', urlTemplate: '/api/deliver/{{orderId}}' },
  resultSchema: {
    type: 'object',
    required: ['ok'],
    properties: { ok: { type: 'boolean' } },
    additionalProperties: false,
  },
};

/** dom 判定上下文夹具：快照页在围栏内、含 za-1/za-2 两个 ref。 */
const domContext = { refs: ['za-1', 'za-2'], path: '/console/token' };

const allTools: ToolDefinition[] = [
  autoTool,
  hitlTool,
  forbiddenTool,
  serverTool,
  serverCredTool,
  bogusChannelTool,
  unknownTierTool,
  templateTool,
  identityTool,
  domTool,
  domHitlTool,
  httpTaskHitlTool,
  boundedFulfillmentTool,
];

interface PortOverrides {
  ttlMs?: number;
  now?: () => number;
  resolveCredential?: (ref: string) => string | undefined;
  fetchImpl?: typeof fetch;
  fulfillmentPolicies?: BoundedFulfillmentPolicy[];
}

function makePort(overrides?: PortOverrides) {
  return createToolGatePort({
    tools: allTools,
    signingSecret: SIGN_FIXTURE,
    ...(overrides?.ttlMs !== undefined ? { ttlMs: overrides.ttlMs } : {}),
    ...(overrides?.now !== undefined ? { now: overrides.now } : {}),
    ...(overrides?.resolveCredential !== undefined
      ? { resolveCredential: overrides.resolveCredential }
      : {}),
    ...(overrides?.fetchImpl !== undefined ? { fetchImpl: overrides.fetchImpl } : {}),
    ...(overrides?.fulfillmentPolicies !== undefined
      ? { fulfillmentPolicies: overrides.fulfillmentPolicies }
      : {}),
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

  it('execution=server（已实现通道）→ 按分级放行（U3 两通道均放行）', async () => {
    const d = await makePort().decide({
      sessionId: 's1',
      toolCallId: 'c1',
      toolId: serverTool.id,
      params: {},
      claims: validClaims,
    });
    expect(d.verdict).toBe('allow');
  });

  it('execution 非闭集通道 → deny channel-not-implemented（U3 fail-closed，不静默降级）', async () => {
    const d = await makePort().decide({
      sessionId: 's1',
      toolCallId: 'c1',
      toolId: bogusChannelTool.id,
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
      claims: validClaims,
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
      claims: validClaims,
    });
    expect(frame.ttl).toBe(5000);
  });

  it('headers/bodyTemplate 占位符按 params 代入', async () => {
    const frame = await makePort().issueExecInstruction({
      sessionId: 's1',
      toolCallId: 'c1',
      toolId: templateTool.id,
      params: { orderId: 'ORD-9', memo: 'hello world' },
      claims: validClaims,
    });
    expect(frame.request.url).toBe('/api/orders/ORD-9/note');
    expect(frame.request.headers).toEqual({ 'X-Memo': 'hello world' });
    expect(frame.request.body).toEqual({ memo: 'hello world', tag: 'fixed' });
  });

  it('adapter 模板经 {{hostUserId}} 从已验签 claims 注入身份，工具 param 不能冒充', async () => {
    const frame = await makePort().issueExecInstruction({
      sessionId: 's1',
      toolCallId: 'c1',
      toolId: identityTool.id,
      // 恶意/混淆的同名 param 试图冒充身份，应被 claims 覆盖
      params: { name: 'k1', hostUserId: 'evil-spoof' },
      claims: validClaims,
    });
    expect(frame.request.headers).toEqual({ 'New-Api-User': 'host-1' });
    expect(frame.request.url).toBe('/api/key?u=host-1');
    expect(frame.request.body).toEqual({ name: 'k1', owner: 'host-1' });
  });

  it('每次签发 nonce 唯一', async () => {
    const port = makePort();
    const a = await port.issueExecInstruction({
      sessionId: 's1',
      toolCallId: 'c1',
      toolId: autoTool.id,
      params: {},
      claims: validClaims,
    });
    const b = await port.issueExecInstruction({
      sessionId: 's1',
      toolCallId: 'c2',
      toolId: autoTool.id,
      params: {},
      claims: validClaims,
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
    claims: validClaims,
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
      claims: validClaims,
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
      claims: validClaims,
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

describe('toolgate executeServer — server 通道服务端直调', () => {
  // 仅测试固定值，非真实凭证（真实凭证运行时经 resolveCredential 注入，ZA-C-SEC-02）。
  const CRED_FIXTURE = 'cred-fixture-value';

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('credentialRef 解析成功 → 凭证经 {{credential}} 注入请求头、身份经 claims 注入、body 过 resultSchema → ok', async () => {
    let capturedUrl = '';
    let capturedAuth: string | undefined;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedAuth = (init?.headers as Record<string, string>)['Authorization'];
      return jsonResponse({ ok: true, orderId: 'ORD-1' });
    }) as unknown as typeof fetch;
    const port = makePort({
      resolveCredential: (ref) => (ref === 'host-api-key' ? CRED_FIXTURE : undefined),
      fetchImpl,
    });
    const obs = await port.executeServer({
      sessionId: 's1',
      toolCallId: 'c1',
      toolId: serverCredTool.id,
      params: { orderId: 'ORD-1' },
      claims: validClaims,
    });
    expect(obs.ok).toBe(true);
    expect(obs.content).toEqual({ ok: true, orderId: 'ORD-1' });
    expect(obs.toolCallId).toBe('c1');
    expect(capturedAuth).toBe(`Bearer ${CRED_FIXTURE}`);
    // 身份取自已验签 claims（host-1），不被 param 冒充
    expect(capturedUrl).toBe('https://host.example/api/orders/ORD-1?u=host-1');
    // 凭证真值 MUST NOT 落 observation（SEC-01）
    expect(JSON.stringify(obs)).not.toContain(CRED_FIXTURE);
  });

  it('credentialRef 解析不到 → credential-unresolved，不发请求', async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;
    const port = makePort({ resolveCredential: () => undefined, fetchImpl });
    const obs = await port.executeServer({
      sessionId: 's1',
      toolCallId: 'c1',
      toolId: serverCredTool.id,
      params: { orderId: 'ORD-1' },
      claims: validClaims,
    });
    expect(obs.ok).toBe(false);
    expect(obs.error).toBe('credential-unresolved');
    expect(obs.content).toBeNull();
    expect(called).toBe(false);
  });

  it('响应 body 不过 resultSchema（2xx）→ invalid-result（不采信宿主原文，U7）', async () => {
    const fetchImpl = (async () => jsonResponse({ ok: 'yes' })) as unknown as typeof fetch;
    const port = makePort({ resolveCredential: () => CRED_FIXTURE, fetchImpl });
    const obs = await port.executeServer({
      sessionId: 's1',
      toolCallId: 'c1',
      toolId: serverCredTool.id,
      params: { orderId: 'ORD-1' },
      claims: validClaims,
    });
    expect(obs.ok).toBe(false);
    expect(obs.error).toBe('invalid-result');
    expect(obs.content).toBeNull();
  });

  it('非 2xx 且结果体不合契约 → exec-failed', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ message: 'forbidden' }, 403)) as unknown as typeof fetch;
    const port = makePort({ resolveCredential: () => CRED_FIXTURE, fetchImpl });
    const obs = await port.executeServer({
      sessionId: 's1',
      toolCallId: 'c1',
      toolId: serverCredTool.id,
      params: { orderId: 'ORD-1' },
      claims: validClaims,
    });
    expect(obs.ok).toBe(false);
    expect(obs.error).toBe('exec-failed');
  });

  it('网络异常 → exec-failed', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const port = makePort({ resolveCredential: () => CRED_FIXTURE, fetchImpl });
    const obs = await port.executeServer({
      sessionId: 's1',
      toolCallId: 'c1',
      toolId: serverCredTool.id,
      params: { orderId: 'ORD-1' },
      claims: validClaims,
    });
    expect(obs.ok).toBe(false);
    expect(obs.error).toBe('exec-failed');
  });

  it('非 server 通道工具调 executeServer → 前提破坏抛错', async () => {
    await expect(
      makePort().executeServer({
        sessionId: 's1',
        toolCallId: 'c1',
        toolId: autoTool.id,
        params: {},
        claims: validClaims,
      }),
    ).rejects.toThrow(/前提破坏/);
  });
});

describe('toolgate dom 批次 — fail-closed 校验与签发（adr-011）', () => {
  const base = { sessionId: 's1', toolCallId: 'c-dom', toolId: domTool.id, claims: validClaims };
  const goodParams = {
    task: '创建令牌并读取密钥',
    steps: [
      { action: 'fill', ref: 'za-1', value: 'my-key' },
      { action: 'click', ref: 'za-2' },
      { action: 'read', ref: 'za-1', name: 'tokenKey' },
    ],
    summary: '创建令牌并读取密钥',
  };

  it('合法批次 + 快照上下文 → allow，签发 kind=dom 指令且步骤被净化（剥多余键）', async () => {
    const port = makePort();
    const d = await port.decide({ ...base, params: goodParams, domContext });
    expect(d.verdict).toBe('allow');

    const dirtyParams = {
      task: '创建令牌并读取密钥',
      steps: [{ action: 'click', ref: 'za-2', hallucinated: 'x', value: '不该有' }],
      summary: '点一下',
    };
    const instruction = await port.issueExecInstruction({ ...base, params: dirtyParams, domContext });
    expect(instruction.request).toEqual({ kind: 'dom', steps: [{ action: 'click', ref: 'za-2' }] });
    // 签名覆盖净化后的 request：同 secret 可复算。
    expect(instruction.signature).toBe(
      computeExecSignature(SIGN_FIXTURE, {
        nonce: instruction.nonce,
        ttl: instruction.ttl,
        toolCallId: instruction.toolCallId,
        request: instruction.request as never,
      }),
    );
  });

  it('无快照上下文 → deny dom-context-missing（未观察不操作）', async () => {
    const d = await makePort().decide({ ...base, params: goodParams });
    expect(d).toEqual({ verdict: 'deny', reason: 'dom-context-missing' });
  });

  it('快照页路径不在围栏内 → deny fence-violation', async () => {
    const d = await makePort().decide({
      ...base,
      params: goodParams,
      domContext: { refs: ['za-1'], path: '/admin/users' },
    });
    expect(d).toEqual({ verdict: 'deny', reason: 'fence-violation' });
  });

  it('ref 不在快照闭集 → deny ref-not-in-snapshot', async () => {
    const d = await makePort().decide({
      ...base,
      params: { task: 't1', steps: [{ action: 'click', ref: 'za-99' }], summary: 'x' },
      domContext,
    });
    expect(d).toEqual({ verdict: 'deny', reason: 'ref-not-in-snapshot' });
  });

  it('契约保留但未实现的动作（waitFor）→ deny action-not-implemented', async () => {
    const d = await makePort().decide({
      ...base,
      params: { task: 't1', steps: [{ action: 'waitFor', ref: 'za-1' }], summary: 'x' },
      domContext,
    });
    expect(d).toEqual({ verdict: 'deny', reason: 'action-not-implemented:waitFor' });
  });

  it('fill 缺 value / read 缺 name / 闭集外动作 / 空批次 → 各自 deny', async () => {
    const port = makePort();
    const cases: Array<[object, string]> = [
      [{ task: 't1', steps: [{ action: 'fill', ref: 'za-1' }], summary: 'x' }, 'missing-value'],
      [{ task: 't1', steps: [{ action: 'read', ref: 'za-1' }], summary: 'x' }, 'missing-read-name'],
      [{ task: 't1', steps: [{ action: 'eval', ref: 'za-1' }], summary: 'x' }, 'unknown-action'],
      [{ task: 't1', steps: [], summary: 'x' }, 'invalid-steps'],
    ];
    for (const [params, reason] of cases) {
      const d = await port.decide({ ...base, params: params as never, domContext });
      expect(d.verdict).toBe('deny');
      expect(d.reason).toBe(reason);
    }
  });

  it('签发是治理终点：decide 被绕过时 issue 独立拒签非法批次（U7）', async () => {
    await expect(
      makePort().issueExecInstruction({
        ...base,
        params: { task: 't1', steps: [{ action: 'click', ref: 'za-99' }], summary: 'x' },
        domContext,
      }),
    ).rejects.toThrow(/ref-not-in-snapshot/);
  });

  it('dom 结果回喂走同一 resultSchema 校验：reads+completedSteps 通过、缺字段 invalid-result', async () => {
    const port = makePort();
    const instruction = await port.issueExecInstruction({ ...base, params: goodParams, domContext });
    const good: ExecResultFrame = {
      type: 'exec-result',
      sessionId: 's1',
      nonce: instruction.nonce,
      ok: true,
      body: { reads: { tokenKey: 'tok-9f' }, completedSteps: 3 },
    };
    const observation = await port.acceptExecResult({ sessionId: 's1', result: good });
    expect(observation.ok).toBe(true);
    expect(observation.content).toEqual({ reads: { tokenKey: 'tok-9f' }, completedSteps: 3 });

    const second = await port.issueExecInstruction({ ...base, params: goodParams, domContext });
    const bad: ExecResultFrame = {
      type: 'exec-result',
      sessionId: 's1',
      nonce: second.nonce,
      ok: true,
      body: { reads: {} },
    };
    const rejected = await port.acceptExecResult({ sessionId: 's1', result: bad });
    expect(rejected).toMatchObject({ ok: false, error: 'invalid-result' });
  });
});

describe('toolgate 任务级 HITL 授权（grant，一任务一确认）', () => {
  const base = { sessionId: 's1', toolCallId: 'c-g', toolId: domHitlTool.id, claims: validClaims };
  const taskParams = (task: string) => ({
    task,
    steps: [{ action: 'click', ref: 'za-1' }],
    summary: 'x',
  });

  it('缺 task → deny missing-task（授权作用域标识必填）', async () => {
    const d = await makePort().decide({
      ...base,
      params: { steps: [{ action: 'click', ref: 'za-1' }], summary: 'x' } as never,
      domContext,
    });
    expect(d).toEqual({ verdict: 'deny', reason: 'invalid-params' });
  });

  it('首批 hitl → grantHitl 后同任务后续批次 allow；不同任务仍 hitl', async () => {
    const port = makePort();
    const first = await port.decide({ ...base, params: taskParams('建令牌'), domContext });
    expect(first.verdict).toBe('hitl');

    await port.grantHitl({ sessionId: 's1', task: '建令牌' });
    const second = await port.decide({ ...base, params: taskParams('建令牌'), domContext });
    expect(second.verdict).toBe('allow');

    const other = await port.decide({ ...base, params: taskParams('删令牌'), domContext });
    expect(other.verdict).toBe('hitl');
    // 会话隔离：另一会话同任务不共享授权。
    const otherSession = await port.decide({
      ...base,
      sessionId: 's2',
      params: taskParams('建令牌'),
      domContext,
    });
    expect(otherSession.verdict).toBe('hitl');
  });

  it('授权跨工具共享：dom 工具获批后，同会话同任务的 http hitl 工具也 allow', async () => {
    const port = makePort();
    const httpBase = {
      sessionId: 's1',
      toolCallId: 'c-x',
      toolId: httpTaskHitlTool.id,
      params: { task: '建令牌', orderId: 'o-1' },
      claims: validClaims,
    };
    const before = await port.decide(httpBase);
    expect(before.verdict).toBe('hitl');
    await port.grantHitl({ sessionId: 's1', task: '建令牌' });
    const after = await port.decide(httpBase);
    expect(after.verdict).toBe('allow');
    // 同工具不同任务不共享。
    const otherTask = await port.decide({ ...httpBase, params: { task: '删令牌', orderId: 'o-1' } });
    expect(otherTask.verdict).toBe('hitl');
  });

  it('grant 不影响 forbidden 与 dom 批次校验：已授权任务的非法批次仍 deny（U7 fail-closed）', async () => {
    const port = makePort();
    await port.grantHitl({ sessionId: 's1', task: '建令牌' });
    const forbidden = await port.decide({
      sessionId: 's1',
      toolCallId: 'c-f',
      toolId: forbiddenTool.id,
      params: {},
      claims: validClaims,
    });
    expect(forbidden).toEqual({ verdict: 'deny', reason: 'forbidden' });
    const badRef = await port.decide({
      ...base,
      params: { task: '建令牌', steps: [{ action: 'click', ref: 'not-in-snapshot' }], summary: 'x' },
      domContext,
    });
    expect(badRef).toEqual({ verdict: 'deny', reason: 'ref-not-in-snapshot' });
  });

  it('滑动闲置超时后授权失效，回到 hitl', async () => {
    let clock = 1_000_000;
    const port = createToolGatePort({
      tools: allTools,
      signingSecret: SIGN_FIXTURE,
      hitlGrantTtlMs: 1000,
      now: () => clock,
    });
    await port.grantHitl({ sessionId: 's1', task: '建令牌' });
    clock += 900;
    const fresh = await port.decide({ ...base, params: taskParams('建令牌'), domContext });
    expect(fresh.verdict).toBe('allow');
    // 上次使用已续期：再过 900ms 仍在滑动窗口内。
    clock += 900;
    const slid = await port.decide({ ...base, params: taskParams('建令牌'), domContext });
    expect(slid.verdict).toBe('allow');
    clock += 1001;
    const expired = await port.decide({ ...base, params: taskParams('建令牌'), domContext });
    expect(expired.verdict).toBe('hitl');
  });

  it('exec-result=user-stopped 吊销本会话全部任务授权（停止=收回自动执行）', async () => {
    const port = makePort();
    await port.grantHitl({ sessionId: 's1', task: '建令牌' });
    await port.grantHitl({ sessionId: 's1', task: '删令牌' });
    const instruction = await port.issueExecInstruction({
      ...base,
      params: taskParams('建令牌'),
      domContext,
    });
    const stopped = await port.acceptExecResult({
      sessionId: 's1',
      result: {
        type: 'exec-result',
        sessionId: 's1',
        nonce: instruction.nonce,
        ok: false,
        error: 'user-stopped',
      },
    });
    expect(stopped).toMatchObject({ ok: false, error: 'user-stopped' });
    const after = await port.decide({ ...base, params: taskParams('建令牌'), domContext });
    expect(after.verdict).toBe('hitl');
    // 停止吊销覆盖本会话全部任务，不只被停止的那个。
    const otherTask = await port.decide({ ...base, params: taskParams('删令牌'), domContext });
    expect(otherTask.verdict).toBe('hitl');
  });
});

describe('toolgate ADR-016 有界自动履约授权', () => {
  const policy: BoundedFulfillmentPolicy = {
    id: 'seller-main-product-a',
    accountId: 'host-1',
    toolId: boundedFulfillmentTool.id,
    productIds: ['product-a'],
    validUntil: 2_000_000,
    maxCodesPerOrder: 1,
    dailyOrderLimit: 1,
  };
  const input = (orderId: string, overrides: Record<string, unknown> = {}) => ({
    sessionId: 's-bounded',
    toolCallId: `call-${orderId}`,
    toolId: boundedFulfillmentTool.id,
    params: { productId: 'product-a', orderId, codeCount: 1, ...overrides },
    claims: validClaims,
  });

  it('账号、商品、有效期、单笔数量和日限额全部命中才自动 allow', async () => {
    const port = makePort({ now: () => 1_000_000, fulfillmentPolicies: [policy] });
    await expect(port.decide(input('order-1'))).resolves.toEqual({ verdict: 'allow' });

    const wrongProduct = await makePort({ now: () => 1_000_000, fulfillmentPolicies: [policy] }).decide(
      input('order-2', { productId: 'product-b' }),
    );
    expect(wrongProduct).toEqual({ verdict: 'hitl', reason: 'bounded-policy-miss' });

    const tooMany = await makePort({ now: () => 1_000_000, fulfillmentPolicies: [policy] }).decide(
      input('order-3', { codeCount: 2 }),
    );
    expect(tooMany).toEqual({ verdict: 'hitl', reason: 'bounded-policy-miss' });

    const wrongAccount = await makePort({ now: () => 1_000_000, fulfillmentPolicies: [policy] }).decide({
      ...input('order-4'),
      claims: { ...validClaims, hostUserId: 'other-account' },
    });
    expect(wrongAccount).toEqual({ verdict: 'hitl', reason: 'bounded-policy-miss' });

    const expired = await makePort({ now: () => 2_000_001, fulfillmentPolicies: [policy] }).decide(
      input('order-5'),
    );
    expect(expired).toEqual({ verdict: 'hitl', reason: 'bounded-policy-miss' });
  });

  it('同一订单不自动重试，已完成订单同时占用每日订单额度', async () => {
    const port = makePort({ now: () => 1_000_000, fulfillmentPolicies: [policy] });
    const firstInput = input('order-1');
    expect(await port.decide(firstInput)).toEqual({ verdict: 'allow' });
    const instruction = await port.issueExecInstruction(firstInput);
    await expect(
      port.acceptExecResult({
        sessionId: firstInput.sessionId,
        result: {
          type: 'exec-result',
          sessionId: firstInput.sessionId,
          nonce: instruction.nonce,
          ok: true,
          body: { ok: true },
        },
      }),
    ).resolves.toMatchObject({ ok: true });

    await expect(port.decide({ ...input('order-1'), toolCallId: 'call-order-1-repeat' })).resolves.toEqual({
      verdict: 'hitl',
      reason: 'bounded-order-already-used',
    });
    await expect(port.decide(input('order-2'))).resolves.toEqual({
      verdict: 'hitl',
      reason: 'bounded-daily-limit',
    });
  });

  it('执行失败或回执不明确将订单标为 uncertain，禁止自动重发', async () => {
    const port = makePort({ now: () => 1_000_000, fulfillmentPolicies: [{ ...policy, dailyOrderLimit: 3 }] });
    const firstInput = input('order-ambiguous');
    expect(await port.decide(firstInput)).toEqual({ verdict: 'allow' });
    const instruction = await port.issueExecInstruction(firstInput);
    await port.acceptExecResult({
      sessionId: firstInput.sessionId,
      result: {
        type: 'exec-result',
        sessionId: firstInput.sessionId,
        nonce: instruction.nonce,
        ok: false,
        error: 'page-result-ambiguous',
      },
    });
    await expect(
      port.decide({ ...input('order-ambiguous'), toolCallId: 'call-ambiguous-repeat' }),
    ).resolves.toEqual({ verdict: 'hitl', reason: 'bounded-order-already-used' });
  });

  it('重复策略 id 或非法边界在启动期 fail-fast', () => {
    expect(() =>
      makePort({ fulfillmentPolicies: [policy, { ...policy }] }),
    ).toThrow(/有界履约策略/);
    expect(() =>
      makePort({ fulfillmentPolicies: [{ ...policy, dailyOrderLimit: 0 }] }),
    ).toThrow(/有界履约策略/);
  });
});

// ---- ADR-013 批次④：任务组治理面（per-origin 身份 / origin 围栏 / navigate / every-call / 命名空间纪律） ----

/** codeflow http 工具（相对 URL，site pack 锚定 pack origin）：per-origin 身份口径测试对象。 */
const siteHttpTool: ToolDefinition = {
  id: 'codeflow-token.create-token',
  featureIds: ['codeflow-token'],
  description: '建 key',
  params: {
    type: 'object',
    required: ['name'],
    properties: { name: { type: 'string' } },
    additionalProperties: false,
  },
  execution: 'client',
  riskTier: 'auto',
  adapter: { method: 'POST', urlTemplate: '/api/token/', headers: { 'New-Api-User': '{{hostUserId}}' } },
  resultSchema: { type: 'object', required: ['success'], properties: { success: { type: 'boolean' } } },
};

/** mail 发送工具（dom + every-call）：dom 身份豁免 + 授权不复用测试对象。 */
const siteDomSendTool: ToolDefinition = {
  id: 'mail-126.send-email',
  featureIds: ['mail-compose'],
  description: '点击发送',
  params: {
    type: 'object',
    required: ['task', 'steps', 'summary'],
    properties: { task: { type: 'string' }, steps: { type: 'array' }, summary: { type: 'string' } },
    additionalProperties: false,
  },
  execution: 'client',
  riskTier: 'hitl',
  hitlMode: 'every-call',
  adapter: { kind: 'dom', pathPrefixes: ['/'] },
  resultSchema: {
    type: 'object',
    required: ['reads', 'completedSteps'],
    properties: { reads: { type: 'object' }, completedSteps: { type: 'number' } },
  },
};

/** codeflow 页面操作工具（dom，含 navigate 能力）：navigate 围栏测试对象。 */
const siteNavTool: ToolDefinition = {
  id: 'codeflow-token.page-operate',
  featureIds: ['codeflow-token'],
  description: '页面操作/跳转',
  params: {
    type: 'object',
    required: ['task', 'steps', 'summary'],
    properties: { task: { type: 'string' }, steps: { type: 'array' }, summary: { type: 'string' } },
    additionalProperties: false,
  },
  execution: 'client',
  riskTier: 'auto',
  adapter: { kind: 'dom', pathPrefixes: ['/console'] },
  resultSchema: {
    type: 'object',
    required: ['reads', 'completedSteps'],
    properties: { reads: { type: 'object' }, completedSteps: { type: 'number' } },
  },
};

const CODEFLOW_ORIGIN = 'https://codeflow.asia';
const MAIL_ORIGIN = 'https://mail.126.com';
const siteFixtures = {
  tools: [siteHttpTool, siteDomSendTool, siteNavTool],
  sites: [
    { packId: 'codeflow-console', origin: CODEFLOW_ORIGIN, tenant: 'codeflow', locations: ['/console'] },
    { packId: 'mail-126', origin: MAIL_ORIGIN, locations: ['/'] },
  ],
  toolOwnership: [
    { packId: 'codeflow-console', toolId: siteHttpTool.id },
    { packId: 'codeflow-console', toolId: siteNavTool.id },
    { packId: 'mail-126', toolId: siteDomSendTool.id },
  ],
};

function makeSitePort(overrides?: PortOverrides) {
  return createToolGatePort({
    ...siteFixtures,
    signingSecret: SIGN_FIXTURE,
    ...(overrides?.now !== undefined ? { now: overrides.now } : {}),
  });
}

describe('toolgate ADR-013 — per-origin 身份口径（http/server 按目标 pack origin fail-closed）', () => {
  const httpBase = { sessionId: 's', toolCallId: 'c', toolId: siteHttpTool.id, params: { name: 'k' } };

  it('site pack http 工具缺目标 origin 身份 → deny，理由含「该站点身份缺失」（U7 fail-closed）', async () => {
    const d = await makeSitePort().decide({ ...httpBase, claims: validClaims, packOrigin: CODEFLOW_ORIGIN });
    expect(d.verdict).toBe('deny');
    expect(d.reason).toContain('该站点身份缺失');
    expect(d.reason).toContain(CODEFLOW_ORIGIN);
  });

  it('site pack http 工具有目标 origin 身份 → 放行', async () => {
    const d = await makeSitePort().decide({
      ...httpBase,
      claims: validClaims,
      packOrigin: CODEFLOW_ORIGIN,
      claimsForOrigin: validClaims,
    });
    expect(d.verdict).toBe('allow');
  });

  it('site pack http 工具 per-origin 身份已过期 → deny，理由含「已过期」', async () => {
    const expired = { ...validClaims, exp: 1 };
    const d = await makeSitePort().decide({
      ...httpBase,
      claims: validClaims,
      packOrigin: CODEFLOW_ORIGIN,
      claimsForOrigin: expired,
    });
    expect(d.verdict).toBe('deny');
    expect(d.reason).toContain('已过期');
  });

  it('dom 工具豁免宿主 hostUserId 要求（只需平台 JWT，网关已验签）', async () => {
    const noHost = { ...validClaims, hostUserId: '' };
    const d = await makeSitePort().decide({
      sessionId: 's',
      toolCallId: 'c',
      toolId: siteDomSendTool.id,
      params: { task: '发信', steps: [{ action: 'click', ref: 'za-1' }], summary: 'x' },
      claims: noHost,
      packOrigin: MAIL_ORIGIN,
      claimsForOrigin: noHost,
      domContext: { refs: ['za-1'], path: '/js6/main.jsp', origin: MAIL_ORIGIN },
    });
    // 身份不被拦（非 deny:identity）；send-email 为 hitl 故挂起确认。
    expect(d.verdict).toBe('hitl');
  });
});

describe('toolgate ADR-013 — dom origin 围栏（快照 origin 须 === 工具所属 pack origin）', () => {
  const sendParams = { task: '发信', steps: [{ action: 'click', ref: 'za-1' }], summary: 'x' };
  const sendBase = {
    sessionId: 's',
    toolCallId: 'c',
    toolId: siteDomSendTool.id,
    params: sendParams,
    claims: validClaims,
    packOrigin: MAIL_ORIGIN,
    claimsForOrigin: validClaims,
  };

  it('快照 origin === pack origin → 命中围栏（放行到 hitl）', async () => {
    const d = await makeSitePort().decide({
      ...sendBase,
      domContext: { refs: ['za-1'], path: '/js6/main.jsp', origin: MAIL_ORIGIN },
    });
    expect(d.verdict).toBe('hitl');
  });

  it('快照 origin !== pack origin → deny origin-fence-violation（越界）', async () => {
    const d = await makeSitePort().decide({
      ...sendBase,
      domContext: { refs: ['za-1'], path: '/js6/main.jsp', origin: 'https://evil.example' },
    });
    expect(d).toEqual({ verdict: 'deny', reason: 'origin-fence-violation' });
  });
});

describe('toolgate ADR-013 — navigate 签发（单步 / 围栏 / 免 ref）', () => {
  const navBase = {
    sessionId: 's',
    toolCallId: 'c',
    toolId: siteNavTool.id,
    claims: validClaims,
    packOrigin: CODEFLOW_ORIGIN,
    claimsForOrigin: validClaims,
    // navigate 免除 origin 围栏：当前页在 codeflow，快照 origin 与 pack 一致即可。
    domContext: { refs: [], path: '/console/token', origin: CODEFLOW_ORIGIN },
  };

  it('单步 navigate 到已安装 pack site 围栏内的 URL → 放行', async () => {
    const d = await makeSitePort().decide({
      ...navBase,
      params: { task: '去邮箱', steps: [{ action: 'navigate', url: `${MAIL_ORIGIN}/js6/main.jsp` }], summary: 'x' },
    });
    expect(d.verdict).toBe('allow');
  });

  it('navigate 与其它步混批 → deny invalid-params（navigate 单步强制）', async () => {
    const d = await makeSitePort().decide({
      ...navBase,
      params: {
        task: '去邮箱',
        steps: [{ action: 'navigate', url: `${MAIL_ORIGIN}/` }, { action: 'click', ref: 'za-1' }],
        summary: 'x',
      },
    });
    expect(d).toEqual({ verdict: 'deny', reason: 'invalid-params' });
  });

  it('navigate 目标 URL 越出所有 pack site 围栏 → deny fence-violation', async () => {
    const d = await makeSitePort().decide({
      ...navBase,
      params: { task: '去外站', steps: [{ action: 'navigate', url: 'https://evil.example/x' }], summary: 'x' },
    });
    expect(d).toEqual({ verdict: 'deny', reason: 'fence-violation' });
  });

  it('navigate 目标 origin 命中但 location 前缀越界 → deny fence-violation', async () => {
    const d = await makeSitePort().decide({
      ...navBase,
      // codeflow site locations=['/console']，/pricing 不在围栏内。
      params: { task: '去定价', steps: [{ action: 'navigate', url: `${CODEFLOW_ORIGIN}/pricing` }], summary: 'x' },
    });
    expect(d).toEqual({ verdict: 'deny', reason: 'fence-violation' });
  });

  it('navigate 缺 url → deny missing-navigate-url', async () => {
    const d = await makeSitePort().decide({
      ...navBase,
      params: { task: '去哪', steps: [{ action: 'navigate' }], summary: 'x' },
    });
    expect(d).toEqual({ verdict: 'deny', reason: 'missing-navigate-url' });
  });

  it('签发同源净化：navigate 指令只留 {action,url}（U7 治理终点重校验）', async () => {
    const instruction = await makeSitePort().issueExecInstruction({
      ...navBase,
      params: {
        task: '去邮箱',
        steps: [{ action: 'navigate', url: `${MAIL_ORIGIN}/js6/main.jsp`, ref: 'za-9', bogus: 1 }],
        summary: 'x',
      },
    });
    expect(instruction.request).toEqual({
      kind: 'dom',
      steps: [{ action: 'navigate', url: `${MAIL_ORIGIN}/js6/main.jsp` }],
    });
  });
});

describe('toolgate ADR-013 — every-call 授权不复用', () => {
  const sendBase = {
    sessionId: 's',
    toolCallId: 'c',
    toolId: siteDomSendTool.id,
    params: { task: '发信', steps: [{ action: 'click', ref: 'za-1' }], summary: 'x' },
    claims: validClaims,
    packOrigin: MAIL_ORIGIN,
    claimsForOrigin: validClaims,
    domContext: { refs: ['za-1'], path: '/js6/main.jsp', origin: MAIL_ORIGIN },
  };

  it('every-call 工具已 grant 同任务仍 hitl（不复用授权，次次单独确认）', async () => {
    const port = makeSitePort();
    const first = await port.decide(sendBase);
    expect(first.verdict).toBe('hitl');
    await port.grantHitl({ sessionId: 's', task: '发信' });
    const second = await port.decide(sendBase);
    expect(second.verdict).toBe('hitl');
  });
});

describe('toolgate ADR-013 — 内建 site_navigate 跨站导航（渐进披露第一层配套）', () => {
  const navBase = { sessionId: 's', toolCallId: 'c', toolId: SITE_NAVIGATE_TOOL_ID, claims: validClaims };
  const mailUrl = `${MAIL_ORIGIN}/js6/main.jsp`;

  it('目标在某已安装 pack 围栏内 → hitl（导航有感、单次确认）', async () => {
    const d = await makeSitePort().decide({ ...navBase, params: { url: mailUrl } });
    expect(d.verdict).toBe('hitl');
  });

  it('带 task 且该任务已获批 → allow（导航共享任务级授权）；无 task 仍 hitl', async () => {
    const port = makeSitePort();
    await port.grantHitl({ sessionId: 's', task: '发信' });
    const withTask = await port.decide({ ...navBase, params: { url: mailUrl, task: '发信' } });
    expect(withTask.verdict).toBe('allow');
    const noTask = await port.decide({ ...navBase, params: { url: mailUrl } });
    expect(noTask.verdict).toBe('hitl');
    const otherTask = await port.decide({ ...navBase, params: { url: mailUrl, task: '别的任务' } });
    expect(otherTask.verdict).toBe('hitl');
  });

  it('允许目标为别 pack 的 origin（跨站语义），只要已安装', async () => {
    const d = await makeSitePort().decide({ ...navBase, params: { url: `${CODEFLOW_ORIGIN}/console/token` } });
    expect(d.verdict).toBe('hitl');
  });

  it('目标 origin 未安装 → deny fence-violation', async () => {
    const d = await makeSitePort().decide({ ...navBase, params: { url: 'https://evil.example/x' } });
    expect(d).toEqual({ verdict: 'deny', reason: 'fence-violation' });
  });

  it('目标 origin 命中但 location 前缀越界 → deny fence-violation', async () => {
    const d = await makeSitePort().decide({ ...navBase, params: { url: `${CODEFLOW_ORIGIN}/pricing` } });
    expect(d).toEqual({ verdict: 'deny', reason: 'fence-violation' });
  });

  it('参数不过 schema（缺 url）→ deny invalid-params', async () => {
    const d = await makeSitePort().decide({ ...navBase, params: {} });
    expect(d).toEqual({ verdict: 'deny', reason: 'invalid-params' });
  });

  it('签发：构造一次性签名 navigate dom 指令，签名可同 secret 复算', async () => {
    const frame = await makeSitePort().issueExecInstruction({
      ...navBase,
      params: { url: mailUrl, reason: '去发信' },
    });
    expect(frame.request).toEqual({ kind: 'dom', steps: [{ action: 'navigate', url: mailUrl }] });
    const expected = computeExecSignature(SIGN_FIXTURE, {
      nonce: frame.nonce,
      ttl: frame.ttl,
      toolCallId: frame.toolCallId,
      request: frame.request,
    });
    expect(frame.signature).toBe(expected);
  });

  it('签发越界目标 → 抛错拒发（治理终点独立重校验，U7 fail-closed）', async () => {
    await expect(
      makeSitePort().issueExecInstruction({ ...navBase, params: { url: 'https://evil.example/x' } }),
    ).rejects.toThrow(/越出/);
  });

  it('结果回收：{url} 过 resultSchema → ok；缺 url → invalid-result（U7）', async () => {
    const port = makeSitePort();
    const okFrame = await port.issueExecInstruction({ ...navBase, params: { url: mailUrl } });
    const good = await port.acceptExecResult({
      sessionId: 's',
      result: { type: 'exec-result', sessionId: 's', nonce: okFrame.nonce, ok: true, body: { url: mailUrl } },
    });
    expect(good.ok).toBe(true);
    expect(good.content).toEqual({ url: mailUrl });

    const badFrame = await port.issueExecInstruction({ ...navBase, params: { url: mailUrl } });
    const bad = await port.acceptExecResult({
      sessionId: 's',
      result: { type: 'exec-result', sessionId: 's', nonce: badFrame.nonce, ok: true, body: {} },
    });
    expect(bad.ok).toBe(false);
    expect(bad.error).toBe('invalid-result');
  });
});

describe('toolgate ADR-013 — 命名空间纪律（跨 pack 同名 toolId 拒启）', () => {
  it('两 pack 登记同一 toolId → createToolGatePort 载入期抛错拒启', () => {
    expect(() =>
      createToolGatePort({
        tools: [siteHttpTool],
        signingSecret: SIGN_FIXTURE,
        toolOwnership: [
          { packId: 'pack-a', toolId: siteHttpTool.id },
          { packId: 'pack-b', toolId: siteHttpTool.id },
        ],
      }),
    ).toThrow(/命名空间冲突/);
  });

  it('同 pack 内重复登记同一 toolId → 不视为冲突（正常构造）', () => {
    expect(() =>
      createToolGatePort({
        tools: [siteHttpTool],
        signingSecret: SIGN_FIXTURE,
        toolOwnership: [
          { packId: 'pack-a', toolId: siteHttpTool.id },
          { packId: 'pack-a', toolId: siteHttpTool.id },
        ],
      }),
    ).not.toThrow();
  });
});
