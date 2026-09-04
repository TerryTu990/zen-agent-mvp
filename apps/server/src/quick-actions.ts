/**
 * 快捷提问展开（R-5）：C3 user-message 只带 quickActionId，模板在服务端按 L1 站点包声明 +
 * L2 用户覆盖层查表展开为本轮用户轮消息——客户端不持第二份模板副本、不做插值。
 *
 * 边界：展开产物只进用户轮消息，MUST NOT 进 system 注入、MUST NOT 改工具面/riskTier 与任何判定
 * （U8）。占位符是闭集 {{selection}}/{{url}}/{{title}}，闭集外的写法在契约层即被拒（不存在
 * 整页正文占位——那会绕过 page-text 上限与证据规整）。
 */
import type { QuickAction, UserOverlay, UserOverlayGlobalScope, UserOverlayPackScope } from '@zen-agent/contracts';

/** 展开时可代入的页面材料；缺失项一律代入空串（不编造，不回退到别的值）。 */
export interface QuickActionMaterials {
  selectionText?: string;
  url?: string;
  title?: string;
}

export interface QuickActionExpansion {
  /** 展开后的用户轮消息；未解析出条目时 = 客户端原文。 */
  text: string;
  /** false = 该 id 在本轮 L1/L2 中查不到或已被用户停用：原文原样发起，审计据此标注。 */
  resolved: boolean;
}

const GLOBAL_SCOPE = '*';

function scopeOf(overlay: UserOverlay | null, key: string): UserOverlayGlobalScope & UserOverlayPackScope {
  return (overlay?.packs[key] ?? {}) as UserOverlayGlobalScope & UserOverlayPackScope;
}

/**
 * 本轮可见的快捷提问清单：L1 激活 pack 声明 → L2 全局作用域 → L2 该 pack 作用域，
 * 按 id 首见者胜（L1 声明对其 id 权威，用户新增须另起 id），再减去两作用域声明的停用 id。
 * packId=null（仅基座轮）时只有 L2 全局作用域可见。
 */
export function visibleQuickActions(
  packQuickActions: readonly QuickAction[],
  overlay: UserOverlay | null,
  packId: string | null,
): QuickAction[] {
  const globalScope = scopeOf(overlay, GLOBAL_SCOPE);
  const packScope = packId === null ? {} : scopeOf(overlay, packId);
  const disabled = new Set([
    ...(globalScope.disabledQuickActions ?? []),
    ...(packScope.disabledQuickActions ?? []),
  ]);
  const merged: QuickAction[] = [];
  const seen = new Set<string>();
  for (const action of [
    ...packQuickActions,
    ...(globalScope.quickActions ?? []),
    ...(packScope.quickActions ?? []),
  ]) {
    if (seen.has(action.id) || disabled.has(action.id)) continue;
    seen.add(action.id);
    merged.push(action);
  }
  return merged;
}

/** 占位符代入：闭集之外的写法在契约层已被拒，故此处只认这三个键。 */
function fillTemplate(template: string, materials: QuickActionMaterials): string {
  const values: Record<string, string> = {
    selection: materials.selectionText ?? '',
    url: materials.url ?? '',
    title: materials.title ?? '',
  };
  return template.replace(/\{\{(selection|url|title)\}\}/g, (_, key: string) => values[key] ?? '');
}

/**
 * 按 id 取模板并代入材料；查不到（未声明、已停用、或本轮 pack 不含该条）即回原文并标 resolved:false——
 * 不猜测、不静默丢弃，网关据此落审计标注（R6/R4）。
 */
export function expandQuickAction(
  actions: readonly QuickAction[],
  quickActionId: string,
  rawText: string,
  materials: QuickActionMaterials,
): QuickActionExpansion {
  const action = actions.find((candidate) => candidate.id === quickActionId);
  if (action === undefined) return { text: rawText, resolved: false };
  return { text: fillTemplate(action.template, materials), resolved: true };
}
