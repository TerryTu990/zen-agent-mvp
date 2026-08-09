/**
 * 标签页组的下行帧路由策略（插件私有，纯逻辑无 chrome 依赖）。
 * 会话叙事帧全员镜像；带交互/副作用的帧至多送达一个成员——缺省落活跃页，
 * snapshot-request / exec-instruction / guide-action 带 page 句柄时单播目标成员页
 * （adr-023 D2/D3），从结构上排除"同一签名指令被多页重复执行"（副作用重复）。
 */
import type { DownstreamFrame } from './frames.js';
import { tabIdForHandle, type PageHandleTable } from './page-handles.js';

export type FrameRoute = 'panel' | 'active-page' | 'target-page';

export function routeForFrame(frame: DownstreamFrame): FrameRoute {
  switch (frame.type) {
    case 'text-delta':
    case 'turn-complete':
    case 'tool-card':
    case 'hitl-request':
    case 'config-draft':
      return 'panel';
    case 'exec-instruction':
    case 'guide-action':
    case 'snapshot-request':
      return frame.page !== undefined ? 'target-page' : 'active-page';
  }
}

/**
 * target-page 单播的成员解析（纯函数）：tabId 逐成员等值比对，命中即单播该成员。
 * 任一级未命中（句柄已退役传入 null / 成员端口不在）一律空投递——这是竞态 fail-safe，
 * 不是判定面（判定只在服务端签发前，U7）；禁回退活跃页，带副作用的帧落错页比不落更糟。
 */
export function targetPageMembers<T>(
  members: readonly T[],
  tabIdOf: (member: T) => number | undefined,
  tabId: number | null,
): T[] {
  if (tabId === null) return [];
  const member = members.find((candidate) => tabIdOf(candidate) === tabId);
  return member === undefined ? [] : [member];
}

/**
 * target-page 帧的投递解析粘合（纯函数）：帧上目标句柄 → 句柄表反查 tabId → 成员端口
 * 等值匹配，至多命中一个成员。不载句柄的帧或任一级未命中一律空投递（fail-safe 同上，禁回退活跃页）。
 */
export function resolveTargetPageMembers<T>(
  frame: DownstreamFrame,
  table: PageHandleTable,
  members: readonly T[],
  tabIdOf: (member: T) => number | undefined,
): T[] {
  const handle =
    frame.type === 'snapshot-request' ||
    frame.type === 'exec-instruction' ||
    frame.type === 'guide-action'
      ? frame.page
      : undefined;
  const tabId = handle === undefined ? null : tabIdForHandle(table, handle);
  return targetPageMembers(members, tabIdOf, tabId);
}

export interface GroupMembers<T> {
  add(member: T): void;
  remove(member: T): void;
  /** 标记活跃页（用户视线所在）：由该成员的 context-report / user-message 触发。 */
  markActive(member: T): void;
  /**
   * route=active 时无显式活跃者则回退到「仍在组内且曾活跃过」的最近成员；
   * 若无任何曾活跃成员则返回 []（fail-safe：宁可本轮不投递，也不把带副作用的帧
   * 投到端口入组却从未进入用户视线的静默后台页）。route=panel 恒全员镜像。
   */
  targets(route: FrameRoute): T[];
  others(member: T): T[];
  members(): T[];
  size(): number;
}

export function createGroupMembers<T>(): GroupMembers<T> {
  const members: T[] = [];
  const everActive = new Set<T>();
  let active: T | null = null;
  return {
    add(member) {
      if (!members.includes(member)) members.push(member);
    },
    remove(member) {
      const index = members.indexOf(member);
      if (index !== -1) members.splice(index, 1);
      everActive.delete(member);
      if (active === member) active = null;
    },
    markActive(member) {
      if (members.includes(member)) {
        active = member;
        everActive.add(member);
      }
    },
    targets(route) {
      if (route === 'panel') return [...members];
      if (active !== null) return [active];
      for (let index = members.length - 1; index >= 0; index -= 1) {
        const candidate = members[index];
        if (candidate !== undefined && everActive.has(candidate)) return [candidate];
      }
      return [];
    },
    others(member) {
      return members.filter((candidate) => candidate !== member);
    },
    members() {
      return [...members];
    },
    size() {
      return members.length;
    },
  };
}
