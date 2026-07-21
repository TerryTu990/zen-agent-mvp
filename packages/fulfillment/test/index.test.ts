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

function coordinator(
  inventory: CardInventoryPort,
  prepareFulfillmentIntent = vi.fn(async () => ({ intentId: 'intent-a' })),
) {
  const toolgate = { prepareFulfillmentIntent } as unknown as ToolGatePort;
  return {
    port: createFulfillmentCoordinator({
      inventory,
      toolgate,
      guideUrl: 'https://example.test/guide',
    }),
    prepareFulfillmentIntent,
  };
}

describe('卡密履约编排', () => {
  it('先预占再登记 opaque intent，返回值不含卡密；成功回执后写 sent', async () => {
    const reserve = vi.fn(async () => ({
      ok: true as const,
      cardId: 'card-a',
      cardSecret: 'fixture-value-not-real',
      status: 'reserved' as const,
      reused: false,
    }));
    const settle = vi.fn(async () => ({ ok: true as const }));
    const built = coordinator({ reserve, settle });
    const prepared = await built.port.prepare(input);
    expect(prepared).toEqual({ ok: true, intentId: 'intent-a', cardId: 'card-a', reused: false });
    expect(JSON.stringify(prepared)).not.toContain('fixture-value-not-real');
    expect(built.prepareFulfillmentIntent).toHaveBeenCalledOnce();
    const registered = built.prepareFulfillmentIntent.mock.calls[0]![0];
    expect(registered.message).toContain('兑换码： fixture-value-not-real');
    expect(registered.message).toContain('https://example.test/guide');

    await expect(built.port.prepare(input)).resolves.toEqual({
      ok: true,
      intentId: 'intent-a',
      cardId: 'card-a',
      reused: true,
    });
    expect(reserve).toHaveBeenCalledOnce();
    expect(built.prepareFulfillmentIntent).toHaveBeenCalledOnce();

    await expect(built.port.settle({ intentId: 'intent-a', outcome: 'sent' })).resolves.toEqual({ ok: true });
    expect(settle).toHaveBeenCalledWith({ cardId: 'card-a', orderId: 'order-a', status: 'sent' });
  });

  it('已 sent/manual 不登记 intent；reserved 可恢复但不领取第二张卡', async () => {
    for (const [status, error] of [
      ['sent', 'already-sent'],
      ['manual', 'manual-review'],
    ] as const) {
      const inventory: CardInventoryPort = {
        reserve: vi.fn(async () => ({
          ok: true,
          cardId: 'card-a',
          cardSecret: 'fixture-value-not-real',
          status,
          reused: true,
        })),
        settle: vi.fn(async () => ({ ok: true })),
      };
      const built = coordinator(inventory);
      await expect(built.port.prepare(input)).resolves.toEqual({ ok: false, error });
      expect(built.prepareFulfillmentIntent).not.toHaveBeenCalled();
    }
  });

  it('库存失败不触发闲鱼 intent；intent 登记失败把已预占卡转 manual', async () => {
    const empty: CardInventoryPort = {
      reserve: vi.fn(async () => ({ ok: false, error: 'inventory-empty' })),
      settle: vi.fn(async () => ({ ok: true })),
    };
    const noStock = coordinator(empty);
    await expect(noStock.port.prepare(input)).resolves.toEqual({ ok: false, error: 'inventory-empty' });
    expect(noStock.prepareFulfillmentIntent).not.toHaveBeenCalled();

    const settle = vi.fn(async () => ({ ok: true as const }));
    const reserved: CardInventoryPort = {
      reserve: vi.fn(async () => ({
        ok: true,
        cardId: 'card-a',
        cardSecret: 'fixture-value-not-real',
        status: 'reserved',
        reused: false,
      })),
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
        reserve: reserved.reserve,
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
      reserve: vi.fn(async () => ({
        ok: true,
        cardId: 'card-a',
        cardSecret: 'fixture-value-not-real',
        status: 'reserved',
        reused: false,
      })),
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
    await expect(built.port.settle({ intentId: 'intent-a', outcome: 'manual' })).resolves.toEqual({
      ok: false,
      error: 'inventory-write-failed',
    });
  });
});
