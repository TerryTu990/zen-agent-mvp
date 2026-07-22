import type {
  DomGateContext,
  IdentityClaims,
  LlmToolSpec,
  PrepareCardShipmentInput,
  SnapshotEvidenceRule,
  ToolDefinition,
} from '@zen-agent/contracts';

export const PREPARE_XIANYU_SHIPPING_TOOL_NAME = 'prepare_xianyu_shipping';
export const XIANYU_SHIPPING_EXECUTE_TOOL_ID = 'xianyu-shipping.execute-intent';

export const PREPARE_XIANYU_SHIPPING_TOOL_SPEC: LlmToolSpec = {
  name: PREPARE_XIANYU_SHIPPING_TOOL_NAME,
  description:
    '在闲鱼待发货订单详情页，依据当前 URL、页面快照和服务端商品映射准备一次受控发货。无业务参数；成功只返回 opaque intentId，随后只能传给 xianyu-shipping.execute-intent。订单、商品、状态或“发货”按钮证据不唯一时会拒绝。',
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

function normalized(value: string): string {
  return value.replace(/\s+/g, '');
}

/** 只把订单详情页的闭集证据投影为可信发货输入；任一证据含糊即返回 null。 */
export function deriveXianyuShipmentInput(input: DeriveInput): PrepareCardShipmentInput | null {
  const { context } = input;
  if (
    context?.url === undefined || context.pageInstanceId === undefined || context.elements === undefined ||
    context.evidence === undefined || Object.keys(input.params).length !== 0
  ) return null;
  try {
    const url = new URL(context.url);
    const hash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
    const queryIndex = hash.indexOf('?');
    const route = queryIndex === -1 ? hash : hash.slice(0, queryIndex);
    const query = new URLSearchParams(queryIndex === -1 ? '' : hash.slice(queryIndex + 1));
    const orderId = query.get('orderId')?.trim() ?? '';
    const shippingTools = input.boundedTools.filter((tool) => tool.id === XIANYU_SHIPPING_EXECUTE_TOOL_ID);
    const itemLinks = context.elements.filter((element) => {
      if (element.href === undefined) return false;
      try {
        const itemUrl = new URL(element.href);
        return itemUrl.origin === 'https://www.goofish.com' && itemUrl.pathname === '/item' &&
          (itemUrl.searchParams.get('id')?.trim() ?? '') !== '';
      } catch {
        return false;
      }
    });
    const productIds = [...new Set(itemLinks.map((element) => new URL(element.href!).searchParams.get('id')!.trim()))];
    const productId = productIds.length === 1 ? productIds[0]! : '';
    const productKey = input.productKeys[productId];
    const orderEvidence = context.elements.filter((element) => {
      const label = normalized(element.label);
      return ['cell', 'td', 'dt', 'dd', 'span'].includes(element.role) &&
        label.includes('订单编号') && label.includes(orderId);
    });
    const actionButtons = context.elements.filter(
      (element) => element.role === 'button' && element.disabled !== true && normalized(element.label) === '发货',
    );
    const statusRule = input.evidenceRules.find((rule) => rule.id === 'order-shipment-status');
    const status = context.evidence['order-shipment-status'];
    if (
      url.origin !== 'https://seller.goofish.com' ||
      route !== '/seller-trade/order-manage/order-detail' || orderId === '' || shippingTools.length !== 1 ||
      productId === '' || productKey === undefined || itemLinks.length !== 1 || orderEvidence.length !== 1 || actionButtons.length !== 1 ||
      statusRule === undefined || status === undefined || status.count !== 1 || status.latest !== '待发货' ||
      !statusRule.statuses.includes('待发货') || !statusRule.statuses.includes('已发货')
    ) return null;
    return {
      accountId: input.claims.hostUserId,
      toolId: shippingTools[0]!.id,
      productId,
      productKey,
      orderId,
      quantity: 1,
      pageUrl: context.url,
      pageInstanceId: context.pageInstanceId,
      actionRef: actionButtons[0]!.ref,
      statusEvidenceId: statusRule.id,
      statusBaseline: '待发货',
      statusSuccessStatuses: ['已发货'],
      expiresAt: input.now + 45_000,
    };
  } catch {
    return null;
  }
}
