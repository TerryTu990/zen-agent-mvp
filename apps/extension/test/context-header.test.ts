// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { contextHeaderView } from '../src/sidepanel.js';

describe('contextHeaderView：面板头部三态', () => {
  it('waiting：已绑组但尚未收到上下文', () => {
    expect(contextHeaderView(null, 7)).toEqual({
      state: 'waiting',
      title: '正在连接任务页面',
      detail: '任务组 7',
    });
  });

  it('ready：组内站点页显示页面标题与地址', () => {
    expect(
      contextHeaderView(
        {
          kind: 'task-context',
          groupId: 7,
          authorized: true,
          url: 'https://example.com/orders',
          title: '订单列表',
        },
        7,
      ),
    ).toEqual({
      state: 'ready',
      title: '订单列表',
      detail: 'https://example.com/orders',
    });
  });

  it('ready：浏览器内部页同样按已连接显示，不给「无法辅助」指引', () => {
    expect(
      contextHeaderView(
        {
          kind: 'task-context',
          groupId: 7,
          authorized: true,
          url: 'chrome://newtab/',
          title: '新标签页',
        },
        7,
      ),
    ).toEqual({
      state: 'ready',
      title: '新标签页',
      detail: 'chrome://newtab/',
    });
  });

  it('outside：组外页面', () => {
    expect(
      contextHeaderView(
        {
          kind: 'task-context',
          groupId: 7,
          authorized: false,
          url: 'chrome://newtab/',
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
