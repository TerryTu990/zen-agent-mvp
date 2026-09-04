/**
 * 快捷提问（R-5）的插件侧投影：把 GET /v1/packs（L1 声明）与 GET /v1/user-config（L2 覆盖层）
 * 合并成「本页可呈现的一份清单」，面板 chips 与右键菜单两个入口都只读这一份（一份数据两入口）。
 *
 * 客户端**不持模板副本**：本模块只保留 id / label / context / featureIds，模板留在服务端，
 * 点击时只发 quickActionId（+ 选区正文），由网关按同一份 L1/L2 查表展开。配置中心编辑用户自己的
 * L2 条目时另持其草稿（那是用户自己的内容，不是 pack 模板的副本）。
 *
 * 合并语义是服务端 quick-actions.ts 的手抄镜像（本包零 @zen-agent/* 依赖，U5）：
 * L1 → L2 全局 → L2 pack 作用域，按 id 首见者胜；停用清单取两作用域并集后整体摘除。
 * 与站点黑名单一致的不确定语义：任一来源读不出就按「本页没有快捷提问」呈现——宁可少给入口，
 * 也不呈现一条点下去会被服务端按未知 id 回退的 chip。
 */

/** 展开时需要的页面材料：selection 需选区正文（只能由右键入口带），page/none 面板即可发起。 */
export type QuickActionContext = 'selection' | 'page' | 'none';

/** 呈现用投影；刻意不含 template（客户端不持第二份模板副本）。 */
export interface QuickActionView {
  id: string;
  label: string;
  context: QuickActionContext;
  /** 缺省 = 整 pack 可见；声明时只在命中的 featureId 上呈现。 */
  featureIds?: string[];
}

/** 契约上界镜像（配置中心据此就地提示；服务端仍是权威）。 */
export const MAX_QUICK_ACTIONS_PER_SCOPE = 20;
export const QUICK_ACTION_LABEL_MAX = 40;
export const QUICK_ACTION_TEMPLATE_MAX = 2000;
/** 模板占位符闭集（契约层拒闭集外写法）：配置中心据此提示可用写法。 */
export const QUICK_ACTION_PLACEHOLDERS = ['{{selection}}', '{{url}}', '{{title}}'] as const;

const ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const CONTEXTS: QuickActionContext[] = ['selection', 'page', 'none'];

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseOne(value: unknown): QuickActionView | null {
  const record = asRecord(value);
  if (record === null) return null;
  const { id, label, context, featureIds } = record;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) return null;
  if (typeof label !== 'string' || label === '' || label.length > QUICK_ACTION_LABEL_MAX) return null;
  if (typeof context !== 'string' || !CONTEXTS.includes(context as QuickActionContext)) return null;
  const scoped = Array.isArray(featureIds)
    ? featureIds.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
    : null;
  return {
    id,
    label,
    context: context as QuickActionContext,
    ...(scoped !== null && scoped.length > 0 ? { featureIds: scoped } : {}),
  };
}

/** 任意来源（响应体 / storage 缓存）→ 合法条目清单；残缺项逐条丢弃而非整表作废。 */
export function parseQuickActions(value: unknown): QuickActionView[] {
  if (!Array.isArray(value)) return [];
  return value.map(parseOne).filter((entry): entry is QuickActionView => entry !== null);
}

function parseDisabled(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && ID_PATTERN.test(entry));
}

/** GET /v1/packs 响应 → 指定 pack 的 L1 声明；pack 未安装或未声明即空。 */
export function quickActionsFromPacks(body: unknown, packId: string | null): QuickActionView[] {
  if (packId === null) return [];
  const root = asRecord(body);
  const packs = root?.['packs'];
  if (!Array.isArray(packs)) return [];
  const pack = packs.map(asRecord).find((entry) => entry?.['packId'] === packId);
  return parseQuickActions(pack?.['quickActions']);
}

export interface OverlayQuickActions {
  /** "*" 全局作用域条目（跨站）。 */
  global: QuickActionView[];
  /** 当前 pack 作用域条目。 */
  scoped: QuickActionView[];
  /** 两作用域停用清单的并集。 */
  disabled: string[];
}

/** GET /v1/user-config 响应 → L2 两作用域的快捷提问与停用清单。 */
export function quickActionsFromUserConfig(body: unknown, packId: string | null): OverlayQuickActions {
  const overlay = asRecord(asRecord(body)?.['overlay']);
  const packs = asRecord(overlay?.['packs']);
  const globalScope = asRecord(packs?.['*']);
  const packScope = packId === null ? null : asRecord(packs?.[packId]);
  return {
    global: parseQuickActions(globalScope?.['quickActions']),
    scoped: parseQuickActions(packScope?.['quickActions']),
    disabled: [
      ...parseDisabled(globalScope?.['disabledQuickActions']),
      ...parseDisabled(packScope?.['disabledQuickActions']),
    ],
  };
}

/**
 * 合并三处声明面并摘除停用条目：与服务端展开口径同源，故 chip 上看得见的每一条点下去都能展开。
 * featureId 过滤在此一并做：声明了 featureIds 的条目只在命中的功能上呈现（缺省 = 整 pack）。
 */
export function mergeQuickActions(
  declared: readonly QuickActionView[],
  overlay: OverlayQuickActions,
  featureId: string | null,
): QuickActionView[] {
  const disabled = new Set(overlay.disabled);
  const seen = new Set<string>();
  const merged: QuickActionView[] = [];
  for (const action of [...declared, ...overlay.global, ...overlay.scoped]) {
    if (seen.has(action.id) || disabled.has(action.id)) continue;
    seen.add(action.id);
    if (action.featureIds !== undefined && (featureId === null || !action.featureIds.includes(featureId))) {
      continue;
    }
    merged.push(action);
  }
  return merged;
}

/**
 * 面板 chips 面：只呈现材料在面板侧就齐备的条目。selection 类需要页面选区，
 * 面板取不到它，硬呈现只会展开出一段空选区——那类条目的入口是右键菜单。
 */
export function panelQuickActions(actions: readonly QuickActionView[]): QuickActionView[] {
  return actions.filter((action) => action.context !== 'selection');
}

/** 右键菜单面：只有 selection 类进菜单（contexts:['selection'] 本就只在有选区时出现）。 */
export function selectionQuickActions(actions: readonly QuickActionView[]): QuickActionView[] {
  return actions.filter((action) => action.context === 'selection');
}
