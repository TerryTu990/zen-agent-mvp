/**
 * 任务组页面句柄与状态推导（adr-023 D1，插件私有，纯逻辑无 chrome 依赖）。
 * 句柄是会话作用域不透明标识：tabId↔句柄映射是插件内部态，任何字段不得进上行帧（U5）；
 * 计数只增不回收——同一 tab 离组再入组拿新句柄，防「同号句柄换绑页面实体」的定向误绑。
 * 该不变量以句柄表落盘成功为前提，边界见 parsePageHandleTable。
 */

import type { GroupPageEntry, GroupPageStatus } from './frames.js';

export interface PageHandleTable {
  nextSeq: number;
  /** 键为 tabId 十进制串；值为句柄 p<N>。 */
  byTab: Record<string, string>;
}

export function createPageHandleTable(): PageHandleTable {
  return { nextSeq: 1, byTab: {} };
}

/**
 * storage.session 读回。恢复以「会话内句柄永不复用」优先：不可信 byTab 条目按退役弃置
 * （退役恒安全，该 tab 下轮对齐拿新句柄）；计数取 max(存根计数, 表内最大序号+1)、只升不降——
 * 宁可跳号，不让存活服务端会话内的退役句柄换绑新页面实体。
 * 同一句柄映射到多个 tab 时无从判定它指向哪个页面实体，涉及的条目全部弃置（保留任一即可能
 * 把定向落点绑到错误的页），其序号仍计入计数、不再发放。
 *
 * 残余面：「会话内句柄永不复用」只在句柄表落盘成功时成立。落盘写入失败被吞（不重试、不降级
 * 阻断上报），此后 SW 重启则未落盘的分配无从恢复，同一序号可能再次发放给另一页面实体；服务端
 * 会话若仍存活，其状态表里的旧句柄即指向新页——定向落点错绑。边界：落盘成功、或 SW 不重启、
 * 或服务端会话已随存根一并失效时，不变量成立。
 */
export function parsePageHandleTable(value: unknown): PageHandleTable {
  const candidate =
    typeof value === 'object' && value !== null
      ? (value as { nextSeq?: unknown; byTab?: unknown })
      : {};
  const byTab: Record<string, string> = {};
  let maxSeq = 0;
  if (
    typeof candidate.byTab === 'object' &&
    candidate.byTab !== null &&
    !Array.isArray(candidate.byTab)
  ) {
    const keysByHandle = new Map<string, string[]>();
    for (const [key, handle] of Object.entries(candidate.byTab)) {
      if (typeof handle !== 'string') continue;
      const match = /^p([1-9][0-9]*)$/.exec(handle);
      if (match === null) continue;
      maxSeq = Math.max(maxSeq, Number(match[1]));
      const keys = keysByHandle.get(handle);
      if (keys === undefined) keysByHandle.set(handle, [key]);
      else keys.push(key);
    }
    for (const [handle, keys] of keysByHandle) {
      if (keys.length === 1) byTab[keys[0]!] = handle;
    }
  }
  const storedSeq =
    typeof candidate.nextSeq === 'number' &&
    Number.isInteger(candidate.nextSeq) &&
    candidate.nextSeq >= 1
      ? candidate.nextSeq
      : 1;
  return { nextSeq: Math.max(storedSeq, maxSeq + 1), byTab };
}

/**
 * 以成员全集对齐句柄表：新成员按到达顺序分配 p<nextSeq>，离组成员即退役；
 * 在组期间导航不改成员集，句柄自然保持。changed=false 时返回原表引用（免落盘）。
 */
export function reconcilePageHandles(
  table: PageHandleTable,
  memberTabIds: readonly number[],
): { table: PageHandleTable; changed: boolean } {
  const memberKeys = new Set(memberTabIds.map((id) => String(id)));
  const byTab: Record<string, string> = {};
  let nextSeq = table.nextSeq;
  let changed = false;
  for (const [key, handle] of Object.entries(table.byTab)) {
    if (memberKeys.has(key)) byTab[key] = handle;
    else changed = true;
  }
  for (const key of memberKeys) {
    if (byTab[key] === undefined) {
      byTab[key] = 'p' + nextSeq;
      nextSeq += 1;
      changed = true;
    }
  }
  return changed ? { table: { nextSeq, byTab }, changed: true } : { table, changed: false };
}

/** 反查句柄→tabId（只作等值比对；分配规则保证 byTab 值唯一）。null = 句柄已退役或从未存在。 */
export function tabIdForHandle(table: PageHandleTable, handle: string): number | null {
  for (const [key, value] of Object.entries(table.byTab)) {
    if (value === handle) return Number(key);
  }
  return null;
}

export interface MemberPageInfo {
  tabId: number;
  url: string;
  title?: string;
}

/** schema 硬约束：title maxLength 120、pages maxItems 64——超限帧会被服务端校验拒收。 */
const TITLE_MAX_LENGTH = 120;
const PAGES_MAX_ITEMS = 64;

/**
 * 由成员全集推导 group-pages 全量条目：active=当前活跃成员（含回退链命中者，由调用方
 * 经 targets('active-page') 算出 activeTabId）；background=有 content 端口的非活跃成员；
 * silent=入组但无端口（无 content script 交互保证）。句柄表无该 tab 映射时跳过该行。
 * 超 64 行截断时 active 行保证保留。
 */
export function deriveGroupPages(
  table: PageHandleTable,
  members: readonly MemberPageInfo[],
  portTabIds: ReadonlySet<number>,
  activeTabId: number | null,
): GroupPageEntry[] {
  const entries: GroupPageEntry[] = [];
  for (const member of members) {
    const handle = table.byTab[String(member.tabId)];
    if (handle === undefined) continue;
    const status: GroupPageStatus =
      member.tabId === activeTabId
        ? 'active'
        : portTabIds.has(member.tabId)
          ? 'background'
          : 'silent';
    const title = member.title === undefined ? '' : member.title.slice(0, TITLE_MAX_LENGTH);
    entries.push({
      handle,
      url: member.url,
      ...(title !== '' ? { title } : {}),
      status,
    });
  }
  if (entries.length <= PAGES_MAX_ITEMS) return entries;
  const activeIndex = entries.findIndex((entry) => entry.status === 'active');
  if (activeIndex < PAGES_MAX_ITEMS) return entries.slice(0, PAGES_MAX_ITEMS);
  const kept = entries.slice(0, PAGES_MAX_ITEMS - 1);
  kept.push(entries[activeIndex]!);
  return kept;
}

/** 尾沿防抖：窗口内连续触发合并为到期后一次 flush，flush 时点才采集最终全量快照。 */
export function createTrailingDebounce(delayMs: number, flush: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, delayMs);
  };
}
