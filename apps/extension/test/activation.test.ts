import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  decideActivation,
  decidePanelVisibility,
  isAssistableUrl,
  sessionKeyForGroup,
  autoGroupKey,
  panelGroupKey,
  zenGroupKey,
  panelHistoryKeyForGroup,
  autoScanRunKeyForGroup,
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

describe('isAssistableUrl：可辅助页判定', () => {
  it('http/https 站点页可辅助', () => {
    expect(isAssistableUrl('http://example.com/path')).toBe(true);
    expect(isAssistableUrl('https://www.baidu.com/')).toBe(true);
  });

  it('浏览器内部页一律不可辅助', () => {
    expect(isAssistableUrl('chrome://newtab/')).toBe(false);
    expect(isAssistableUrl('chrome-extension://abcdefg/sidepanel.html')).toBe(false);
    expect(isAssistableUrl('about:blank')).toBe(false);
    expect(isAssistableUrl('edge://settings/')).toBe(false);
    expect(isAssistableUrl('devtools://devtools/bundled/inspector.html')).toBe(false);
  });

  it('非法/缺失 URL 不可辅助', () => {
    expect(isAssistableUrl('not-a-url')).toBe(false);
    expect(isAssistableUrl('')).toBe(false);
    expect(isAssistableUrl(undefined)).toBe(false);
  });
});

describe('组内导航激活（接线回归）', () => {
  it('background 的激活判定把"已登记 zen 组"视同已映射：会话建立前组内导航的新页也能重连', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/background.ts', import.meta.url)), 'utf8');
    expect(source).toContain('(await isGroupMapped(tabGroupId)) || (await isZenGroup(tabGroupId))');
  });

  it('background 对 zen 组内 status=complete 的 tab 补发激活（组内同 tab 导航自动接入）', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/background.ts', import.meta.url)), 'utf8');
    expect(source).toContain("changeInfo.status === 'complete'");
  });
});

describe('SPA 同文档导航后重装配（接线回归）', () => {
  it('background 对 url 变而无 status 的同文档导航向该页转发 refresh-context', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/background.ts', import.meta.url)), 'utf8');
    // url-only（无 status）专指 SPA 子路由切换，整页加载会带 status，故此判定不误触发全量重载路。
    expect(source).toContain('changeInfo.status === undefined && changeInfo.url !== undefined');
    expect(source).toContain('sendRefreshContext(tabId)');
    expect(source).toContain("kind: 'refresh-context'");
  });

  it('content 挂 hashchange/popstate 监听在可见时重报上下文（hash 路由与 back/forward）', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/content.ts', import.meta.url)), 'utf8');
    expect(source).toContain("window.addEventListener('hashchange', announceIfVisible)");
    expect(source).toContain("window.addEventListener('popstate', announceIfVisible)");
  });

  it('content 收 refresh-context 时仅在可见页触发既有 announce（pushState 兜底）', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/content.ts', import.meta.url)), 'utf8');
    expect(source).toContain("message?.kind === 'refresh-context'");
    expect(source).toContain('liveAnnounce');
  });
});

describe('会话组存根键', () => {
  it('会话、自动组和 Side Panel 绑定键均按其作用域命名', () => {
    expect(sessionKeyForGroup(42)).toBe('za.sessionId.g42');
    expect(autoGroupKey(3, 'https://mail.126.com')).toBe('za.autoGroup.3.https://mail.126.com');
    expect(panelGroupKey(3)).toBe('za.panelGroup.w3');
    expect(panelHistoryKeyForGroup(42)).toBe('za.panelHistory.g42');
    expect(autoScanRunKeyForGroup(42)).toBe('za.autoScanRun.g42');
    expect(zenGroupKey(42)).toBe('za.zenGroup.g42');
  });
});

describe('面板可见性判定（面板只在 zen 组的标签页上显示）', () => {
  it('zen 组内的标签页：显示并绑定该组', () => {
    expect(decidePanelVisibility({ tabGroupId: 7, isZenGroup: true })).toEqual({
      enabled: true,
      groupId: 7,
    });
  });

  it('未分组标签页：不显示、不绑定', () => {
    expect(decidePanelVisibility({ tabGroupId: TAB_GROUP_ID_NONE, isZenGroup: false })).toEqual({
      enabled: false,
      groupId: null,
    });
  });

  it('用户自建的非 zen 分组：同样不显示（分组本身不等于 zen 会话组）', () => {
    expect(decidePanelVisibility({ tabGroupId: 9, isZenGroup: false })).toEqual({
      enabled: false,
      groupId: null,
    });
  });

  it('未分组即便被误判为 zen 组也不显示（-1 不是可绑定的组）', () => {
    expect(decidePanelVisibility({ tabGroupId: TAB_GROUP_ID_NONE, isZenGroup: true })).toEqual({
      enabled: false,
      groupId: null,
    });
  });

  it('两个 zen 组各自绑定自己的组，互不串会话', () => {
    expect(decidePanelVisibility({ tabGroupId: 1, isZenGroup: true }).groupId).toBe(1);
    expect(decidePanelVisibility({ tabGroupId: 2, isZenGroup: true }).groupId).toBe(2);
  });
});
