import type {
  CardInventoryPort,
  FulfillmentCoordinatorPort,
  PrepareCardFulfillmentInput,
  PrepareCardFulfillmentResult,
  SettleCardFulfillmentInput,
  SettleCardFulfillmentResult,
  ToolGatePort,
} from '@zen-agent/contracts';

export interface FulfillmentCoordinatorOptions {
  inventory: CardInventoryPort;
  toolgate: ToolGatePort;
  guideUrl: string;
}

interface PreparedCard {
  cardId: string;
  orderId: string;
  productKey: string;
  outcome: 'sent' | 'manual' | null;
}

function deliveryMessage(orderId: string, cardSecret: string, guideUrl: string): string {
  return [
    '----',
    '您好，您购买的订单号：',
    `${orderId} 以下是给您发货的内容：`,
    '',
    `兑换码： ${cardSecret}`,
    `使用说明： ${guideUrl}`,
    '----',
  ].join('\n');
}

/**
 * 纯服务端履约编排：先飞书预占，再登记 toolgate opaque intent；卡密只在两端口之间短暂流转。
 * 本模块不认识 Chrome/DOM 执行器、不记录任何输入，也不把正文返回给调用方。
 */
export function createFulfillmentCoordinator(
  options: FulfillmentCoordinatorOptions,
): FulfillmentCoordinatorPort {
  try {
    const guide = new URL(options.guideUrl);
    if (guide.protocol !== 'https:' || guide.username !== '' || guide.password !== '') throw new Error();
  } catch {
    throw new Error('履约使用说明必须为无凭证的 HTTPS URL');
  }
  const prepared = new Map<string, PreparedCard>();
  const intentByOrder = new Map<string, string>();

  return {
    async prepare(input: PrepareCardFulfillmentInput): Promise<PrepareCardFulfillmentResult> {
      if (input.quantity !== 1) return { ok: false, error: 'unsupported-quantity' };
      const existingIntentId = intentByOrder.get(input.orderId);
      const existing = existingIntentId === undefined ? undefined : prepared.get(existingIntentId);
      if (existing !== undefined) {
        if (existing.productKey !== input.productKey) return { ok: false, error: 'manual-review' };
        if (existing.outcome === 'sent') return { ok: false, error: 'already-sent' };
        if (existing.outcome === 'manual') return { ok: false, error: 'manual-review' };
        return {
          ok: true,
          intentId: existingIntentId!,
          cardId: existing.cardId,
          reused: true,
        };
      }
      const reservation = await options.inventory.reserve({
        productKey: input.productKey,
        orderId: input.orderId,
      });
      if (!reservation.ok) return reservation;
      if (reservation.status === 'sent') return { ok: false, error: 'already-sent' };
      if (reservation.status === 'manual') return { ok: false, error: 'manual-review' };
      try {
        const registered = await options.toolgate.prepareFulfillmentIntent({
          accountId: input.accountId,
          toolId: input.toolId,
          productId: input.productId,
          orderId: input.orderId,
          quantity: input.quantity,
          pageUrl: input.pageUrl,
          pageInstanceId: input.pageInstanceId,
          messageRef: input.messageRef,
          sendRef: input.sendRef,
          message: deliveryMessage(input.orderId, reservation.cardSecret, options.guideUrl),
          receiptEvidenceId: input.receiptEvidenceId,
          receiptBaselineCount: input.receiptBaselineCount,
          receiptSuccessStatuses: input.receiptSuccessStatuses,
          expiresAt: input.expiresAt,
        });
        prepared.set(registered.intentId, {
          cardId: reservation.cardId,
          orderId: input.orderId,
          productKey: input.productKey,
          outcome: null,
        });
        intentByOrder.set(input.orderId, registered.intentId);
        return {
          ok: true,
          intentId: registered.intentId,
          cardId: reservation.cardId,
          reused: reservation.reused,
        };
      } catch {
        const cleanup = await options.inventory.settle({
          cardId: reservation.cardId,
          orderId: input.orderId,
          status: 'manual',
          note: 'intent-registration-failed',
        });
        return cleanup.ok
          ? { ok: false, error: 'intent-registration-failed' }
          : { ok: false, error: cleanup.error };
      }
    },

    async settle(input: SettleCardFulfillmentInput): Promise<SettleCardFulfillmentResult> {
      const item = prepared.get(input.intentId);
      if (item === undefined) return { ok: false, error: 'unknown-intent' };
      if (item.outcome !== null) return { ok: true };
      const result = await options.inventory.settle({
        cardId: item.cardId,
        orderId: item.orderId,
        status: input.outcome,
        ...(input.note !== undefined ? { note: input.note } : {}),
      });
      if (result.ok) item.outcome = input.outcome;
      return result;
    },
  };
}
