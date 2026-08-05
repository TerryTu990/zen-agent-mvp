/**
 * watch 自动回合的纯判定/投影单测（adr-021）。这些函数决定「哪一个页面算被监测页」
 * 与「比对基线怎么归并」——边界（尾斜杠、查询串、hash、大小写、端口）在集成用例里
 * 恒以同一个精确 URL 触达，无法被证伪，故就地锁定。
 */
import { describe, expect, it } from 'vitest';
import {
  diffWatchSnapshots,
  hasWatchChange,
  isWatchWorkPage,
  resolveWatchRun,
  watchPageKey,
  watchSnapshotOf,
} from '../src/watch-run.js';
import type { UserOverlay, UserOverlayWatch } from '@zen-agent/contracts';

const watch = (overrides: Partial<UserOverlayWatch> = {}): UserOverlayWatch => ({
  id: 'watch-orders',
  templateId: 'page-watch',
  url: 'http://127.0.0.1:4173/order-list.html',
  minutes: 5,
  enabled: true,
  ...overrides,
});

const overlayWith = (watches: UserOverlayWatch[]): UserOverlay => ({ watches } as UserOverlay);

describe('实例归属判定（fail-closed 三态）', () => {
  it('可运行的只读实例解析为 ready', () => {
    const resolution = resolveWatchRun(overlayWith([watch()]), 'watch-orders');
    expect(resolution.kind).toBe('ready');
  });

  it('未知 id 与空 overlay 解析为 none（由调用方拒绝，不在此处回落）', () => {
    expect(resolveWatchRun(overlayWith([watch()]), 'not-a-watch').kind).toBe('none');
    expect(resolveWatchRun(null, 'watch-orders').kind).toBe('none');
  });

  it('未启用实例与闭集外模板一律 blocked，绝不回落 none', () => {
    expect(resolveWatchRun(overlayWith([watch({ enabled: false })]), 'watch-orders').kind).toBe('blocked');
    const alien = { ...watch(), templateId: 'page-write' } as unknown as UserOverlayWatch;
    expect(resolveWatchRun(overlayWith([alien]), 'watch-orders').kind).toBe('blocked');
  });
});

describe('被监测页归一标识', () => {
  it('查询串与 hash 不改变标识——否则同一页的跟踪参数变体各自建基线，变化永不报告', () => {
    const base = watchPageKey('https://shop.test/item/1');
    expect(watchPageKey('https://shop.test/item/1?from=search')).toBe(base);
    expect(watchPageKey('https://shop.test/item/1#reviews')).toBe(base);
    expect(watchPageKey('https://shop.test/item/1/')).toBe(base);
  });

  it('origin 的任一成分参与标识；不可解析的 URL 为 null', () => {
    expect(watchPageKey('https://shop.test/a')).not.toBe(watchPageKey('http://shop.test/a'));
    expect(watchPageKey('https://shop.test/a')).not.toBe(watchPageKey('https://shop.test:8443/a'));
    expect(watchPageKey('not-a-url')).toBeNull();
  });
});

describe('工作页归属', () => {
  const url = 'https://shop.test/item/1';

  it('路径精确相等才算工作页；查询串与尾斜杠不影响', () => {
    expect(isWatchWorkPage(url, 'https://shop.test/item/1')).toBe(true);
    expect(isWatchWorkPage(url, 'https://shop.test/item/1?utm=x')).toBe(true);
    expect(isWatchWorkPage(url, 'https://shop.test/item/1/')).toBe(true);
  });

  it('子路径、上级路径、前缀相邻、异 origin 与坏 URL 一律判否', () => {
    expect(isWatchWorkPage(url, 'https://shop.test/item/1/reviews')).toBe(false);
    expect(isWatchWorkPage(url, 'https://shop.test/item')).toBe(false);
    expect(isWatchWorkPage(url, 'https://shop.test/item/10')).toBe(false);
    expect(isWatchWorkPage(url, 'https://evil.shop.test/item/1')).toBe(false);
    expect(isWatchWorkPage(url, 'not-a-url')).toBe(false);
    expect(isWatchWorkPage('not-a-url', url)).toBe(false);
  });
});

describe('快照比对', () => {
  const elements = (labels: string[]) =>
    labels.map((label, index) => ({ ref: `e${index}`, role: 'row', label }));

  it('提示文本进基线：仅正文提示变化也算变化', () => {
    const before = watchSnapshotOf('https://shop.test/a', 'T', elements(['A']), ['库存充足']);
    const after = watchSnapshotOf('https://shop.test/a', 'T', elements(['A']), ['仅剩 2 件']);
    expect(hasWatchChange(diffWatchSnapshots(before, after))).toBe(true);
  });

  it('ref 重新编号不算变化——否则每轮都报「全变了」', () => {
    const before = watchSnapshotOf('https://shop.test/a', 'T', elements(['A', 'B']), []);
    const renumbered = [
      { ref: 'z9', role: 'row', label: 'A' },
      { ref: 'z8', role: 'row', label: 'B' },
    ];
    const after = watchSnapshotOf('https://shop.test/a', 'T', renumbered, []);
    expect(hasWatchChange(diffWatchSnapshots(before, after))).toBe(false);
  });
});
