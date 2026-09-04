/**
 * 快捷提问的插件侧投影（R-5）：/v1/packs + /v1/user-config → 本页可呈现的一份清单。
 * 三条判据：合并口径与服务端同源（首见者胜 + 停用取并集）、featureIds 过滤、
 * 投影里不出现 template（客户端不持第二份模板副本）。
 */
import { describe, expect, it } from 'vitest';
import {
  mergeQuickActions,
  panelQuickActions,
  parseQuickActions,
  quickActionsFromPacks,
  quickActionsFromUserConfig,
  selectionQuickActions,
} from '../src/quick-actions.js';

const packsBody = {
  packs: [
    {
      packId: 'generic-web',
      quickActions: [
        { id: 'explain-selection', label: '解释选中内容', template: '请解释：{{selection}}', context: 'selection' },
        { id: 'summarize-page', label: '总结本页', template: '请总结 {{url}}', context: 'page' },
        { id: 'browse-only', label: '只在浏览功能', template: '看看这页', context: 'none', featureIds: ['browse'] },
      ],
    },
    { packId: 'other-pack', quickActions: [{ id: 'nope', label: '别家', template: 'x', context: 'none' }] },
  ],
};

describe('quickActionsFromPacks（L1 声明投影）', () => {
  it('只取当前 pack 的声明', () => {
    expect(quickActionsFromPacks(packsBody, 'generic-web').map((a) => a.id)).toEqual([
      'explain-selection',
      'summarize-page',
      'browse-only',
    ]);
  });

  it('投影不含 template：客户端不持第二份模板副本', () => {
    for (const action of quickActionsFromPacks(packsBody, 'generic-web')) {
      expect(action).not.toHaveProperty('template');
    }
  });

  it('无 pack 命中（仅基座轮）即空', () => {
    expect(quickActionsFromPacks(packsBody, null)).toEqual([]);
  });

  it('残缺项逐条丢弃而非整表作废', () => {
    const parsed = parseQuickActions([
      { id: 'ok', label: '可用', context: 'none' },
      { id: 'Bad Id', label: '文法不合', context: 'none' },
      { id: 'no-context', label: '缺 context' },
      { id: 'long-label', label: 'x'.repeat(41), context: 'none' },
    ]);
    expect(parsed.map((a) => a.id)).toEqual(['ok']);
  });
});

describe('quickActionsFromUserConfig + mergeQuickActions（L2 覆盖层）', () => {
  const userConfigBody = {
    overlay: {
      packs: {
        '*': {
          quickActions: [{ id: 'my-global', label: '我的跨站问法', template: 'x', context: 'none' }],
          disabledQuickActions: ['summarize-page'],
        },
        'generic-web': {
          quickActions: [{ id: 'my-scoped', label: '我的本站问法', template: 'x', context: 'none' }],
        },
      },
    },
  };

  it('L2 两作用域条目排在 L1 之后，停用条目整体摘除', () => {
    const overlay = quickActionsFromUserConfig(userConfigBody, 'generic-web');
    const merged = mergeQuickActions(quickActionsFromPacks(packsBody, 'generic-web'), overlay, 'browse');
    expect(merged.map((a) => a.id)).toEqual([
      'explain-selection',
      'browse-only',
      'my-global',
      'my-scoped',
    ]);
  });

  it('别的 pack 作用域的条目不在本页可见集里', () => {
    const overlay = quickActionsFromUserConfig(userConfigBody, 'other-pack');
    expect(overlay.scoped).toEqual([]);
    expect(overlay.global.map((a) => a.id)).toEqual(['my-global']);
  });

  it('featureIds 声明只在命中功能上呈现', () => {
    const declared = quickActionsFromPacks(packsBody, 'generic-web');
    const empty = { global: [], scoped: [], disabled: [] };
    expect(mergeQuickActions(declared, empty, 'other-feature').map((a) => a.id)).not.toContain('browse-only');
    expect(mergeQuickActions(declared, empty, null).map((a) => a.id)).not.toContain('browse-only');
    expect(mergeQuickActions(declared, empty, 'browse').map((a) => a.id)).toContain('browse-only');
  });

  it('L2 同名 id 覆写 L1 无效：首见者胜（与服务端同口径）', () => {
    const overlay = {
      global: [{ id: 'summarize-page', label: '我改的名字', context: 'none' as const }],
      scoped: [],
      disabled: [],
    };
    const merged = mergeQuickActions(quickActionsFromPacks(packsBody, 'generic-web'), overlay, 'browse');
    expect(merged.filter((a) => a.id === 'summarize-page')).toHaveLength(1);
    expect(merged.find((a) => a.id === 'summarize-page')?.label).toBe('总结本页');
  });

  it('读不出结构一律按空（不确定就不给入口）', () => {
    expect(quickActionsFromUserConfig(null, 'generic-web')).toEqual({ global: [], scoped: [], disabled: [] });
    expect(quickActionsFromPacks(undefined, 'generic-web')).toEqual([]);
  });
});

describe('两个入口各取自己能满足材料的条目', () => {
  const declared = quickActionsFromPacks(packsBody, 'generic-web');
  const merged = mergeQuickActions(declared, { global: [], scoped: [], disabled: [] }, 'browse');

  it('面板 chips 不含 selection 类（面板取不到页面选区）', () => {
    expect(panelQuickActions(merged).map((a) => a.id)).toEqual(['summarize-page', 'browse-only']);
  });

  it('右键菜单只含 selection 类', () => {
    expect(selectionQuickActions(merged).map((a) => a.id)).toEqual(['explain-selection']);
  });
});
