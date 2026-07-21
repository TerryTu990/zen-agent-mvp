import { describe, expect, it } from 'vitest';
import {
  decideActivation,
  sessionKeyForGroup,
  autoGroupKey,
  panelGroupKey,
  panelHistoryKeyForGroup,
  TAB_GROUP_ID_NONE,
} from '../src/activation.js';

describe('decideActivation：显式会话组激活决策', () => {
  it('组内换页/SPA 刷新：已映射组优先 reconnect（保证组内会话延续）', () => {
    expect(
      decideActivation({ tabGroupId: 7, groupIsMapped: true, autoActivate: false, autoJoinGroupId: null }),
    ).toEqual({ kind: 'reconnect', groupId: 7 });
    // reconnect 优先于 autoActivate 的 join/create。
    expect(
      decideActivation({ tabGroupId: 7, groupIsMapped: true, autoActivate: true, autoJoinGroupId: 3 }),
    ).toEqual({ kind: 'reconnect', groupId: 7 });
  });

  it('未在会话组、autoActivate 命中且同窗同源已有组：加入既有组（不新建）', () => {
    expect(
      decideActivation({
        tabGroupId: TAB_GROUP_ID_NONE,
        groupIsMapped: false,
        autoActivate: true,
        autoJoinGroupId: 5,
      }),
    ).toEqual({ kind: 'join', groupId: 5 });
  });

  it('未在会话组、autoActivate 命中且无既有同源组：新建组', () => {
    expect(
      decideActivation({
        tabGroupId: TAB_GROUP_ID_NONE,
        groupIsMapped: false,
        autoActivate: true,
        autoJoinGroupId: null,
      }),
    ).toEqual({ kind: 'create' });
  });

  it('autoActivate 未命中且非已映射组：不激活（等图标点击显式发起）', () => {
    expect(
      decideActivation({
        tabGroupId: TAB_GROUP_ID_NONE,
        groupIsMapped: false,
        autoActivate: false,
        autoJoinGroupId: null,
      }),
    ).toEqual({ kind: 'none' });
    // 已分组但非 zen 会话组（用户自建组）且未 autoActivate：同样不激活。
    expect(
      decideActivation({ tabGroupId: 9, groupIsMapped: false, autoActivate: false, autoJoinGroupId: null }),
    ).toEqual({ kind: 'none' });
  });
});

describe('会话组存根键', () => {
  it('会话、自动组和 Side Panel 绑定键均按其作用域命名', () => {
    expect(sessionKeyForGroup(42)).toBe('za.sessionId.g42');
    expect(autoGroupKey(3, 'https://mail.126.com')).toBe('za.autoGroup.3.https://mail.126.com');
    expect(panelGroupKey(3)).toBe('za.panelGroup.w3');
    expect(panelHistoryKeyForGroup(42)).toBe('za.panelHistory.g42');
  });
});
