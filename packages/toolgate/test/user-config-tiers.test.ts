import { describe, expect, it } from 'vitest';
import type { GateDecisionInput, IdentityClaims, ToolDefinition } from '@zen-agent/contracts';
import { createToolGatePort } from '../src/index.js';

// 仅测试固定值，非真实密钥（真实密钥运行时经 env 注入，ZA-C-SEC-02）。
const SIGN_FIXTURE = 'dev-fixture-value';

/**
 * adr-014 §4 TOCTOU 封口：compose 定格的 {revision, effectiveTiers} 经端口入参传入，
 * 判定 riskTier = max(静态定义值, effectiveTiers[toolId] ?? 静态值)——入参只能收紧不能放宽。
 */
type UserConfigGateInput = GateDecisionInput & {
  userConfig?: {
    revision?: string;
    degraded?: true;
    effectiveTiers: Record<string, 'auto' | 'hitl' | 'forbidden'>;
  };
};

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
  resultSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
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
  resultSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
};

function makePort() {
  return createToolGatePort({ tools: [autoTool, hitlTool], signingSecret: SIGN_FIXTURE });
}

function decideInput(
  toolId: string,
  params: Record<string, unknown>,
  effectiveTiers?: Record<string, 'auto' | 'hitl' | 'forbidden'>,
): UserConfigGateInput {
  return {
    sessionId: 's1',
    toolCallId: 'c1',
    toolId,
    params: params as never,
    claims: validClaims,
    ...(effectiveTiers !== undefined
      ? { userConfig: { revision: 'rev-fixed-1', effectiveTiers } }
      : {}),
  };
}

describe('toolgate userConfig 消费 — L2 收紧定格入参（adr-014 §4）', () => {
  it('effectiveTiers 收紧 auto→hitl → decide 返 hitl（正常）', async () => {
    const d = await makePort().decide(
      decideInput(autoTool.id, {}, { [autoTool.id]: 'hitl' }),
    );
    expect(d.verdict).toBe('hitl');
  });

  it('effectiveTiers 试图放宽 hitl→auto → 判定仍 hitl（max 钳制，异常）', async () => {
    const d = await makePort().decide(
      decideInput(hitlTool.id, { orderId: 'ORD-1' }, { [hitlTool.id]: 'auto' }),
    );
    expect(d.verdict).toBe('hitl');
  });

  it('effectiveTiers 置 forbidden → deny（disabledTools 幻觉调用仍被拒）', async () => {
    const d = await makePort().decide(
      decideInput(autoTool.id, {}, { [autoTool.id]: 'forbidden' }),
    );
    expect(d.verdict).toBe('deny');
    expect(d.reason).toBe('forbidden');
  });

  it('effectiveTiers 未含该 toolId → 按静态值（边界）', async () => {
    const d = await makePort().decide(
      decideInput(autoTool.id, {}, { 'other.tool': 'forbidden' }),
    );
    expect(d.verdict).toBe('allow');
  });

  it('未提供 userConfig → 按静态值（回归锚）', async () => {
    const port = makePort();
    const auto = await port.decide(decideInput(autoTool.id, {}));
    expect(auto.verdict).toBe('allow');
    const hitl = await port.decide(decideInput(hitlTool.id, { orderId: 'ORD-1' }));
    expect(hitl.verdict).toBe('hitl');
  });

  it('degraded 降级轮的 forbidden 拒绝理由可区分（R6：因存储故障临时禁用而非用户配置）', async () => {
    const input = decideInput(autoTool.id, {}, { [autoTool.id]: 'forbidden' });
    input.userConfig = { degraded: true, effectiveTiers: { [autoTool.id]: 'forbidden' } };
    const d = await makePort().decide(input);
    expect(d.verdict).toBe('deny');
    expect(d.reason).toBe('user-config-unavailable');
  });

  it('静态本就 forbidden 的工具在 degraded 轮仍报 forbidden（非存储故障所致）', async () => {
    const forbiddenTool: ToolDefinition = {
      ...autoTool,
      id: 'order-list.purge-orders',
      riskTier: 'forbidden',
    };
    const port = createToolGatePort({ tools: [forbiddenTool], signingSecret: SIGN_FIXTURE });
    const input = decideInput(forbiddenTool.id, {});
    input.userConfig = { degraded: true, effectiveTiers: { [forbiddenTool.id]: 'forbidden' } };
    const d = await port.decide(input);
    expect(d.verdict).toBe('deny');
    expect(d.reason).toBe('forbidden');
  });

  it('签发是治理终点：issueExecInstruction 对 L2 置 forbidden 的工具独立重校验拒签（U7）', async () => {
    const input = decideInput(autoTool.id, {}, { [autoTool.id]: 'forbidden' });
    await expect(makePort().issueExecInstruction(input)).rejects.toThrow();
  });

  it('executeServer 对 L2 置 forbidden 的 server 工具拒执行（U7 同口径）', async () => {
    const serverTool: ToolDefinition = {
      id: 'order-list.export-report',
      featureIds: ['order-list'],
      description: '导出报表',
      params: { type: 'object', properties: {}, additionalProperties: false },
      execution: 'server',
      riskTier: 'auto',
      adapter: { method: 'GET', urlTemplate: 'https://api.example.com/report' },
      resultSchema: { type: 'object' },
    };
    const port = createToolGatePort({ tools: [serverTool], signingSecret: SIGN_FIXTURE });
    const input = decideInput(serverTool.id, {}, { [serverTool.id]: 'forbidden' });
    const observation = await port.executeServer(input);
    expect(observation.ok).toBe(false);
  });
});
