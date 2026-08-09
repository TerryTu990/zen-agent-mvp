import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGroupMembers } from '../src/group-routing.js';
import {
  createPageHandleTable,
  createTrailingDebounce,
  deriveGroupPages,
  parsePageHandleTable,
  reconcilePageHandles,
  tabIdForHandle,
  type MemberPageInfo,
} from '../src/page-handles.js';

describe('reconcilePageHandles：句柄分配与退役', () => {
  it('首次入组按到达顺序分配 p<N>，nextSeq 单调递增', () => {
    const { table, changed } = reconcilePageHandles(createPageHandleTable(), [101, 102]);
    expect(changed).toBe(true);
    expect(table.byTab).toEqual({ '101': 'p1', '102': 'p2' });
    expect(table.nextSeq).toBe(3);
  });

  it('成员集不变（组内导航）：句柄保持且返回原表引用（免落盘）', () => {
    const initial = reconcilePageHandles(createPageHandleTable(), [101, 102]).table;
    const { table, changed } = reconcilePageHandles(initial, [102, 101]);
    expect(changed).toBe(false);
    expect(table).toBe(initial);
  });

  it('离组即退役；再入组分配新句柄，计数只增不复用', () => {
    const initial = reconcilePageHandles(createPageHandleTable(), [101, 102]).table;
    const afterLeave = reconcilePageHandles(initial, [101]);
    expect(afterLeave.changed).toBe(true);
    expect(afterLeave.table.byTab).toEqual({ '101': 'p1' });
    const afterRejoin = reconcilePageHandles(afterLeave.table, [101, 102]);
    // 102 的旧句柄 p2 已退役，再入组拿 p3——p2 永不换绑到别的页面实体
    expect(afterRejoin.table.byTab).toEqual({ '101': 'p1', '102': 'p3' });
    expect(afterRejoin.table.nextSeq).toBe(4);
  });
});

describe('parsePageHandleTable：SW 重启恢复', () => {
  it('合法存根原样恢复', () => {
    const stored = { nextSeq: 5, byTab: { '101': 'p1', '104': 'p4' } };
    expect(parsePageHandleTable(stored)).toEqual(stored);
  });

  it('整体缺失/非对象存根回全新表', () => {
    expect(parsePageHandleTable(undefined)).toEqual(createPageHandleTable());
    expect(parsePageHandleTable('junk')).toEqual(createPageHandleTable());
    expect(parsePageHandleTable({ nextSeq: 0, byTab: {} })).toEqual(createPageHandleTable());
  });

  it('byTab 条目不可信只弃该条目（退役），计数保持——恢复后不重发已退役句柄', () => {
    const parsed = parsePageHandleTable({ nextSeq: 5, byTab: { '101': '', '102': 'p2', '103': 7 } });
    expect(parsed).toEqual({ nextSeq: 5, byTab: { '102': 'p2' } });
    const { table } = reconcilePageHandles(parsed, [101, 102]);
    expect(table.byTab).toEqual({ '101': 'p5', '102': 'p2' });
    expect(table.nextSeq).toBe(6);
  });

  it('byTab 整体不可信（数组/非对象）按空表退役处理，计数保持', () => {
    expect(parsePageHandleTable({ nextSeq: 4, byTab: [] })).toEqual({ nextSeq: 4, byTab: {} });
    expect(parsePageHandleTable({ nextSeq: 4, byTab: 'junk' })).toEqual({ nextSeq: 4, byTab: {} });
  });

  it('存根计数落后于表内句柄序号：计数抬升到最大序号+1，后续分配不撞在绑/退役句柄', () => {
    const parsed = parsePageHandleTable({ nextSeq: 2, byTab: { '101': 'p7' } });
    expect(parsed).toEqual({ nextSeq: 8, byTab: { '101': 'p7' } });
    const { table } = reconcilePageHandles(parsed, [101, 102]);
    expect(table.byTab).toEqual({ '101': 'p7', '102': 'p8' });
  });

  it('计数缺失/非法时按表内最大序号回推，不归 1', () => {
    expect(parsePageHandleTable({ nextSeq: 0, byTab: { '101': 'p3' } })).toEqual({
      nextSeq: 4,
      byTab: { '101': 'p3' },
    });
    expect(parsePageHandleTable({ byTab: { '101': 'p3' } })).toEqual({
      nextSeq: 4,
      byTab: { '101': 'p3' },
    });
  });

  it('同一句柄绑多个 tab：涉及条目全部弃置，该序号不再发放', () => {
    const parsed = parsePageHandleTable({
      nextSeq: 4,
      byTab: { '101': 'p3', '102': 'p3', '103': 'p1' },
    });
    expect(parsed).toEqual({ nextSeq: 4, byTab: { '103': 'p1' } });
    const { table } = reconcilePageHandles(parsed, [101, 102, 103]);
    expect(table.byTab).toEqual({ '101': 'p4', '102': 'p5', '103': 'p1' });
    expect(tabIdForHandle(table, 'p3')).toBeNull();
  });

  it('非 p<N> 形状句柄按退役弃置（表私有格式，插件只写 p<N>）', () => {
    expect(parsePageHandleTable({ nextSeq: 3, byTab: { '101': 'weird', '102': 'p01' } })).toEqual({
      nextSeq: 3,
      byTab: {},
    });
  });
});

describe('tabIdForHandle：句柄反查（adr-023 D2 目标页单播）', () => {
  const table = reconcilePageHandles(createPageHandleTable(), [101, 102]).table;

  it('在绑句柄命中对应 tabId', () => {
    expect(tabIdForHandle(table, 'p1')).toBe(101);
    expect(tabIdForHandle(table, 'p2')).toBe(102);
  });

  it('退役句柄反查为 null（离组后不指向任何 tab）', () => {
    const afterLeave = reconcilePageHandles(table, [101]).table;
    expect(tabIdForHandle(afterLeave, 'p2')).toBeNull();
  });

  it('异形入参一律 null：空串 / 非句柄串 / tabId 数字串', () => {
    expect(tabIdForHandle(table, '')).toBeNull();
    expect(tabIdForHandle(table, 'orders-page')).toBeNull();
    expect(tabIdForHandle(table, '101')).toBeNull();
  });
});

const membersOf = (...tabIds: number[]): MemberPageInfo[] =>
  tabIds.map((tabId) => ({ tabId, url: `https://host.example/page/${tabId}`, title: `页 ${tabId}` }));

describe('deriveGroupPages：三态判定', () => {
  const table = reconcilePageHandles(createPageHandleTable(), [101, 102, 103]).table;

  it('active=活跃成员；background=有端口的非活跃成员；silent=无端口成员', () => {
    const pages = deriveGroupPages(table, membersOf(101, 102, 103), new Set([101, 102]), 101);
    expect(pages.map((page) => [page.handle, page.status])).toEqual([
      ['p1', 'active'],
      ['p2', 'background'],
      ['p3', 'silent'],
    ]);
  });

  it('无活跃者（activeTabId=null）：本帧无 active 行', () => {
    const pages = deriveGroupPages(table, membersOf(101, 102), new Set([101]), null);
    expect(pages.map((page) => page.status)).toEqual(['background', 'silent']);
  });

  it('回退链：显式活跃者离场后，targets 命中的曾活跃成员判 active', () => {
    const ports = createGroupMembers<{ tabId: number }>();
    const port101 = { tabId: 101 };
    const port102 = { tabId: 102 };
    ports.add(port101);
    ports.markActive(port101);
    ports.add(port102);
    ports.markActive(port102);
    ports.remove(port102);
    const activeTabId = ports.targets('active-page')[0]?.tabId ?? null;
    expect(activeTabId).toBe(101);
    const pages = deriveGroupPages(table, membersOf(101, 103), new Set([101]), activeTabId);
    expect(pages.map((page) => [page.handle, page.status])).toEqual([
      ['p1', 'active'],
      ['p3', 'silent'],
    ]);
  });

  it('句柄表无映射的成员不出行（等待下轮对齐）', () => {
    const pages = deriveGroupPages(table, membersOf(101, 999), new Set(), null);
    expect(pages.map((page) => page.handle)).toEqual(['p1']);
  });

  it('title 截断至 120 字符；空标题缺省不出字段', () => {
    const longTitle = 'x'.repeat(200);
    const pages = deriveGroupPages(
      table,
      [
        { tabId: 101, url: 'https://host.example/a', title: longTitle },
        { tabId: 102, url: 'https://host.example/b' },
      ],
      new Set(),
      null,
    );
    expect(pages[0]?.title).toHaveLength(120);
    expect(pages[1] !== undefined && 'title' in pages[1]).toBe(false);
  });

  it('超 64 行截断且 active 行必保留', () => {
    const tabIds = Array.from({ length: 70 }, (_, index) => 200 + index);
    const bigTable = reconcilePageHandles(createPageHandleTable(), tabIds).table;
    const pages = deriveGroupPages(bigTable, membersOf(...tabIds), new Set([269]), 269);
    expect(pages).toHaveLength(64);
    expect(pages.filter((page) => page.status === 'active')).toHaveLength(1);
  });

  it('负锚（U5）：条目对象不含 tabId/groupId 等形态标识键', () => {
    const pages = deriveGroupPages(table, membersOf(101, 102, 103), new Set([101]), 101);
    for (const page of pages) {
      expect(Object.keys(page).sort()).toEqual(['handle', 'status', 'title', 'url']);
    }
  });
});

describe('createTrailingDebounce：突发合并', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('窗口内连续触发只 flush 一次，且 flush 在最后一次触发后到期时才采集', () => {
    vi.useFakeTimers();
    const snapshots: number[] = [];
    let current = 0;
    const trigger = createTrailingDebounce(300, () => snapshots.push(current));
    trigger();
    current = 1;
    vi.advanceTimersByTime(200);
    trigger();
    current = 2;
    vi.advanceTimersByTime(200);
    expect(snapshots).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(snapshots).toEqual([2]);
    vi.advanceTimersByTime(1000);
    expect(snapshots).toEqual([2]);
  });
});
