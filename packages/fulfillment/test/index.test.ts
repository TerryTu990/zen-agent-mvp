import { describe, expect, it, vi } from 'vitest';
import type { CardInventoryPort, ToolGatePort } from '@zen-agent/contracts';
import { createFulfillmentCoordinator } from '../src/index.js';

const input = {
  accountId: 'seller-a',
  toolId: 'xianyu-fulfillment.execute-intent',
  productId: 'item-a',
  productKey: 'product-a',
  orderId: 'order-a',
  quantity: 1,
  pageUrl: 'https://seller.goofish.com/#/im?orderId=order-a',
  pageInstanceId: 'page-a',
  messageRef: 'za-message',
  sendRef: 'za-send',
  receiptEvidenceId: 'message-receipts',
  receiptBaselineCount: 1,
  receiptSuccessStatuses: ['未读', '已读'],
  expiresAt: 2_000_000,
};

const shipmentInput = {
  accountId: 'seller-a', toolId: 'xianyu-shipping.execute-intent', productId: 'item-a',
  productKey: 'product-a', orderId: 'order-a', quantity: 1,
  pageUrl: 'https://seller.goofish.com/#/seller-trade/order-manage/order-detail?orderId=order-a',
  pageInstanceId: 'page-a', actionRef: 'za-ship', statusEvidenceId: 'order-shipment-status',
  statusBaseline: '待发货', statusSuccessStatuses: ['已发货'], expiresAt: 2_000_000,
};

const shipmentMethods = () => ({
  beginShipment: vi.fn(async () => ({ ok: true as const })),
  confirmShipment: vi.fn(async () => ({ ok: true as const })),
});

function coordinator(
  inventory: CardInventoryPort,
  prepareFulfillmentIntent = vi.fn(async () => ({ intentId: 'intent-a' })),
  preauthorizeFulfillment = vi.fn(async () => ({ authorizationId: 'authorization-a' })),
) {
  const releaseFulfillmentAuthorization = vi.fn(async () => undefined);
  const toolgate = {
    preauthorizeFulfillment,
    releaseFulfillmentAuthorization,
    prepareFulfillmentIntent,
    prepareShipmentIntent: vi.fn(async () => ({ intentId: 'shipment-intent-a' })),
  } as unknown as ToolGatePort;
  return {
    port: createFulfillmentCoordinator({
      inventory,
      toolgate,
      guideUrl: 'https://example.test/guide',
    }),
    prepareFulfillmentIntent,
    preauthorizeFulfillment,
    releaseFulfillmentAuthorization,
  };
}

describe('卡密履约编排', () => {
  it('发货先预占卡密，副作用前写 attempt，确认后才允许消息履约', async () => {
    let stage: 'reserved' | 'shipping-attempted' | 'shipped-confirmed' = 'reserved';
    const inventory: CardInventoryPort = {
      reserve: vi.fn(async () => ({
        ok: true, cardId: 'card-a', cardSecret: 'fixture-value-not-real',
        status: 'reserved', stage, reused: stage !== 'reserved',
      })),
      beginShipment: vi.fn(async () => { stage = 'shipping-attempted'; return { ok: true }; }),
      confirmShipment: vi.fn(async () => { stage = 'shipped-confirmed'; return { ok: true }; }),
      beginDelivery: vi.fn(async () => ({ ok: true })),
      settle: vi.fn(async () => ({ ok: true })),
    };
    const built = coordinator(inventory);
    await expect(built.port.prepare(input)).resolves.toEqual({ ok: false, error: 'shipment-required' });
    await expect(built.port.prepareShipment(shipmentInput)).resolves.toEqual({ ok: true, intentId: 'shipment-intent-a' });
    await expect(built.port.beginShipment('shipment-intent-a')).resolves.toEqual({ ok: true });
    await expect(built.port.confirmShipment('shipment-intent-a')).resolves.toEqual({ ok: true });
    await expect(built.port.prepare(input)).resolves.toEqual({ ok: true, intentId: 'intent-a' });
  });

  it('先预授权再预占并登记 opaque intent，返回值不含卡密；成功回执后写 sent', async () => {
    const reserve = vi.fn(async () => ({
      ok: true as const,
      cardId: 'card-a',
      cardSecret: 'fixture-value-not-real',
      status: 'reserved' as const,
      stage: 'shipped-confirmed' as const,
      reused: false,
    }));
    const settle = vi.fn(async () => ({ ok: true as const }));
    const beginDelivery = vi.fn(async () => ({ ok: true as const }));
    const built = coordinator({ reserve, beginDelivery, settle, ...shipmentMethods() });
    const prepared = await built.port.prepare(input);
    expect(prepared).toEqual({ ok: true, intentId: 'intent-a' });
    expect(JSON.stringify(prepared)).not.toContain('fixture-value-not-real');
    expect(built.prepareFulfillmentIntent).toHaveBeenCalledOnce();
    const registered = built.prepareFulfillmentIntent.mock.calls[0]![0];
    expect(registered.authorizationId).toBe('authorization-a');
    expect(registered.message).toContain('兑换码： fixture-value-not-real');
    expect(registered.message).toContain('https://example.test/guide');

    await expect(built.port.prepare(input)).resolves.toEqual({
      ok: true,
      intentId: 'intent-a',
    });
    expect(reserve).toHaveBeenCalledOnce();
    expect(built.prepareFulfillmentIntent).toHaveBeenCalledOnce();

    await expect(built.port.beginDelivery('intent-a')).resolves.toEqual({ ok: true });
    expect(beginDelivery).toHaveBeenCalledWith({ cardId: 'card-a', orderId: 'order-a' });
    await expect(built.port.settle({ intentId: 'intent-a', outcome: 'sent' })).resolves.toEqual({ ok: true });
    expect(settle).toHaveBeenCalledWith({ cardId: 'card-a', orderId: 'order-a', status: 'sent' });
  });

  it('策略预授权拒绝时不读取库存；库存失败时释放尚未使用的预授权', async () => {
    const reserve = vi.fn(async () => ({ ok: false as const, error: 'inventory-empty' as const }));
    const inventory: CardInventoryPort = {
      ...shipmentMethods(),
      reserve,
      beginDelivery: vi.fn(async () => ({ ok: true })),
      settle: vi.fn(async () => ({ ok: true })),
    };
    const denied = coordinator(
      inventory,
      undefined,
      vi.fn(async () => Promise.reject(new Error('policy denied'))),
    );
    await expect(denied.port.prepare(input)).resolves.toEqual({ ok: false, error: 'authorization-denied' });
    expect(reserve).not.toHaveBeenCalled();

    const empty = coordinator(inventory);
    await expect(empty.port.prepare(input)).resolves.toEqual({ ok: false, error: 'inventory-empty' });
    expect(empty.releaseFulfillmentAuthorization).toHaveBeenCalledWith('authorization-a');
  });

  it('已 sent/manual 不登记 intent；reserved 可恢复但不领取第二张卡', async () => {
    for (const [status, error] of [
      ['sent', 'already-sent'],
      ['manual', 'manual-review'],
    ] as const) {
      const inventory: CardInventoryPort = {
        ...shipmentMethods(),
        reserve: vi.fn(async () => ({
          ok: true,
          cardId: 'card-a',
          status,
          reused: true,
        })),
        beginDelivery: vi.fn(async () => ({ ok: true })),
        settle: vi.fn(async () => ({ ok: true })),
      };
      const built = coordinator(inventory);
      await expect(built.port.prepare(input)).resolves.toEqual({ ok: false, error });
      expect(built.prepareFulfillmentIntent).not.toHaveBeenCalled();
    }
  });

  it('库存失败不触发闲鱼 intent；intent 登记失败把已预占卡转 manual', async () => {
    const empty: CardInventoryPort = {
      ...shipmentMethods(),
      reserve: vi.fn(async () => ({ ok: false, error: 'inventory-empty' })),
      beginDelivery: vi.fn(async () => ({ ok: true })),
      settle: vi.fn(async () => ({ ok: true })),
    };
    const noStock = coordinator(empty);
    await expect(noStock.port.prepare(input)).resolves.toEqual({ ok: false, error: 'inventory-empty' });
    expect(noStock.prepareFulfillmentIntent).not.toHaveBeenCalled();

    const settle = vi.fn(async () => ({ ok: true as const }));
    const reserved: CardInventoryPort = {
      ...shipmentMethods(),
      reserve: vi.fn(async () => ({
        ok: true,
        cardId: 'card-a',
        cardSecret: 'fixture-value-not-real',
        status: 'reserved',
        stage: 'shipped-confirmed',
        reused: false,
      })),
      beginDelivery: vi.fn(async () => ({ ok: true })),
      settle,
    };
    const broken = coordinator(reserved, vi.fn(async () => Promise.reject(new Error('registration failed'))));
    await expect(broken.port.prepare(input)).resolves.toEqual({
      ok: false,
      error: 'intent-registration-failed',
    });
    expect(settle).toHaveBeenCalledWith({
      cardId: 'card-a',
      orderId: 'order-a',
      status: 'manual',
      note: 'intent-registration-failed',
    });

    const cleanupFailed = coordinator(
      {
        ...shipmentMethods(),
        reserve: reserved.reserve,
        beginDelivery: reserved.beginDelivery,
        settle: vi.fn(async () => ({ ok: false, error: 'inventory-write-failed' as const })),
      },
      vi.fn(async () => Promise.reject(new Error('registration failed'))),
    );
    await expect(cleanupFailed.port.prepare(input)).resolves.toEqual({
      ok: false,
      error: 'inventory-write-failed',
    });
  });

  it('数量越界、未知 intent 与飞书回填失败均 fail-closed', async () => {
    const inventory: CardInventoryPort = {
      ...shipmentMethods(),
      reserve: vi.fn(async () => ({
        ok: true,
        cardId: 'card-a',
        cardSecret: 'fixture-value-not-real',
        status: 'reserved',
        stage: 'shipped-confirmed',
        reused: false,
      })),
      beginDelivery: vi.fn(async () => ({ ok: true })),
      settle: vi.fn(async () => ({ ok: false, error: 'inventory-write-failed' })),
    };
    const built = coordinator(inventory);
    await expect(built.port.prepare({ ...input, quantity: 2 })).resolves.toEqual({
      ok: false,
      error: 'unsupported-quantity',
    });
    await expect(built.port.settle({ intentId: 'missing', outcome: 'manual' })).resolves.toEqual({
      ok: false,
      error: 'unknown-intent',
    });
    await built.port.prepare(input);
    await expect(built.port.beginDelivery('intent-a')).resolves.toEqual({ ok: true });
    await expect(built.port.settle({ intentId: 'intent-a', outcome: 'manual' })).resolves.toEqual({
      ok: false,
      error: 'inventory-write-failed',
    });
    await expect(built.port.prepare({ ...input, orderId: 'order-next' })).resolves.toEqual({
      ok: false,
      error: 'fulfillment-paused',
    });
  });

  it('规范化订单键并拒绝冲突终态；beginDelivery 失败后全局暂停', async () => {
    const reserve = vi.fn(async () => ({
      ok: true as const,
      cardId: 'card-a',
      cardSecret: 'fixture-value-not-real',
      status: 'reserved' as const,
      stage: 'shipped-confirmed' as const,
      reused: false,
    }));
    const inventory: CardInventoryPort = {
      ...shipmentMethods(),
      reserve,
      beginDelivery: vi.fn(async () => ({ ok: false, error: 'inventory-write-failed' as const })),
      settle: vi.fn(async () => ({ ok: true })),
    };
    const built = coordinator(inventory);
    await expect(built.port.prepare({ ...input, orderId: ' order-a ', productKey: ' product-a ' }))
      .resolves.toEqual({ ok: true, intentId: 'intent-a' });
    await expect(built.port.prepare(input)).resolves.toEqual({
      ok: true,
      intentId: 'intent-a',
    });
    expect(reserve).toHaveBeenCalledOnce();
    expect(reserve).toHaveBeenCalledWith({ orderId: 'order-a', productKey: 'product-a' });
    await expect(built.port.beginDelivery('intent-a')).resolves.toEqual({
      ok: false,
      error: 'inventory-write-failed',
    });
    await expect(built.port.prepare({ ...input, orderId: 'order-next' })).resolves.toEqual({
      ok: false,
      error: 'fulfillment-paused',
    });

    const settled = coordinator({
      ...shipmentMethods(),
      reserve,
      beginDelivery: vi.fn(async () => ({ ok: true })),
      settle: vi.fn(async () => ({ ok: true })),
    });
    await settled.port.prepare(input);
    await settled.port.beginDelivery('intent-a');
    await expect(settled.port.settle({ intentId: 'intent-a', outcome: 'sent' })).resolves.toEqual({ ok: true });
    await expect(settled.port.settle({ intentId: 'intent-a', outcome: 'manual' })).resolves.toEqual({
      ok: false,
      error: 'outcome-conflict',
    });
  });

  it('sent 回填失败后重建 coordinator，持久 attempt 仍阻止下一订单', async () => {
    let attempted = false;
    const inventory: CardInventoryPort = {
      ...shipmentMethods(),
      reserve: vi.fn(async ({ orderId }) => attempted && orderId !== 'order-a'
        ? { ok: false as const, error: 'inventory-paused' as const }
        : {
            ok: true as const,
            cardId: 'card-a',
            cardSecret: 'fixture-value-not-real',
            status: 'reserved' as const,
            stage: 'shipped-confirmed' as const,
            reused: orderId === 'order-a',
          }),
      beginDelivery: vi.fn(async () => {
        attempted = true;
        return { ok: true as const };
      }),
      settle: vi.fn(async () => ({ ok: false as const, error: 'inventory-write-failed' as const })),
    };
    const beforeRestart = coordinator(inventory);
    await beforeRestart.port.prepare(input);
    await beforeRestart.port.beginDelivery('intent-a');
    await expect(beforeRestart.port.settle({ intentId: 'intent-a', outcome: 'sent' })).resolves.toEqual({
      ok: false,
      error: 'inventory-write-failed',
    });

    const afterRestart = coordinator(inventory, vi.fn(async () => ({ intentId: 'intent-after-restart' })));
    await expect(afterRestart.port.prepare({ ...input, orderId: 'order-after-restart' })).resolves.toEqual({
      ok: false,
      error: 'inventory-paused',
    });
    expect(afterRestart.prepareFulfillmentIntent).not.toHaveBeenCalled();
  });
});
