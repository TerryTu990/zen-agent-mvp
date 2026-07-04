import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const schemasDir = new URL('../schemas/', import.meta.url).pathname;
const demoConfigDir = new URL('../../../examples/host-demo/config/', import.meta.url).pathname;

const schemaFiles = readdirSync(schemasDir).filter((f) => f.endsWith('.schema.json'));

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function compile(ajv: Ajv2020, file: string) {
  addFormats(ajv);
  return ajv.compile(loadJson(join(schemasDir, file)) as object);
}

describe('C1-C5 schema 契约', () => {
  it('schemas/ 下五份契约齐备', () => {
    expect(schemaFiles.sort()).toEqual([
      'audit-event.schema.json',
      'client-access-layer.schema.json',
      'config-snapshot.schema.json',
      'identity-claims.schema.json',
      'tool-definition.schema.json',
    ]);
  });

  it.each(schemaFiles)('%s 可解析且通过 Ajv 2020-12 编译', (file) => {
    const ajv = new Ajv2020({ strict: true });
    expect(compile(ajv, file)).toBeTypeOf('function');
  });
});

describe('examples/host-demo 锚定样例过契约校验', () => {
  const manifest = loadJson(join(demoConfigDir, 'manifest.json')) as { features: string[] };

  it('manifest.json 通过 config-snapshot 校验', () => {
    const validate = compile(new Ajv2020({ strict: true }), 'config-snapshot.schema.json');
    expect(validate(manifest), JSON.stringify(validate.errors)).toBe(true);
  });

  it('manifest.features 闭单非空且覆盖 order-list 与 order-detail', () => {
    expect(manifest.features).toContain('order-list');
    expect(manifest.features).toContain('order-detail');
  });

  it.each(manifest.features)('features/%s/ 三件套齐备', (featureId) => {
    for (const file of ['feature.md', 'facts.md', 'tools.json']) {
      expect(existsSync(join(demoConfigDir, 'features', featureId, file)), `缺 ${featureId}/${file}`).toBe(
        true,
      );
    }
  });

  it.each(manifest.features)('features/%s/tools.json 为数组且逐元素通过 tool-definition 校验', (featureId) => {
    const validate = compile(new Ajv2020({ strict: true }), 'tool-definition.schema.json');
    const tools = loadJson(join(demoConfigDir, 'features', featureId, 'tools.json'));
    expect(Array.isArray(tools)).toBe(true);
    for (const tool of tools as unknown[]) {
      expect(validate(tool), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it('order-detail tools.json 空数组同样合法（零工具功能）', () => {
    const tools = loadJson(join(demoConfigDir, 'features/order-detail/tools.json'));
    expect(tools).toEqual([]);
  });
});

describe('C3 client-access-layer 消息帧', () => {
  const validate = compile(new Ajv2020({ strict: true }), 'client-access-layer.schema.json');

  const validFrames: Record<string, unknown> = {
    'context-report': {
      type: 'context-report',
      sessionId: 's-001',
      url: 'https://host.example/orders/order-list.html',
      title: '订单列表',
      featureId: 'order-list',
      snapshot: { keyword: '待发货' },
    },
    'user-message': {
      type: 'user-message',
      sessionId: 's-001',
      text: '怎么筛选待发货订单？',
    },
    'text-delta': {
      type: 'text-delta',
      sessionId: 's-001',
      delta: '在列表上方的状态筛选器中',
    },
    'guide-action highlight 含 message': {
      type: 'guide-action',
      sessionId: 's-001',
      action: 'highlight',
      selector: '#btn-export',
      message: '导出按钮在订单列表页的操作区',
    },
    'guide-action scroll-to 缺省 message': {
      type: 'guide-action',
      sessionId: 's-001',
      action: 'scroll-to',
      selector: '#btn-export',
    },
  };

  it.each(Object.keys(validFrames))('合法 %s 帧通过校验', (frameType) => {
    expect(validate(validFrames[frameType]), JSON.stringify(validate.errors)).toBe(true);
  });

  const invalidFrames: Record<string, unknown> = {
    'user-message 缺 required text': { type: 'user-message', sessionId: 's-001' },
    'context-report 缺 required url': { type: 'context-report', sessionId: 's-001' },
    '未知帧 type 被闭集拒绝': { type: 'page-reload', sessionId: 's-001' },
    'guide-action action 越 highlight|scroll-to 闭集': {
      type: 'guide-action',
      sessionId: 's-001',
      action: 'click',
      selector: '#btn-export',
    },
    'guide-action 缺 required selector': {
      type: 'guide-action',
      sessionId: 's-001',
      action: 'highlight',
    },
    'guide-action 缺 required type': {
      sessionId: 's-001',
      action: 'highlight',
      selector: '#btn-export',
    },
  };

  it.each(Object.keys(invalidFrames))('非法帧被拒：%s', (label) => {
    expect(validate(invalidFrames[label])).toBe(false);
  });
});

describe('C2 identity-claims', () => {
  const validate = compile(new Ajv2020({ strict: true }), 'identity-claims.schema.json');

  const validClaims = {
    sub: 'u-1001',
    tenant: 'default',
    roles: ['ops'],
    hostUserId: 'host-1001',
    iss: 'https://sso.host.example',
    exp: 1780000000,
  };

  it('合法 claims 通过校验', () => {
    expect(validate(validClaims), JSON.stringify(validate.errors)).toBe(true);
  });

  it.each(['exp', 'iss'] as const)('缺 required %s 的 claims 被拒', (field) => {
    const { [field]: _omitted, ...rest } = validClaims;
    expect(validate(rest)).toBe(false);
  });
});

describe('C3 client-access-layer M3 代执行 + HITL 帧', () => {
  const validate = compile(new Ajv2020({ strict: true }), 'client-access-layer.schema.json');

  const validFrames: Record<string, unknown> = {
    'hitl-request 含 params 与 reason': {
      type: 'hitl-request',
      sessionId: 's-001',
      hitlId: 'h-01',
      toolCallId: 'tc-01',
      toolId: 'order-list.cancel-order',
      params: { orderId: 'ORD-1001' },
      reason: 'riskTier=hitl 需人工确认',
    },
    'hitl-decision approve': {
      type: 'hitl-decision',
      sessionId: 's-001',
      hitlId: 'h-01',
      decision: 'approve',
    },
    'hitl-decision reject 含 comment': {
      type: 'hitl-decision',
      sessionId: 's-001',
      hitlId: 'h-01',
      decision: 'reject',
      comment: '不确定，先不取消',
    },
    'exec-instruction 含 nonce/ttl/signature/request': {
      type: 'exec-instruction',
      sessionId: 's-001',
      nonce: '11111111-2222-3333-4444-555555555555',
      ttl: 60000,
      signature: 'c2lnbmF0dXJlLWhtYWM',
      toolCallId: 'tc-01',
      request: {
        method: 'POST',
        url: '/api/orders/ORD-1001/cancel',
        headers: { 'content-type': 'application/json' },
        body: {},
      },
    },
    'exec-result ok': {
      type: 'exec-result',
      sessionId: 's-001',
      nonce: '11111111-2222-3333-4444-555555555555',
      ok: true,
      status: 200,
      body: { ok: true, orderId: 'ORD-1001' },
    },
    'exec-result 失败': {
      type: 'exec-result',
      sessionId: 's-001',
      nonce: '11111111-2222-3333-4444-555555555555',
      ok: false,
      status: 500,
      error: 'HTTP 500',
    },
    'tool-card running': {
      type: 'tool-card',
      sessionId: 's-001',
      toolCallId: 'tc-01',
      toolId: 'order-list.cancel-order',
      status: 'running',
      summary: '正在取消订单',
    },
    'tool-card succeeded': {
      type: 'tool-card',
      sessionId: 's-001',
      toolCallId: 'tc-01',
      toolId: 'order-list.cancel-order',
      status: 'succeeded',
    },
    'tool-card failed': {
      type: 'tool-card',
      sessionId: 's-001',
      toolCallId: 'tc-01',
      toolId: 'order-list.cancel-order',
      status: 'failed',
    },
  };

  it.each(Object.keys(validFrames))('合法 %s 帧通过校验', (label) => {
    expect(validate(validFrames[label]), JSON.stringify(validate.errors)).toBe(true);
  });

  const invalidFrames: Record<string, unknown> = {
    'hitl-request 缺 required params': {
      type: 'hitl-request',
      sessionId: 's-001',
      hitlId: 'h-01',
      toolId: 'order-list.cancel-order',
    },
    'hitl-decision decision 越 approve|reject 闭集': {
      type: 'hitl-decision',
      sessionId: 's-001',
      hitlId: 'h-01',
      decision: 'maybe',
    },
    'exec-instruction 缺 required signature（U7 一次性签名必含）': {
      type: 'exec-instruction',
      sessionId: 's-001',
      nonce: '11111111-2222-3333-4444-555555555555',
      ttl: 60000,
      toolCallId: 'tc-01',
      request: { method: 'POST', url: '/api/orders/ORD-1001/cancel' },
    },
    'exec-instruction request.method 越 HTTP 闭集': {
      type: 'exec-instruction',
      sessionId: 's-001',
      nonce: '11111111-2222-3333-4444-555555555555',
      ttl: 60000,
      signature: 'c2ln',
      toolCallId: 'tc-01',
      request: { method: 'TRACE', url: '/api/orders' },
    },
    'exec-result 缺 required nonce': {
      type: 'exec-result',
      sessionId: 's-001',
      ok: true,
    },
    'tool-card status 越 running|succeeded|failed 闭集': {
      type: 'tool-card',
      sessionId: 's-001',
      toolCallId: 'tc-01',
      toolId: 'order-list.cancel-order',
      status: 'pending',
    },
  };

  it.each(Object.keys(invalidFrames))('非法帧被拒：%s', (label) => {
    expect(validate(invalidFrames[label])).toBe(false);
  });
});

describe('C1 tool-definition M3 三档 riskTier', () => {
  const validate = compile(new Ajv2020({ strict: true }), 'tool-definition.schema.json');

  const validTools: Record<string, unknown> = {
    'auto refresh-orders（client GET）': {
      id: 'order-list.refresh-orders',
      featureIds: ['order-list'],
      description: '刷新当前订单列表，返回订单条数',
      params: { type: 'object', properties: {}, additionalProperties: false },
      execution: 'client',
      riskTier: 'auto',
      adapter: { method: 'GET', urlTemplate: '/api/orders' },
      resultSchema: {
        type: 'object',
        required: ['ok'],
        properties: { ok: { type: 'boolean' }, count: { type: 'number' } },
      },
    },
    'hitl cancel-order（client POST 含占位符）': {
      id: 'order-list.cancel-order',
      featureIds: ['order-list'],
      description: '取消指定订单，需用户确认',
      params: { type: 'object', required: ['orderId'], properties: { orderId: { type: 'string' } } },
      execution: 'client',
      riskTier: 'hitl',
      adapter: { method: 'POST', urlTemplate: '/api/orders/{{orderId}}/cancel' },
      resultSchema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, orderId: { type: 'string' } },
      },
    },
    'forbidden purge-orders（client DELETE）': {
      id: 'order-list.purge-orders',
      featureIds: ['order-list'],
      description: '清空所有订单——危险操作，声明其存在但永拒执行',
      params: { type: 'object', properties: {}, additionalProperties: false },
      execution: 'client',
      riskTier: 'forbidden',
      adapter: { method: 'DELETE', urlTemplate: '/api/orders' },
      resultSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
    },
  };

  it.each(Object.keys(validTools))('合法工具 %s 通过校验', (label) => {
    expect(validate(validTools[label]), JSON.stringify(validate.errors)).toBe(true);
  });

  const baseTool = validTools['auto refresh-orders（client GET）'] as Record<string, unknown>;

  const invalidTools: Record<string, unknown> = {
    'execution 越 client|server 闭集被拒': { ...baseTool, execution: 'edge' },
    'riskTier 越 auto|hitl|forbidden 闭集被拒': { ...baseTool, riskTier: 'medium' },
    'client adapter 缺 required urlTemplate 被拒': {
      ...baseTool,
      adapter: { method: 'GET' },
    },
  };

  it.each(Object.keys(invalidTools))('非法工具被拒：%s', (label) => {
    expect(validate(invalidTools[label])).toBe(false);
  });
});

describe('C5 audit-event M3 门禁/裁决/执行事件', () => {
  const validate = compile(new Ajv2020({ strict: true }), 'audit-event.schema.json');

  const base = {
    eventId: 'e-0001',
    ts: '2026-07-04T03:16:25.000Z',
    sessionId: 's-001',
    userId: 'host-1001',
    tenant: 'default',
    featureId: 'order-list',
  };

  const validEvents: Record<string, unknown> = {
    'tool-decision hitl': {
      ...base,
      type: 'tool-decision',
      data: {
        toolCallId: 'tc-01',
        toolId: 'order-list.cancel-order',
        riskTier: 'hitl',
        verdict: 'hitl',
        reason: 'riskTier=hitl',
      },
    },
    'hitl-verdict approve': {
      ...base,
      type: 'hitl-verdict',
      data: { hitlId: 'h-01', toolCallId: 'tc-01', decision: 'approve' },
    },
    'tool-execution ok': {
      ...base,
      type: 'tool-execution',
      data: {
        toolCallId: 'tc-01',
        toolId: 'order-list.cancel-order',
        execution: 'client',
        nonce: '11111111-2222-3333-4444-555555555555',
        outcome: 'ok',
        status: 200,
        durationMs: 12,
      },
    },
  };

  it.each(Object.keys(validEvents))('合法事件 %s 通过校验', (label) => {
    expect(validate(validEvents[label]), JSON.stringify(validate.errors)).toBe(true);
  });

  const invalidEvents: Record<string, unknown> = {
    'tool-decision verdict 越 allow|hitl|deny 闭集被拒': {
      ...base,
      type: 'tool-decision',
      data: { toolCallId: 'tc-01', toolId: 'order-list.cancel-order', riskTier: 'hitl', verdict: 'maybe' },
    },
    'tool-execution outcome 越闭集被拒': {
      ...base,
      type: 'tool-execution',
      data: { toolCallId: 'tc-01', toolId: 'order-list.cancel-order', execution: 'client', outcome: 'partial' },
    },
    'event type 越六段链路闭集被拒': {
      ...base,
      type: 'tool-invoke',
      data: {},
    },
  };

  it.each(Object.keys(invalidEvents))('非法事件被拒：%s', (label) => {
    expect(validate(invalidEvents[label])).toBe(false);
  });
});
