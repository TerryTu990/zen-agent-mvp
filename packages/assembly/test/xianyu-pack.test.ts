import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAssemblyPort } from '../src/index.js';

const repoRoot = new URL('../../../', import.meta.url).pathname;
const acceptanceRoot = join(repoRoot, 'assets');
const systemPromptPath = join(repoRoot, 'assets/system-prompt.md');

function acceptancePort() {
  return createAssemblyPort({ snapshotRoot: acceptanceRoot, systemPromptPath });
}

describe('xianyu-seller pack 装配', () => {
  const port = acceptancePort();

  it('数据总览只装配数据导航工具', async () => {
    const resolved = await port.resolveFeature({
      url: 'https://seller.goofish.com/?site=COMMONPRO#/seller-data/data',
    });
    expect(resolved).toMatchObject({ packId: 'xianyu-seller', featureId: 'xianyu-seller-data' });

    const composed = await port.compose({
      sessionId: 'xianyu-data',
      packId: 'xianyu-seller',
      featureId: 'xianyu-seller-data',
    });
    expect(composed.tools.map((tool) => tool.id)).toEqual(['xianyu-seller-data.page-operate']);
  });

  it.each([
    'https://seller.goofish.com/?site=COMMONPRO#/seller-trade/order-manage',
    'https://seller.goofish.com/?site=COMMONPRO#/seller-trade/order-manage/order-detail?orderId=masked',
  ])('订单列表与详情映射到同一个订单 feature：%s', async (url) => {
    const resolved = await port.resolveFeature({ url });
    expect(resolved).toMatchObject({ packId: 'xianyu-seller', featureId: 'xianyu-orders' });
  });

  it('订单工具只允许可见 DOM 通道且首批服务端 HITL', async () => {
    const composed = await port.compose({
      sessionId: 'xianyu-orders',
      packId: 'xianyu-seller',
      featureId: 'xianyu-orders',
    });
    expect(composed.tools).toHaveLength(1);
    expect(composed.tools[0]).toMatchObject({
      id: 'xianyu-orders.page-operate',
      execution: 'client',
      riskTier: 'hitl',
      adapter: { kind: 'dom', pathPrefixes: ['/'] },
    });
  });

  it('消息页只装配非秘密测试准备与 every-call 发送工具', async () => {
    const resolved = await port.resolveFeature({
      url: 'https://seller.goofish.com/?site=COMMONPRO#/im?itemId=masked&orderId=masked&peerUserId=masked',
    });
    expect(resolved).toMatchObject({ packId: 'xianyu-seller', featureId: 'xianyu-fulfillment' });

    const composed = await port.compose({
      sessionId: 'xianyu-fulfillment',
      packId: 'xianyu-seller',
      featureId: 'xianyu-fulfillment',
    });
    expect(composed.tools.map((tool) => tool.id)).toEqual([
      'xianyu-fulfillment.compose-test-message',
      'xianyu-fulfillment.send-test-message',
      'xianyu-fulfillment.execute-intent',
    ]);
    expect(composed.tools[0]).toMatchObject({ riskTier: 'hitl', execution: 'client' });
    expect(composed.tools[0]).toMatchObject({
      adapter: {
        snapshotEvidence: [
          {
            id: 'message-receipts',
            itemSelector: '[class*="message-content"]',
            statusSelector: '[class*="read-status-text"]',
            statuses: ['未读', '已读'],
          },
        ],
      },
    });
    expect(composed.tools[1]).toMatchObject({
      riskTier: 'hitl',
      hitlMode: 'every-call',
      execution: 'client',
    });
    expect(composed.tools[2]).toMatchObject({
      riskTier: 'hitl',
      hitlMode: 'every-call',
      execution: 'client',
      authorization: { kind: 'bounded-fulfillment', intentIdParam: 'intentId' },
      resultSchema: {
        properties: { completedSteps: { type: 'integer', const: 2 } },
      },
    });
  });

  it('闲鱼未知 hash fail-closed，不泄漏任何闲鱼工具', async () => {
    const resolved = await port.resolveFeature({
      url: 'https://seller.goofish.com/?site=COMMONPRO#/unknown',
    });
    expect(resolved).toMatchObject({ packId: 'xianyu-seller', featureId: null });

    const composed = await port.compose({
      sessionId: 'xianyu-unknown',
      packId: 'xianyu-seller',
      featureId: null,
    });
    expect(composed.tools.filter((tool) => tool.id.startsWith('xianyu-'))).toEqual([]);
  });

  it('非闲鱼 origin 不会装配闲鱼 pack', async () => {
    const resolved = await port.resolveFeature({
      url: 'https://seller.goofish.example/?site=COMMONPRO#/seller-trade/order-manage',
    });
    expect(resolved.packId).not.toBe('xianyu-seller');
  });
});
