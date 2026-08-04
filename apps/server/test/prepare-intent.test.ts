import { describe, expect, it } from 'vitest';
import type { DomGateContext, IdentityClaims, ToolDefinition } from '@zen-agent/contracts';
import { derivePreparedIntent, prepareToolNameFor, prepareToolSpecFor } from '../src/prepare-intent.js';

const claims: IdentityClaims = {
  sub: 'user-a',
  tenant: 'tenant-a',
  roles: ['ops'],
  hostUserId: 'seller-a',
  iss: 'issuer-a',
  exp: 2_000_000_000,
};

const deliveryTool = {
  id: 'xianyu-fulfillment.execute-intent',
  authorization: {
    kind: 'bounded-fulfillment',
    workflow: 'delivery',
    intentIdParam: 'intentId',
    preparation: {
      description: '准备一次卡密履约',
      routes: ['/im'],
      params: {
        productId: { source: 'hash-query', name: 'itemId' },
        orderId: { source: 'hash-query', name: 'orderId' },
      },
      productParam: 'productId',
      elements: {
        messageRef: { role: 'textarea' },
        sendRef: { role: 'button', label: '发送' },
      },
      evidence: { rule: 'message-receipts' },
      intentTtlMs: 45_000,
    },
  },
} as unknown as ToolDefinition;

const deliveryRules = [
  { id: 'message-receipts', itemSelector: '.message', statusSelector: '.status', statuses: ['未读', '已读'] },
];

const deliveryContext: DomGateContext = {
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

function deriveDelivery(overrides: Partial<Parameters<typeof derivePreparedIntent>[0]> = {}) {
  return derivePreparedIntent({
    claims,
    context: deliveryContext,
    tool: deliveryTool,
    siteOrigin: 'https://seller.goofish.com',
    evidenceRules: deliveryRules,
    productKeys: { 'item-a': 'product-a' },
    params: {},
    now: 1_000_000,
    ...overrides,
  });
}

describe('声明式 delivery 证据投影（原 xianyu 履约连接器行为等价）', () => {
  it('只从 claims、URL、快照、服务端映射生成固定输入', () => {
    expect(deriveDelivery()).toEqual({
      workflow: 'delivery',
      input: {
        accountId: 'seller-a',
        toolId: 'xianyu-fulfillment.execute-intent',
        productId: 'item-a',
        productKey: 'product-a',
        orderId: 'order-a',
        quantity: 1,
        pageUrl: deliveryContext.url,
        pageInstanceId: 'page-a',
        messageRef: 'za-message',
        sendRef: 'za-send',
        receiptEvidenceId: 'message-receipts',
        receiptBaselineCount: 2,
        receiptSuccessStatuses: ['未读', '已读'],
        expiresAt: 1_045_000,
      },
    });
  });

  it('站外/错路由、未映射商品、额外模型参数和非法回执均 fail-closed', () => {
    expect(deriveDelivery({ params: { orderId: 'model-controlled' } })).toBeNull();
    expect(deriveDelivery({ productKeys: {} })).toBeNull();
    expect(
      deriveDelivery({
        context: {
          ...deliveryContext,
          url: 'https://seller.goofish.com.evil.test/#/im?itemId=item-a&orderId=order-a',
        },
      }),
    ).toBeNull();
    expect(
      deriveDelivery({
        context: {
          ...deliveryContext,
          url: 'https://seller.goofish.com/#/seller-data/data?itemId=item-a&orderId=order-a',
        },
      }),
    ).toBeNull();
    expect(
      deriveDelivery({
        context: { ...deliveryContext, evidence: { 'message-receipts': { count: 2, latest: '发送中' } } },
      }),
    ).toBeNull();
  });

  it('页面生命周期、唯一控件、站点围栏与证据配方缺一不可', () => {
    expect(deriveDelivery({ context: { ...deliveryContext, pageInstanceId: undefined } })).toBeNull();
    expect(
      deriveDelivery({
        context: {
          ...deliveryContext,
          elements: [...deliveryContext.elements!, deliveryContext.elements![0]!],
        },
      }),
    ).toBeNull();
    expect(deriveDelivery({ siteOrigin: null })).toBeNull();
    expect(deriveDelivery({ evidenceRules: [] })).toBeNull();
    expect(deriveDelivery({ tool: { ...deliveryTool, authorization: undefined } as ToolDefinition })).toBeNull();
  });
});

const shipmentTool = {
  id: 'xianyu-shipping.execute-intent',
  authorization: {
    kind: 'bounded-fulfillment',
    workflow: 'shipment',
    intentIdParam: 'intentId',
    preparation: {
      description: '准备一次受控发货',
      routes: ['/seller-trade/order-manage/order-detail'],
      params: {
        orderId: { source: 'hash-query', name: 'orderId', pattern: '^[A-Za-z0-9_-]{1,128}$' },
        productId: {
          source: 'element-href',
          urlOrigin: 'https://www.goofish.com',
          urlPath: '/item',
          queryParam: 'id',
          pattern: '^[A-Za-z0-9_-]{1,128}$',
        },
      },
      productParam: 'productId',
      elements: { actionRef: { role: 'button', label: '发货', requireEnabled: true } },
      paramEvidence: {
        param: 'orderId',
        roles: ['cell', 'td', 'dt', 'dd', 'span'],
        labelPrefixes: ['订单编号'],
      },
      evidence: { rule: 'order-shipment-status', before: '待发货', after: '已发货' },
      intentTtlMs: 45_000,
    },
  },
} as unknown as ToolDefinition;

const shipmentRules = [
  {
    id: 'order-shipment-status',
    itemSelector: '.ant-steps-item',
    statusSelector: '.ant-steps-item-title',
    statuses: ['待发货', '已发货'],
  },
];

const shipmentContext: DomGateContext = {
  refs: ['za-order', 'za-item', 'za-ship'],
  path: '/',
  origin: 'https://seller.goofish.com',
  url: 'https://seller.goofish.com/?site=COMMONPRO#/seller-trade/order-manage/order-detail?orderId=order-a',
  pageInstanceId: 'page-a',
  elements: [
    { ref: 'za-order', role: 'span', label: '订单编号：order-a' },
    { ref: 'za-item', role: 'link', label: '商品', href: 'https://www.goofish.com/item?id=item-a' },
    { ref: 'za-ship', role: 'button', label: '发 货' },
  ],
  evidence: { 'order-shipment-status': { count: 1, latest: '待发货' } },
};

function deriveShipment(overrides: Partial<Parameters<typeof derivePreparedIntent>[0]> = {}) {
  return derivePreparedIntent({
    claims,
    context: shipmentContext,
    tool: shipmentTool,
    siteOrigin: 'https://seller.goofish.com',
    evidenceRules: shipmentRules,
    productKeys: { 'item-a': 'product-a' },
    params: {},
    now: 1_000_000,
    ...overrides,
  });
}

describe('声明式 shipment 证据投影（原 xianyu 发货连接器行为等价）', () => {
  it('只从订单详情 URL、同页订单号、唯一商品链接、状态和按钮生成固定输入', () => {
    expect(deriveShipment()).toEqual({
      workflow: 'shipment',
      input: {
        accountId: 'seller-a',
        toolId: 'xianyu-shipping.execute-intent',
        productId: 'item-a',
        productKey: 'product-a',
        orderId: 'order-a',
        quantity: 1,
        pageUrl: shipmentContext.url,
        pageInstanceId: 'page-a',
        actionRef: 'za-ship',
        statusEvidenceId: 'order-shipment-status',
        statusBaseline: '待发货',
        statusSuccessStatuses: ['已发货'],
        expiresAt: 1_045_000,
      },
    });
  });

  it('站外、错路由、模型参数、未映射商品、非待发货状态均拒绝', () => {
    expect(deriveShipment({ params: { orderId: 'model-value' } })).toBeNull();
    expect(deriveShipment({ productKeys: {} })).toBeNull();
    expect(
      deriveShipment({
        context: {
          ...shipmentContext,
          url: 'https://seller.goofish.com.evil.test/#/seller-trade/order-manage/order-detail?orderId=order-a',
        },
      }),
    ).toBeNull();
    expect(
      deriveShipment({
        context: {
          ...shipmentContext,
          url: 'https://seller.goofish.com/#/seller-trade/order-manage?orderId=order-a',
        },
      }),
    ).toBeNull();
    expect(
      deriveShipment({
        context: {
          ...shipmentContext,
          evidence: { 'order-shipment-status': { count: 1, latest: '已发货' } },
        },
      }),
    ).toBeNull();
  });

  it('订单号、商品、发货按钮、生命周期和证据配方必须各自唯一', () => {
    expect(deriveShipment({ context: { ...shipmentContext, pageInstanceId: undefined } })).toBeNull();
    for (const index of [0, 1, 2]) {
      expect(
        deriveShipment({
          context: {
            ...shipmentContext,
            elements: [...shipmentContext.elements!, shipmentContext.elements![index]!],
          },
        }),
      ).toBeNull();
    }
    expect(deriveShipment({ evidenceRules: [] })).toBeNull();
    expect(
      deriveShipment({
        context: { ...shipmentContext, url: shipmentContext.url!.replace('order-a', 'order') },
      }),
    ).toBeNull();
    expect(
      deriveShipment({
        context: {
          ...shipmentContext,
          elements: shipmentContext.elements!.map((element) =>
            element.ref === 'za-order' ? { ...element, label: '订单编号：prefix-order-a-suffix' } : element,
          ),
        },
      }),
    ).toBeNull();
    expect(
      deriveShipment({
        context: {
          ...shipmentContext,
          elements: shipmentContext.elements!.map((element) =>
            element.ref === 'za-item' ? { ...element, href: `${element.href}&token=query-canary` } : element,
          ),
        },
      }),
    ).toBeNull();
  });

  it('禁用发货按钮被 requireEnabled 拒绝', () => {
    expect(
      deriveShipment({
        context: {
          ...shipmentContext,
          elements: shipmentContext.elements!.map((element) =>
            element.ref === 'za-ship' ? { ...element, disabled: true } : element,
          ),
        },
      }),
    ).toBeNull();
  });
});

describe('prepare 工具面派生', () => {
  it('带 preparation 的工具派生 prepare.<toolId> 零参数工具面', () => {
    expect(prepareToolSpecFor(deliveryTool)).toEqual({
      name: 'prepare.xianyu-fulfillment.execute-intent',
      description: '准备一次卡密履约',
      params: { type: 'object', additionalProperties: false, properties: {} },
    });
    expect(prepareToolNameFor('a.b')).toBe('prepare.a.b');
  });

  it('无 preparation 声明不产生工具面', () => {
    expect(prepareToolSpecFor({ ...deliveryTool, authorization: undefined } as ToolDefinition)).toBeNull();
    expect(
      prepareToolSpecFor({
        ...deliveryTool,
        authorization: { kind: 'bounded-fulfillment', workflow: 'delivery', intentIdParam: 'intentId' },
      } as ToolDefinition),
    ).toBeNull();
  });
});
