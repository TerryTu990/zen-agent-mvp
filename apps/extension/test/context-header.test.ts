// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { InjectionDescriptionView } from '../src/messaging.js';
import { contextHeaderView, pageEffectView } from '../src/sidepanel.js';

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

describe('pageEffectView：面板「本页生效」块（A-UX-02）', () => {
  const base: InjectionDescriptionView = {
    snapshotVersion: '1.0.0',
    packId: 'shop',
    featureId: 'order-list',
    blocks: [],
    toolIds: [],
  };

  it('命中站点包：来源徽章、功能标题、工具数与配置版本逐行呈现（正常）', () => {
    const view = pageEffectView({
      ...base,
      packName: '示例商店',
      packVersion: '1.2.0',
      packSource: 'community',
      featureTitle: '订单处理',
      toolIds: ['shop.list', 'shop.cancel'],
      tools: [
        { toolId: 'shop.list', baseTier: 'auto', effectiveTier: 'hitl', origin: 'L1', tightenedBy: 'shop' },
        { toolId: 'shop.cancel', baseTier: 'hitl', effectiveTier: 'hitl', origin: 'L1' },
      ],
      userConfigRevision: 'abcdef0123456789',
      reason: 'pack',
    });
    expect(view.headline).toContain('站点包');
    const rows = Object.fromEntries(view.rows.map((row) => [row.label, row.value]));
    expect(rows['站点包']).toBe('示例商店 · v1.2.0 · 社区');
    expect(rows['功能']).toBe('订单处理');
    expect(rows['站点包工具']).toContain('2 项');
    expect(rows['站点包工具']).toContain('1 项被你收紧');
    expect(rows['站点包工具']).toContain('shop');
    expect(rows['我的配置']).toContain('abcdef012345');
  });

  it('无 pack 命中：reason=base-only，站点包行如实说明（边界）', () => {
    const view = pageEffectView({
      snapshotVersion: '1.0.0',
      packId: null,
      featureId: null,
      blocks: [],
      toolIds: [],
      reason: 'base-only',
    });
    expect(view.headline).toContain('只注入平台基座');
    const rows = Object.fromEntries(view.rows.map((row) => [row.label, row.value]));
    expect(rows['站点包']).toContain('未命中');
    expect(rows['站点包工具']).toContain('0 项');
  });

  it('generic 兜底：说明本页无专属站点包（边界）', () => {
    const view = pageEffectView({ ...base, packId: 'generic-web', reason: 'generic' });
    expect(view.headline).toContain('通用');
  });

  it('用户关停 pack：headline 点名被关停的 pack（边界）', () => {
    const view = pageEffectView({
      ...base,
      packId: null,
      featureId: null,
      disabledPackId: 'shop',
      reason: 'pack-disabled',
    });
    expect(view.headline).toContain('shop');
    expect(view.headline).toContain('关停');
  });

  it('存储降级导致全部工具 forbidden：收紧来源如实标注为读取失败（异常）', () => {
    const view = pageEffectView({
      ...base,
      toolIds: [],
      tools: [
        {
          toolId: 'shop.list',
          baseTier: 'auto',
          effectiveTier: 'forbidden',
          origin: 'L1',
          tightenedBy: 'storage-failure',
        },
      ],
      reason: 'pack',
    });
    const rows = Object.fromEntries(view.rows.map((row) => [row.label, row.value]));
    expect(rows['站点包工具']).toContain('个人配置读取失败');
  });

  it('服务端未给 reason（旧版本）→ headline 留空，不由客户端推断（边界：U7 客户端零判定）', () => {
    const view = pageEffectView(base);
    expect(view.headline).toBe('');
  });

  it('note 明确限定数据源，不暗示展示了模型收到的全部内容（R6）', () => {
    const view = pageEffectView(base);
    expect(view.note).toContain('内建工具');
    expect(view.note).toContain('不在此列');
  });
});
