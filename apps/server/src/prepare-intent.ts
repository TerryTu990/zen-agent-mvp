import type {
  DomGateContext,
  IdentityClaims,
  LlmToolSpec,
  PrepareCardFulfillmentInput,
  PrepareCardShipmentInput,
  SnapshotEvidenceRule,
  ToolDefinition,
} from '@zen-agent/contracts';

export const PREPARE_TOOL_NAME_PREFIX = 'prepare.';

export function prepareToolNameFor(toolId: string): string {
  return `${PREPARE_TOOL_NAME_PREFIX}${toolId}`;
}

/** 只有带 preparation 声明的 bounded-fulfillment 工具才有配套零参数 prepare 工具面（adr-019）。 */
export function prepareToolSpecFor(tool: ToolDefinition): LlmToolSpec | null {
  const preparation = tool.authorization?.preparation;
  if (tool.authorization?.kind !== 'bounded-fulfillment' || preparation === undefined) return null;
  return {
    name: prepareToolNameFor(tool.id),
    description: preparation.description,
    params: { type: 'object', additionalProperties: false, properties: {} },
  };
}

export interface DerivePreparedIntentArgs {
  claims: IdentityClaims;
  context: DomGateContext | null | undefined;
  tool: ToolDefinition;
  /** 工具所属 pack 的 site.origin；无站点围栏（如 generic pack）即 null → 拒绝准备。 */
  siteOrigin: string | null;
  evidenceRules: SnapshotEvidenceRule[];
  productKeys: Record<string, string>;
  params: Record<string, unknown>;
  now: number;
}

export type PreparedIntent =
  | { workflow: 'delivery'; input: PrepareCardFulfillmentInput }
  | { workflow: 'shipment'; input: PrepareCardShipmentInput };

function normalized(value: string): string {
  return value.replace(/\s+/g, '');
}

/**
 * 声明式证据投影引擎（adr-019 原语闭集 v1）：只从 claims、可信 URL、页面快照与服务端映射派生
 * 履约输入，不采信模型参数；任一证据缺失、不唯一或不匹配即返回 null（fail-closed），声明外形态不解释。
 */
export function derivePreparedIntent(args: DerivePreparedIntentArgs): PreparedIntent | null {
  const authorization = args.tool.authorization;
  const preparation = authorization?.preparation;
  const { context } = args;
  if (
    authorization?.kind !== 'bounded-fulfillment' ||
    preparation === undefined ||
    args.siteOrigin === null ||
    context?.url === undefined ||
    context.pageInstanceId === undefined ||
    context.elements === undefined ||
    context.evidence === undefined ||
    Object.keys(args.params).length !== 0
  ) {
    return null;
  }
  const elements = context.elements;
  try {
    const url = new URL(context.url);
    if (url.origin !== args.siteOrigin) return null;
    const hash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
    const queryIndex = hash.indexOf('?');
    const route = queryIndex === -1 ? hash : hash.slice(0, queryIndex);
    if (!preparation.routes.includes(route)) return null;
    const query = new URLSearchParams(queryIndex === -1 ? '' : hash.slice(queryIndex + 1));

    const values: Record<string, string> = {};
    for (const [name, source] of Object.entries(preparation.params)) {
      if (source.source === 'hash-query') {
        const value = query.get(source.name)?.trim() ?? '';
        if (value === '') return null;
        if (source.pattern !== undefined && !new RegExp(source.pattern).test(value)) return null;
        values[name] = value;
      } else {
        const links = elements.filter((element) => {
          if (element.href === undefined) return false;
          try {
            const href = new URL(element.href);
            const candidate = href.searchParams.get(source.queryParam)?.trim() ?? '';
            return (
              href.origin === source.urlOrigin &&
              href.username === '' &&
              href.password === '' &&
              href.pathname === source.urlPath &&
              href.hash === '' &&
              [...href.searchParams.keys()].length === 1 &&
              candidate !== '' &&
              (source.pattern === undefined || new RegExp(source.pattern).test(candidate))
            );
          } catch {
            return false;
          }
        });
        if (links.length !== 1) return null;
        values[name] = new URL(links[0]!.href!).searchParams.get(source.queryParam)!.trim();
      }
    }

    const productId = values[preparation.productParam];
    const orderId = values['orderId'];
    if (productId === undefined || orderId === undefined) return null;
    const productKey = args.productKeys[productId];
    if (productKey === undefined) return null;

    const refs: Record<string, string> = {};
    for (const [name, binding] of Object.entries(preparation.elements)) {
      const matches = elements.filter(
        (element) =>
          element.role === binding.role &&
          (binding.label === undefined || normalized(element.label) === normalized(binding.label)) &&
          (binding.requireEnabled !== true || element.disabled !== true),
      );
      if (matches.length !== 1) return null;
      refs[name] = matches[0]!.ref;
    }

    const paramEvidence = preparation.paramEvidence;
    if (paramEvidence !== undefined) {
      const target = values[paramEvidence.param];
      if (target === undefined) return null;
      const prefixes = paramEvidence.labelPrefixes ?? [];
      const matchesValue = (label: string): boolean => {
        const value = normalized(label);
        if (value === target) return true;
        return prefixes.some(
          (prefix) =>
            value === `${prefix}${target}` ||
            value === `${prefix}:${target}` ||
            value === `${prefix}：${target}`,
        );
      };
      const hits = elements.filter(
        (element) => paramEvidence.roles.includes(element.role) && matchesValue(element.label),
      );
      if (hits.length !== 1) return null;
    }

    const rule = args.evidenceRules.find((candidate) => candidate.id === preparation.evidence.rule);
    const observed = context.evidence[preparation.evidence.rule];
    if (rule === undefined || observed === undefined) return null;

    const base = {
      accountId: args.claims.hostUserId,
      toolId: args.tool.id,
      productId,
      productKey,
      orderId,
      quantity: 1,
      pageUrl: context.url,
      pageInstanceId: context.pageInstanceId,
      expiresAt: args.now + preparation.intentTtlMs,
    };
    if (authorization.workflow === 'delivery') {
      const messageRef = refs['messageRef'];
      const sendRef = refs['sendRef'];
      if (
        messageRef === undefined ||
        sendRef === undefined ||
        !Number.isInteger(observed.count) ||
        observed.count < 0 ||
        !rule.statuses.includes(observed.latest)
      ) {
        return null;
      }
      return {
        workflow: 'delivery',
        input: {
          ...base,
          messageRef,
          sendRef,
          receiptEvidenceId: rule.id,
          receiptBaselineCount: observed.count,
          receiptSuccessStatuses: rule.statuses,
        },
      };
    }
    const actionRef = refs['actionRef'];
    const { before, after } = preparation.evidence;
    if (
      actionRef === undefined ||
      before === undefined ||
      after === undefined ||
      observed.count !== 1 ||
      observed.latest !== before ||
      !rule.statuses.includes(before) ||
      !rule.statuses.includes(after)
    ) {
      return null;
    }
    return {
      workflow: 'shipment',
      input: {
        ...base,
        actionRef,
        statusEvidenceId: rule.id,
        statusBaseline: before,
        statusSuccessStatuses: [after],
      },
    };
  } catch {
    return null;
  }
}
