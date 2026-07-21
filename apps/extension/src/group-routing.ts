/**
 * 标签页组的下行帧路由策略（插件私有，纯逻辑无 chrome 依赖）。
 * 会话叙事帧全员镜像；带交互/副作用的帧只落在活跃页——exec 指令单成员送达，
 * 从结构上排除"同一签名指令被多页重复执行"（副作用重复）。
 */
import type { DownstreamFrame } from './frames.js';

export type FrameRoute = 'panel' | 'active-page';

export function routeForFrame(frame: DownstreamFrame): FrameRoute {
  switch (frame.type) {
    case 'text-delta':
    case 'tool-card':
    case 'hitl-request':
      return 'panel';
    case 'exec-instruction':
    case 'guide-action':
    case 'snapshot-request':
      return 'active-page';
  }
}

export interface GroupMembers<T> {
  add(member: T): void;
  remove(member: T): void;
  /** 标记活跃页（用户视线所在）：由该成员的 context-report / user-message 触发。 */
  markActive(member: T): void;
  /** route=active 时无显式活跃者则回退最近加入者（活跃页刚关闭的兜底），组空返回 []。 */
  targets(route: FrameRoute): T[];
  others(member: T): T[];
  members(): T[];
  size(): number;
}

export function createGroupMembers<T>(): GroupMembers<T> {
  const members: T[] = [];
  let active: T | null = null;
  return {
    add(member) {
      if (!members.includes(member)) members.push(member);
    },
    remove(member) {
      const index = members.indexOf(member);
      if (index !== -1) members.splice(index, 1);
      if (active === member) active = null;
    },
    markActive(member) {
      if (members.includes(member)) active = member;
    },
    targets(route) {
      if (route === 'panel') return [...members];
      const target = active ?? members[members.length - 1];
      return target === undefined ? [] : [target];
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
