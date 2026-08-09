/**
 * navigate 代执行的目标页决策（插件私有，纯逻辑无 chrome 依赖）。
 * 组内已有同源标签页时复用而非新开：同 URL 仅激活、同源异 URL 原地换 URL，
 * 避免同一站点的反复导航堆出新标签页；目标 url 无法解析时一律判 create，
 * 由调用方沿用既有的新建/失败语义。
 */

import type { DownstreamFrame, ExecInstructionFrame } from './frames.js';
import { tabIdForHandle, type PageHandleTable } from './page-handles.js';

export type NavigateTarget =
  | { kind: 'activate'; tabId: number }
  | { kind: 'update'; tabId: number }
  | { kind: 'create' };

export interface NavigateCandidateTab {
  id?: number | undefined;
  url?: string | undefined;
}

export function decideNavigateTarget(
  url: string,
  groupTabs: readonly NavigateCandidateTab[],
  initiatorTabId?: number,
): NavigateTarget {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return { kind: 'create' };
  }
  let sameOriginTabId: number | null = null;
  for (const tab of groupTabs) {
    if (tab.id === undefined || tab.url === undefined) continue;
    let candidate: URL;
    try {
      candidate = new URL(tab.url);
    } catch {
      continue;
    }
    if (candidate.origin !== target.origin) continue;
    // href 比较即比较规范化后的完整 URL：完全一致的页无需重载，激活即可。
    if (candidate.href === target.href) return { kind: 'activate', tabId: tab.id };
    // 发起页不作换 URL 候选：原地重载会销毁其文档，navigate-result/exec-result 无法送达。
    if (tab.id === initiatorTabId) continue;
    if (sameOriginTabId === null) sameOriginTabId = tab.id;
  }
  return sameOriginTabId !== null ? { kind: 'update', tabId: sameOriginTabId } : { kind: 'create' };
}

export type BackgroundNavigateDecision =
  | { execute: true; frame: ExecInstructionFrame; url: string }
  | { execute: false };

/**
 * background 直执行的唯一放行形态：单步 navigate 的 dom 批次、且不带页面上下文校验字段
 * （无页可核对）。其余形状一律 null，不扩大直执行面。
 */
export function backgroundNavigableUrl(frame: ExecInstructionFrame): string | null {
  const request = frame.request;
  if (!('kind' in request)) return null;
  if (request.expectedPageUrl !== undefined || request.expectedPageInstanceId !== undefined) {
    return null;
  }
  if (request.steps.length !== 1) return null;
  const step = request.steps[0];
  if (step?.action !== 'navigate' || step.url === undefined || step.url === '') return null;
  return step.url;
}

/**
 * 组内无可投递 content 成员时，仅 backgroundNavigableUrl 放行的形态允许改由 background
 * 直接执行（静默页冷启动 open_url 的唯一通路）；其余帧维持 fail-safe 不投递。
 */
export function decideBackgroundNavigate(
  frame: DownstreamFrame,
  activeTargetCount: number,
): BackgroundNavigateDecision {
  if (activeTargetCount !== 0 || frame.type !== 'exec-instruction') return { execute: false };
  const url = backgroundNavigableUrl(frame);
  return url === null ? { execute: false } : { execute: true, frame, url };
}

export type TargetedNavigateDecision =
  | { execute: true; frame: ExecInstructionFrame; url: string; tabId: number }
  | { execute: false };

/**
 * 定向帧的 background 直执行判定：仅获签的单步 navigate 批次且句柄仍在表内才放行，
 * 落点即帧上句柄解析出的那一个 tab——不经 content 委托、不跑复用判定，禁改投（U7 粘合面）。
 */
export function decideTargetedNavigate(
  frame: DownstreamFrame,
  table: PageHandleTable,
): TargetedNavigateDecision {
  if (frame.type !== 'exec-instruction' || frame.page === undefined) return { execute: false };
  const url = backgroundNavigableUrl(frame);
  if (url === null) return { execute: false };
  const tabId = tabIdForHandle(table, frame.page);
  if (tabId === null) return { execute: false };
  return { execute: true, frame, url, tabId };
}
