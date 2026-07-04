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
    required: ['steps', 'summary'],
    properties: { steps: { type: 'array' }, summary: { type: 'string' } },
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
];

interface PortOverrides {
  ttlMs?: number;
  now?: () => number;
  resolveCredential?: (ref: string) => string | undefined;
  fetchImpl?: typeof fetch;
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
      params: { steps: [{ action: 'click', ref: 'za-99' }], summary: 'x' },
      domContext,
    });
    expect(d).toEqual({ verdict: 'deny', reason: 'ref-not-in-snapshot' });
  });

  it('契约保留但未实现的动作（navigate/waitFor）→ deny action-not-implemented（锚点 ②-b）', async () => {
    const d = await makePort().decide({
      ...base,
      params: { steps: [{ action: 'navigate', ref: 'za-1', to: '/console/token' }], summary: 'x' },
      domContext,
    });
    expect(d).toEqual({ verdict: 'deny', reason: 'action-not-implemented:navigate' });
  });

  it('fill 缺 value / read 缺 name / 闭集外动作 / 空批次 → 各自 deny', async () => {
    const port = makePort();
    const cases: Array<[object, string]> = [
      [{ steps: [{ action: 'fill', ref: 'za-1' }], summary: 'x' }, 'missing-value'],
      [{ steps: [{ action: 'read', ref: 'za-1' }], summary: 'x' }, 'missing-read-name'],
      [{ steps: [{ action: 'eval', ref: 'za-1' }], summary: 'x' }, 'unknown-action'],
      [{ steps: [], summary: 'x' }, 'invalid-steps'],
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
        params: { steps: [{ action: 'click', ref: 'za-99' }], summary: 'x' },
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
