/**
 * navigate 代执行的目标页决策（插件私有，纯逻辑无 chrome 依赖）。
 * 组内可复用的标签页优先于新开，优先级：同 URL 仅激活 > 同源异 URL 原地换 URL >
 * 空白页原地换 URL；空白页无内容可保留，复用它避免组里留下一个废弃空白页。
 * 目标 url 无法解析时一律判 create，由调用方沿用既有的新建/失败语义。
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

/** 浏览器新标签页/空文档的闭集；未列入的一律不算空白，宁可多开一页也不换掉有内容的页。 */
const BLANK_PAGE_URLS = new Set([
  'about:blank',
  'chrome://newtab/',
  'chrome://new-tab-page/',
  'edge://newtab/',
]);

/**
 * url 缺省或为空串不算空白：那是首次导航尚未提交的 tab（真实目标在 pendingUrl），
 * 把它当空白页原地换掉会静默丢弃上一次已回喂成功的导航。
 */
export function isBlankPageUrl(url: string | undefined): boolean {
  return url !== undefined && BLANK_PAGE_URLS.has(url);
}

function parseUrl(url: string | undefined): URL | null {
  if (url === undefined) return null;
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

export function decideNavigateTarget(
  url: string,
  groupTabs: readonly NavigateCandidateTab[],
  initiatorTabId?: number,
): NavigateTarget {
  const target = parseUrl(url);
  if (target === null) return { kind: 'create' };
  let sameOriginTabId: number | null = null;
  let blankTabId: number | null = null;
  for (const tab of groupTabs) {
    if (tab.id === undefined) continue;
    const candidate = parseUrl(tab.url);
    // href 比较即比较规范化后的完整 URL：完全一致的页无需重载，激活即可。
    if (candidate !== null && candidate.href === target.href) {
      return { kind: 'activate', tabId: tab.id };
    }
    // 发起页不作换 URL 候选：原地重载会销毁其文档，navigate-result/exec-result 无法送达。
    if (tab.id === initiatorTabId) continue;
    if (candidate !== null && candidate.origin === target.origin) {
      if (sameOriginTabId === null) sameOriginTabId = tab.id;
      continue;
    }
    if (blankTabId === null && isBlankPageUrl(tab.url)) blankTabId = tab.id;
  }
  const reusableTabId = sameOriginTabId ?? blankTabId;
  return reusableTabId !== null ? { kind: 'update', tabId: reusableTabId } : { kind: 'create' };
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
