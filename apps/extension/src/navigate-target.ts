/**
 * navigate 代执行的目标页决策（插件私有，纯逻辑无 chrome 依赖）。
 * 组内已有同源标签页时复用而非新开：同 URL 仅激活、同源异 URL 原地换 URL，
 * 避免同一站点的反复导航堆出新标签页；目标 url 无法解析时一律判 create，
 * 由调用方沿用既有的新建/失败语义。
 */

import type { DownstreamFrame, ExecInstructionFrame } from './frames.js';

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
 * 组内无可投递 content 成员时，仅「单步 navigate 的 dom 批次」允许改由 background 直接执行
 * （静默页冷启动 open_url 的唯一通路）。带页面上下文校验字段的批次无页可核对，
 * 与其余帧一同维持 fail-safe 不投递，不扩大直执行面。
 */
export function decideBackgroundNavigate(
  frame: DownstreamFrame,
  activeTargetCount: number,
): BackgroundNavigateDecision {
  if (activeTargetCount !== 0 || frame.type !== 'exec-instruction') return { execute: false };
  const request = frame.request;
  if (!('kind' in request)) return { execute: false };
  if (request.expectedPageUrl !== undefined || request.expectedPageInstanceId !== undefined) {
    return { execute: false };
  }
  if (request.steps.length !== 1) return { execute: false };
  const step = request.steps[0];
  if (step?.action !== 'navigate' || step.url === undefined || step.url === '') {
    return { execute: false };
  }
  return { execute: true, frame, url: step.url };
}
