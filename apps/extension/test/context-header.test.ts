// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { contextHeaderView, urlPendingCommit } from '../src/sidepanel.js';

describe('contextHeaderView：面板头部四态', () => {
  it('waiting：已绑组但尚未收到上下文', () => {
    expect(contextHeaderView(null, 7)).toEqual({
      state: 'waiting',
      title: '正在连接任务页面',
      detail: '任务组 7',
    });
  });

  it('ready：组内可辅助页显示页面标题与地址', () => {
    expect(
      contextHeaderView(
        {
          kind: 'task-context',
          groupId: 7,
          authorized: true,
          url: 'https://example.com/orders',
          title: '订单列表',
          assistable: true,
        },
        7,
      ),
    ).toEqual({
      state: 'ready',
      title: '订单列表',
      detail: 'https://example.com/orders',
    });
  });

  it('ready：assistable 缺省视为可辅助（content 上报路径不带标记）', () => {
    expect(
      contextHeaderView(
        { kind: 'task-context', groupId: 7, authorized: true, url: 'https://example.com/' },
        7,
      ).state,
    ).toBe('ready');
  });

  it('unassistable：组内不可辅助页给行动指引', () => {
    expect(
      contextHeaderView(
        {
          kind: 'task-context',
          groupId: 7,
          authorized: true,
          url: 'chrome://newtab/',
          title: '新标签页',
          assistable: false,
        },
        7,
      ),
    ).toEqual({
      state: 'unassistable',
      title: '此页面无法辅助',
      detail: '切换到站点页面，或让 Zen 导航后继续',
    });
  });

  it('outside：组外页面优先于不可辅助判定', () => {
    expect(
      contextHeaderView(
        {
          kind: 'task-context',
          groupId: 7,
          authorized: false,
          url: 'chrome://newtab/',
          assistable: false,
        },
        7,
      ),
    ).toEqual({
      state: 'outside',
      title: '当前页面不在任务组内',
      detail: 'chrome://newtab/',
    });
  });
});

describe('urlPendingCommit：URL 未 commit 的加载页暂缓 assistable 判定', () => {
  it('navigate 开新页瞬间（url 空 + loading）不下 assistable 结论', () => {
    expect(urlPendingCommit({ status: 'loading' })).toBe(true);
    expect(urlPendingCommit({ url: '', pendingUrl: 'https://example.com/' })).toBe(true);
  });

  it('URL 已 commit 或无标签页时照常判定', () => {
    expect(urlPendingCommit({ url: 'https://example.com/', status: 'loading' })).toBe(false);
    expect(urlPendingCommit({ url: 'chrome://newtab/', status: 'complete' })).toBe(false);
    expect(urlPendingCommit(undefined)).toBe(false);
    expect(urlPendingCommit({ status: 'complete' })).toBe(false);
  });
});
