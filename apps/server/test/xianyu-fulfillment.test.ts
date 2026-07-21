import { describe, expect, it } from 'vitest';
import type { DomGateContext, IdentityClaims, ToolDefinition } from '@zen-agent/contracts';
import { deriveXianyuFulfillmentInput } from '../src/xianyu-fulfillment.js';

const claims: IdentityClaims = {
  sub: 'user-a',
  tenant: 'tenant-a',
  roles: ['ops'],
  hostUserId: 'seller-a',
  iss: 'issuer-a',
  exp: 2_000_000_000,
};
const boundedTool = {
  id: 'xianyu-fulfillment.execute-intent',
  authorization: { kind: 'bounded-fulfillment', intentIdParam: 'intentId' },
} as unknown as ToolDefinition;
const evidenceRules = [{
  id: 'message-receipts',
  itemSelector: '.message',
  statusSelector: '.status',
  statuses: ['未读', '已读'],
}];
const context: DomGateContext = {
  refs: ['za-message', 'za-send'],
  path: '/',
  origin: 'https://seller.goofish.com',
  url: 'https://seller.goofish.com/?site=COMMONPRO#/im?itemId=item-a&orderId=order-a&peerUserId=buyer-a',
  pageInstanceId: 'page-a',
  elements: [
    { ref: 'za-message', role: 'textarea', label: '请输入消息' },
    { ref: 'za-send', role: 'button', label: '发 送' },
  ],
  evidence: { 'message-receipts': { count: 2, latest: '已读' } },
};

function derive(overrides: Partial<Parameters<typeof deriveXianyuFulfillmentInput>[0]> = {}) {
  return deriveXianyuFulfillmentInput({
    claims,
    context,
    boundedTools: [boundedTool],
    evidenceRules,
    productKeys: { 'item-a': 'product-a' },
    params: {},
    now: 1_000_000,
    ...overrides,
  });
}

describe('闲鱼零参数履约证据投影', () => {
  it('只从 claims、URL、快照、服务端映射生成固定输入', () => {
    expect(derive()).toEqual({
      accountId: 'seller-a',
      toolId: 'xianyu-fulfillment.execute-intent',
      productId: 'item-a',
      productKey: 'product-a',
      orderId: 'order-a',
      quantity: 1,
      pageUrl: context.url,
      pageInstanceId: 'page-a',
      messageRef: 'za-message',
      sendRef: 'za-send',
      receiptEvidenceId: 'message-receipts',
      receiptBaselineCount: 2,
      receiptSuccessStatuses: ['未读', '已读'],
      expiresAt: 1_045_000,
    });
  });

  it('站外/错路由、未映射商品、额外模型参数和非法回执均 fail-closed', () => {
    expect(derive({ params: { orderId: 'model-controlled' } })).toBeNull();
    expect(derive({ productKeys: {} })).toBeNull();
    expect(derive({ context: { ...context, url: 'https://seller.goofish.com.evil.test/#/im?itemId=item-a&orderId=order-a' } })).toBeNull();
    expect(derive({ context: { ...context, url: 'https://seller.goofish.com/#/seller-data/data?itemId=item-a&orderId=order-a' } })).toBeNull();
    expect(derive({ context: { ...context, evidence: { 'message-receipts': { count: 2, latest: '发送中' } } } })).toBeNull();
  });

  it('页面生命周期、唯一输入/发送控件、唯一 bounded 工具和证据配方缺一不可', () => {
    expect(derive({ context: { ...context, pageInstanceId: undefined } })).toBeNull();
    expect(derive({ context: { ...context, elements: [...context.elements!, context.elements![0]!] } })).toBeNull();
    expect(derive({ boundedTools: [] })).toBeNull();
    expect(derive({ boundedTools: [boundedTool, boundedTool] })).toBeNull();
    expect(derive({ evidenceRules: [] })).toBeNull();
  });
});
