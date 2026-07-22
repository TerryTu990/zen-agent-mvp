import type {
  CardInventoryPort,
  FulfillmentCoordinatorPort,
  PrepareCardFulfillmentInput,
  PrepareCardShipmentInput,
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
  kind: 'shipment' | 'delivery';
  cardId: string;
  orderId: string;
  productKey: string;
  outcome: 'sent' | 'manual' | null;
  actionBegun: boolean;
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
 * 纯服务端履约编排：先由 toolgate 原子预授权，再飞书预占并登记 opaque intent；卡密只在两端口之间短暂流转。
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
  const intentByOrderAndKind = new Map<string, string>();
  let paused = false;

  return {
    async prepareShipment(input: PrepareCardShipmentInput): Promise<PrepareCardFulfillmentResult> {
      if (paused) return { ok: false, error: 'fulfillment-paused' };
      if (input.quantity !== 1) return { ok: false, error: 'unsupported-quantity' };
      const orderId = input.orderId.trim();
      const productKey = input.productKey.trim();
      if (orderId === '' || productKey === '') return { ok: false, error: 'inventory-invalid-record' };
      const workflowKey = `shipment\0${orderId}`;
      const existingIntentId = intentByOrderAndKind.get(workflowKey);
      const existing = existingIntentId === undefined ? undefined : prepared.get(existingIntentId);
      if (existing !== undefined) {
        if (existing.productKey !== productKey || existing.kind !== 'shipment') return { ok: false, error: 'manual-review' };
        if (existing.outcome === 'manual') return { ok: false, error: 'manual-review' };
        if (existing.outcome === 'sent') return { ok: false, error: 'shipment-required' };
        return { ok: true, intentId: existingIntentId! };
      }
      let authorizationId: string;
      try {
        authorizationId = (await options.toolgate.preauthorizeFulfillment({
          accountId: input.accountId, toolId: input.toolId, productId: input.productId,
          orderId, quantity: input.quantity, pageUrl: input.pageUrl, expiresAt: input.expiresAt,
        })).authorizationId;
      } catch {
        return { ok: false, error: 'authorization-denied' };
      }
      const reservation = await options.inventory.reserve({ productKey, orderId }).catch(() => null);
      if (reservation === null) {
        await options.toolgate.releaseFulfillmentAuthorization(authorizationId);
        return { ok: false, error: 'inventory-unavailable' };
      }
      if (!reservation.ok) {
        await options.toolgate.releaseFulfillmentAuthorization(authorizationId);
        return reservation;
      }
      if (reservation.status !== 'reserved' || reservation.stage !== 'reserved') {
        await options.toolgate.releaseFulfillmentAuthorization(authorizationId);
        return reservation.status === 'sent'
          ? { ok: false, error: 'already-sent' }
          : { ok: false, error: reservation.status === 'manual' ? 'manual-review' : 'shipment-required' };
      }
      try {
        const registered = await options.toolgate.prepareShipmentIntent({
          authorizationId, accountId: input.accountId, toolId: input.toolId, productId: input.productId,
          orderId, quantity: input.quantity, pageUrl: input.pageUrl, pageInstanceId: input.pageInstanceId,
          actionRef: input.actionRef, statusEvidenceId: input.statusEvidenceId,
          statusBaseline: input.statusBaseline, statusSuccessStatuses: input.statusSuccessStatuses,
          expiresAt: input.expiresAt,
        });
        prepared.set(registered.intentId, {
          kind: 'shipment', cardId: reservation.cardId, orderId, productKey,
          outcome: null, actionBegun: false,
        });
        intentByOrderAndKind.set(workflowKey, registered.intentId);
        return { ok: true, intentId: registered.intentId };
      } catch {
        await options.toolgate.releaseFulfillmentAuthorization(authorizationId);
        const cleanup = await options.inventory.settle({
          cardId: reservation.cardId, orderId, status: 'manual', note: 'shipping-intent-registration-failed',
        });
        return cleanup.ok ? { ok: false, error: 'intent-registration-failed' } : { ok: false, error: cleanup.error };
      }
    },

    async prepare(input: PrepareCardFulfillmentInput): Promise<PrepareCardFulfillmentResult> {
      if (paused) return { ok: false, error: 'fulfillment-paused' };
      if (input.quantity !== 1) return { ok: false, error: 'unsupported-quantity' };
      const orderId = input.orderId.trim();
      const productKey = input.productKey.trim();
      if (orderId === '' || productKey === '') return { ok: false, error: 'inventory-invalid-record' };
      const workflowKey = `delivery\0${orderId}`;
      const existingIntentId = intentByOrderAndKind.get(workflowKey);
      const existing = existingIntentId === undefined ? undefined : prepared.get(existingIntentId);
      if (existing !== undefined) {
        if (existing.productKey !== productKey || existing.kind !== 'delivery') return { ok: false, error: 'manual-review' };
        if (existing.outcome === 'sent') return { ok: false, error: 'already-sent' };
        if (existing.outcome === 'manual') return { ok: false, error: 'manual-review' };
        return {
          ok: true,
          intentId: existingIntentId!,
        };
      }
      let authorizationId: string;
      try {
        const authorized = await options.toolgate.preauthorizeFulfillment({
          accountId: input.accountId,
          toolId: input.toolId,
          productId: input.productId,
          orderId,
          quantity: input.quantity,
          pageUrl: input.pageUrl,
          expiresAt: input.expiresAt,
        });
        authorizationId = authorized.authorizationId;
      } catch {
        return { ok: false, error: 'authorization-denied' };
      }
      let reservation;
      try {
        reservation = await options.inventory.reserve({ productKey, orderId });
      } catch {
        await options.toolgate.releaseFulfillmentAuthorization(authorizationId);
        return { ok: false, error: 'inventory-unavailable' };
      }
      if (!reservation.ok) {
        await options.toolgate.releaseFulfillmentAuthorization(authorizationId);
        return reservation;
      }
      if (reservation.status === 'sent') {
        await options.toolgate.releaseFulfillmentAuthorization(authorizationId);
        return { ok: false, error: 'already-sent' };
      }
      if (reservation.status === 'manual') {
        await options.toolgate.releaseFulfillmentAuthorization(authorizationId);
        return { ok: false, error: 'manual-review' };
      }
      if (reservation.status !== 'reserved') {
        await options.toolgate.releaseFulfillmentAuthorization(authorizationId);
        return { ok: false, error: 'inventory-invalid-record' };
      }
      if (reservation.stage !== 'shipped-confirmed') {
        await options.toolgate.releaseFulfillmentAuthorization(authorizationId);
        return { ok: false, error: 'shipment-required' };
      }
      try {
        const registered = await options.toolgate.prepareFulfillmentIntent({
          authorizationId,
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
          kind: 'delivery',
          cardId: reservation.cardId,
          orderId,
          productKey,
          outcome: null,
          actionBegun: false,
        });
        intentByOrderAndKind.set(workflowKey, registered.intentId);
        return {
          ok: true,
          intentId: registered.intentId,
        };
      } catch {
        await options.toolgate.releaseFulfillmentAuthorization(authorizationId);
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

    async beginShipment(intentId: string): Promise<SettleCardFulfillmentResult> {
      if (paused) return { ok: false, error: 'inventory-paused' };
      const item = prepared.get(intentId);
      if (item === undefined) return { ok: false, error: 'unknown-intent' };
      if (item.kind !== 'shipment') return { ok: false, error: 'outcome-conflict' };
      if (item.outcome !== null) return { ok: false, error: 'outcome-conflict' };
      if (item.actionBegun) return { ok: true };
      try {
        const result = await options.inventory.beginShipment({
          cardId: item.cardId,
          orderId: item.orderId,
        });
        if (result.ok) item.actionBegun = true;
        else paused = true;
        return result;
      } catch {
        paused = true;
        return { ok: false, error: 'inventory-unavailable' };
      }
    },

    async confirmShipment(intentId: string): Promise<SettleCardFulfillmentResult> {
      const item = prepared.get(intentId);
      if (item === undefined) return { ok: false, error: 'unknown-intent' };
      if (item.kind === 'shipment' && item.outcome === 'sent') return { ok: true };
      if (item.kind !== 'shipment' || !item.actionBegun || item.outcome !== null) {
        return { ok: false, error: 'outcome-conflict' };
      }
      try {
        const result = await options.inventory.confirmShipment({
          cardId: item.cardId, orderId: item.orderId, confirmed: true,
        });
        if (result.ok) item.outcome = 'sent';
        else paused = true;
        return result;
      } catch {
        paused = true;
        return { ok: false, error: 'inventory-unavailable' };
      }
    },

    async beginDelivery(intentId: string): Promise<SettleCardFulfillmentResult> {
      if (paused) return { ok: false, error: 'inventory-paused' };
      const item = prepared.get(intentId);
      if (item === undefined) return { ok: false, error: 'unknown-intent' };
      if (item.kind !== 'delivery') return { ok: false, error: 'outcome-conflict' };
      if (item.outcome !== null) return { ok: false, error: 'outcome-conflict' };
      if (item.actionBegun) return { ok: true };
      try {
        const result = await options.inventory.beginDelivery({ cardId: item.cardId, orderId: item.orderId });
        if (result.ok) item.actionBegun = true;
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
        if (input.outcome === 'sent' && item.kind !== 'delivery') return { ok: false, error: 'outcome-conflict' };
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
