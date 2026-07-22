import { describe, expect, it } from 'vitest';
import type { DomGateContext, IdentityClaims, ToolDefinition } from '@zen-agent/contracts';
import {
  deriveXianyuShipmentInput,
  XIANYU_SHIPPING_EXECUTE_TOOL_ID,
} from '../src/xianyu-shipping.js';

const claims: IdentityClaims = {
  sub: 'user-a', tenant: 'tenant-a', roles: ['ops'], hostUserId: 'seller-a', iss: 'issuer-a', exp: 2_000_000_000,
};
const shippingTool = {
  id: XIANYU_SHIPPING_EXECUTE_TOOL_ID,
  authorization: { kind: 'bounded-fulfillment', intentIdParam: 'intentId' },
} as unknown as ToolDefinition;
const otherTool = { ...shippingTool, id: 'xianyu-fulfillment.execute-intent' } as ToolDefinition;
const evidenceRules = [{
  id: 'order-shipment-status', itemSelector: '.ant-steps-item',
  statusSelector: '.ant-steps-item-title', statuses: ['待发货', '已发货'],
}];
const context: DomGateContext = {
  refs: ['za-order', 'za-item', 'za-ship'], path: '/', origin: 'https://seller.goofish.com',
  url: 'https://seller.goofish.com/?site=COMMONPRO#/seller-trade/order-manage/order-detail?orderId=order-a',
  pageInstanceId: 'page-a',
  elements: [
    { ref: 'za-order', role: 'span', label: '订单编号：order-a' },
    { ref: 'za-item', role: 'link', label: '商品', href: 'https://www.goofish.com/item?id=item-a' },
    { ref: 'za-ship', role: 'button', label: '发 货' },
  ],
  evidence: { 'order-shipment-status': { count: 1, latest: '待发货' } },
};

function derive(overrides: Partial<Parameters<typeof deriveXianyuShipmentInput>[0]> = {}) {
  return deriveXianyuShipmentInput({
    claims, context, boundedTools: [shippingTool, otherTool], evidenceRules,
    productKeys: { 'item-a': 'product-a' }, params: {}, now: 1_000_000, ...overrides,
  });
}

describe('闲鱼零参数发货证据投影', () => {
  it('只从订单详情 URL、同页订单号、唯一商品链接、状态和按钮生成固定输入', () => {
    expect(derive()).toEqual({
      accountId: 'seller-a', toolId: XIANYU_SHIPPING_EXECUTE_TOOL_ID,
      productId: 'item-a', productKey: 'product-a', orderId: 'order-a', quantity: 1,
      pageUrl: context.url, pageInstanceId: 'page-a', actionRef: 'za-ship',
      statusEvidenceId: 'order-shipment-status', statusBaseline: '待发货',
      statusSuccessStatuses: ['已发货'], expiresAt: 1_045_000,
    });
  });

  it('站外、错路由、模型参数、未映射商品、非待发货状态均拒绝', () => {
    expect(derive({ params: { orderId: 'model-value' } })).toBeNull();
    expect(derive({ productKeys: {} })).toBeNull();
    expect(derive({ context: { ...context, url: 'https://seller.goofish.com.evil.test/#/seller-trade/order-manage/order-detail?orderId=order-a' } })).toBeNull();
    expect(derive({ context: { ...context, url: 'https://seller.goofish.com/#/seller-trade/order-manage?orderId=order-a' } })).toBeNull();
    expect(derive({ context: { ...context, evidence: { 'order-shipment-status': { count: 1, latest: '已发货' } } } })).toBeNull();
  });

  it('订单号、商品、发货按钮、生命周期和证据配方必须各自唯一', () => {
    expect(derive({ context: { ...context, pageInstanceId: undefined } })).toBeNull();
    expect(derive({ context: { ...context, elements: [...context.elements!, context.elements![0]!] } })).toBeNull();
    expect(derive({ context: { ...context, elements: [...context.elements!, context.elements![1]!] } })).toBeNull();
    expect(derive({ context: { ...context, elements: [...context.elements!, context.elements![2]!] } })).toBeNull();
    expect(derive({ boundedTools: [otherTool] })).toBeNull();
    expect(derive({ evidenceRules: [] })).toBeNull();
  });
});
