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
  deliveryBegun: boolean;
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
  let paused = false;

  return {
    async prepare(input: PrepareCardFulfillmentInput): Promise<PrepareCardFulfillmentResult> {
      if (paused) return { ok: false, error: 'fulfillment-paused' };
      if (input.quantity !== 1) return { ok: false, error: 'unsupported-quantity' };
      const orderId = input.orderId.trim();
      const productKey = input.productKey.trim();
      if (orderId === '' || productKey === '') return { ok: false, error: 'inventory-invalid-record' };
      const existingIntentId = intentByOrder.get(orderId);
      const existing = existingIntentId === undefined ? undefined : prepared.get(existingIntentId);
      if (existing !== undefined) {
        if (existing.productKey !== productKey) return { ok: false, error: 'manual-review' };
        if (existing.outcome === 'sent') return { ok: false, error: 'already-sent' };
        if (existing.outcome === 'manual') return { ok: false, error: 'manual-review' };
        return {
          ok: true,
          intentId: existingIntentId!,
        };
      }
      let reservation;
      try {
        reservation = await options.inventory.reserve({ productKey, orderId });
      } catch {
        return { ok: false, error: 'inventory-unavailable' };
      }
      if (!reservation.ok) return reservation;
      if (reservation.status === 'sent') return { ok: false, error: 'already-sent' };
      if (reservation.status === 'manual') return { ok: false, error: 'manual-review' };
      if (reservation.status !== 'reserved') return { ok: false, error: 'inventory-invalid-record' };
      try {
        const registered = await options.toolgate.prepareFulfillmentIntent({
          accountId: input.accountId,
          toolId: input.toolId,
          productId: input.productId,
          orderId,
          quantity: input.quantity,
          pageUrl: input.pageUrl,
          pageInstanceId: input.pageInstanceId,
          messageRef: input.messageRef,
          sendRef: input.sendRef,
          message: deliveryMessage(orderId, reservation.cardSecret, options.guideUrl),
          receiptEvidenceId: input.receiptEvidenceId,
          receiptBaselineCount: input.receiptBaselineCount,
          receiptSuccessStatuses: input.receiptSuccessStatuses,
          expiresAt: input.expiresAt,
        });
        prepared.set(registered.intentId, {
          cardId: reservation.cardId,
          orderId,
          productKey,
          outcome: null,
          deliveryBegun: false,
        });
        intentByOrder.set(orderId, registered.intentId);
        return {
          ok: true,
          intentId: registered.intentId,
        };
      } catch {
        const cleanup = await options.inventory.settle({
          cardId: reservation.cardId,
          orderId,
          status: 'manual',
          note: 'intent-registration-failed',
        });
        return cleanup.ok
          ? { ok: false, error: 'intent-registration-failed' }
          : { ok: false, error: cleanup.error };
      }
    },

    async beginDelivery(intentId: string): Promise<SettleCardFulfillmentResult> {
      if (paused) return { ok: false, error: 'inventory-paused' };
      const item = prepared.get(intentId);
      if (item === undefined) return { ok: false, error: 'unknown-intent' };
      if (item.outcome !== null) return { ok: false, error: 'outcome-conflict' };
      if (item.deliveryBegun) return { ok: true };
      try {
        const result = await options.inventory.beginDelivery({
          cardId: item.cardId,
          orderId: item.orderId,
        });
        if (result.ok) item.deliveryBegun = true;
        else paused = true;
        return result;
      } catch {
        paused = true;
        return { ok: false, error: 'inventory-unavailable' };
      }
    },

    async settle(input: SettleCardFulfillmentInput): Promise<SettleCardFulfillmentResult> {
      const item = prepared.get(input.intentId);
      if (item === undefined) return { ok: false, error: 'unknown-intent' };
      if (item.outcome !== null) {
        return item.outcome === input.outcome ? { ok: true } : { ok: false, error: 'outcome-conflict' };
      }
      try {
        const result = await options.inventory.settle({
          cardId: item.cardId,
          orderId: item.orderId,
          status: input.outcome,
          ...(input.note !== undefined ? { note: input.note } : {}),
        });
        if (result.ok) item.outcome = input.outcome;
        else paused = true;
        return result;
      } catch {
        paused = true;
        return { ok: false, error: 'inventory-unavailable' };
      }
    },
  };
}
