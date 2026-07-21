import type {
  DomGateContext,
  IdentityClaims,
  LlmToolSpec,
  PrepareCardFulfillmentInput,
  SnapshotEvidenceRule,
  ToolDefinition,
} from '@zen-agent/contracts';

export const PREPARE_XIANYU_FULFILLMENT_TOOL_NAME = 'prepare_xianyu_fulfillment';

export const PREPARE_XIANYU_FULFILLMENT_TOOL_SPEC: LlmToolSpec = {
  name: PREPARE_XIANYU_FULFILLMENT_TOOL_NAME,
  description:
    '在闲鱼买家聊天页依据当前 URL、最近页面快照和服务端商品映射准备真实卡密履约。无业务参数；成功只返回 opaque intentId，随后只能把该 intentId 传给 xianyu-fulfillment.execute-intent。页面、商品、回执或控件证据不唯一时会拒绝。',
  params: { type: 'object', additionalProperties: false, properties: {} },
};

interface DeriveInput {
  claims: IdentityClaims;
  context: DomGateContext | null | undefined;
  boundedTools: ToolDefinition[];
  evidenceRules: SnapshotEvidenceRule[];
  productKeys: Record<string, string>;
  params: Record<string, unknown>;
  now: number;
}

/** 站点连接器只做机械证据投影；不领取库存、不做授权、不认识模型对话。 */
export function deriveXianyuFulfillmentInput(input: DeriveInput): PrepareCardFulfillmentInput | null {
  const { context } = input;
  if (
    context?.url === undefined ||
    context.pageInstanceId === undefined ||
    context.elements === undefined ||
    context.evidence === undefined ||
    input.boundedTools.length !== 1 ||
    Object.keys(input.params).length !== 0
  ) {
    return null;
  }
  try {
    const url = new URL(context.url);
    const hash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
    const queryIndex = hash.indexOf('?');
    const route = queryIndex === -1 ? hash : hash.slice(0, queryIndex);
    const query = new URLSearchParams(queryIndex === -1 ? '' : hash.slice(queryIndex + 1));
    const productId = query.get('itemId')?.trim() ?? '';
    const orderId = query.get('orderId')?.trim() ?? '';
    const productKey = input.productKeys[productId];
    const messageFields = context.elements.filter((element) => element.role === 'textarea');
    const sendButtons = context.elements.filter(
      (element) => element.role === 'button' && element.label.replace(/\s+/g, '') === '发送',
    );
    const receiptRule = input.evidenceRules.find((rule) => rule.id === 'message-receipts');
    const receipt = context.evidence['message-receipts'];
    if (
      url.origin !== 'https://seller.goofish.com' ||
      route !== '/im' ||
      productId === '' ||
      orderId === '' ||
      productKey === undefined ||
      messageFields.length !== 1 ||
      sendButtons.length !== 1 ||
      receiptRule === undefined ||
      receipt === undefined ||
      !Number.isInteger(receipt.count) ||
      receipt.count < 0 ||
      !receiptRule.statuses.includes(receipt.latest)
    ) {
      return null;
    }
    return {
      accountId: input.claims.hostUserId,
      toolId: input.boundedTools[0]!.id,
      productId,
      productKey,
      orderId,
      quantity: 1,
      pageUrl: context.url,
      pageInstanceId: context.pageInstanceId,
      messageRef: messageFields[0]!.ref,
      sendRef: sendButtons[0]!.ref,
      receiptEvidenceId: receiptRule.id,
      receiptBaselineCount: receipt.count,
      receiptSuccessStatuses: receiptRule.statuses,
      expiresAt: input.now + 45_000,
    };
  } catch {
    return null;
  }
}
