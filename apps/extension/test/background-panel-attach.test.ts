/**
 * 组内页面接入的三条客户端信号面。判据分三组：
 * 组内新开页在成为活跃页之前就把面板置为启用（Chrome 切到面板禁用的页即关闭侧边栏，且不再自动重开）、
 * 站点访问权限到手即对任务组成员补注入、面板拿得到每一页的接入态与未接入原因并可手动补接入。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { sessionKeyForGroup, zenGroupKey } from '../src/activation.js';
import type { PanelPageEntry } from '../src/messaging.js';
import {
  disposeHarnesses,
  loadBackground,
  settle,
  SESSION_ID,
  type FakeTab,
} from './support/background-harness.js';

const GROUP_ID = 7;
const OTHER_GROUP_ID = 9;
const WINDOW_ID = 1;
const SHOP_ORIGIN_PATTERN = 'https://shop.example/*';

const shopTab: FakeTab = { id: 12, url: 'https://shop.example/orders', title: '订单', groupId: GROUP_ID, windowId: WINDOW_ID };

const zenGroup: Record<string, unknown> = {
  [sessionKeyForGroup(GROUP_ID)]: SESSION_ID,
  [zenGroupKey(GROUP_ID)]: true,
};

/** 只看落到具体标签页的面板设置（模块加载时那次全局禁用无 tabId）。 */
function panelSettingsFor(h: { panelOptions: Array<{ tabId?: number; enabled?: boolean }> }, tabId: number) {
  return h.panelOptions.filter((options) => options.tabId === tabId);
}

function lastPageStatus(panel: { received: unknown[] }): PanelPageEntry[] | undefined {
  const replies = panel.received.filter(
    (message) => (message as { kind?: string }).kind === 'group-page-status',
  ) as Array<{ pages: PanelPageEntry[] }>;
  return replies[replies.length - 1]?.pages;
}

afterEach(disposeHarnesses);

describe('组内新开页的面板启用（chrome.tabs.onCreated）', () => {
  it('由组内页面打开的新页：创建当刻即启用面板，不等入组事件到达', async () => {
    const h = await loadBackground({ tabs: [shopTab], storageSession: zenGroup });
    h.emitTabCreated({ id: 33, url: '', groupId: -1, windowId: WINDOW_ID, openerTabId: shopTab.id });
    await settle();
    expect(panelSettingsFor(h, 33)).toEqual([{ tabId: 33, path: 'sidepanel.html', enabled: true }]);
  });

  it('新页已带组号（入组先于事件到达）：同样启用', async () => {
    const h = await loadBackground({ tabs: [shopTab], storageSession: zenGroup });
    h.emitTabCreated({ id: 34, url: '', groupId: GROUP_ID, windowId: WINDOW_ID });
    await settle();
    expect(panelSettingsFor(h, 34)).toEqual([{ tabId: 34, path: 'sidepanel.html', enabled: true }]);
  });

  it('与任务组无关的新页：一个字都不改（面板只在任务组内出现）', async () => {
    const outsideTab: FakeTab = { id: 41, url: 'https://news.example/', groupId: OTHER_GROUP_ID, windowId: WINDOW_ID };
    const h = await loadBackground({ tabs: [shopTab, outsideTab], storageSession: zenGroup });
    h.emitTabCreated({ id: 42, url: '', groupId: -1, windowId: WINDOW_ID, openerTabId: outsideTab.id });
    h.emitTabCreated({ id: 43, url: '', groupId: -1, windowId: WINDOW_ID });
    await settle();
    expect(panelSettingsFor(h, 42)).toEqual([]);
    expect(panelSettingsFor(h, 43)).toEqual([]);
  });
});

describe('站点访问权限到手即补注入（chrome.permissions.onAdded）', () => {
  it('授权后对任务组成员逐个补注入，组外标签页不碰', async () => {
    const outsideTab: FakeTab = { id: 51, url: 'https://news.example/', groupId: OTHER_GROUP_ID, windowId: WINDOW_ID };
    const h = await loadBackground({ tabs: [shopTab, outsideTab], storageSession: zenGroup });
    await settle();
    expect(h.injected).toEqual([]);
    h.emitPermissionsAdded([SHOP_ORIGIN_PATTERN]);
    await settle();
    expect(h.injected).toEqual([shopTab.id]);
    expect(h.activated).toEqual([shopTab.id]);
  });

  it('命中站点黑名单的成员页不因授权而被注入（名单闸门仍在最后一步）', async () => {
    const deniedTab: FakeTab = { id: 52, url: 'https://bank.example/accounts', groupId: GROUP_ID, windowId: WINDOW_ID };
    const h = await loadBackground({
      tabs: [deniedTab],
      storageSession: zenGroup,
      denylist: ['https://bank.example'],
    });
    h.emitPermissionsAdded(['https://bank.example/*']);
    await settle();
    expect(h.injected).toEqual([]);
  });
});

describe('面板侧的成员页接入态清单', () => {
  it('未接入的页按本机事实标出原因：缺站点权限 / 浏览器不允许 / 不辅助名单', async () => {
    const internalTab: FakeTab = { id: 61, url: 'chrome://newtab/', groupId: GROUP_ID, windowId: WINDOW_ID };
    const deniedTab: FakeTab = { id: 62, url: 'https://bank.example/accounts', groupId: GROUP_ID, windowId: WINDOW_ID };
    const h = await loadBackground({
      tabs: [shopTab, internalTab, deniedTab],
      storageSession: zenGroup,
      denylist: ['https://bank.example'],
    });
    const panel = h.connectPanel(GROUP_ID);
    await settle();
    expect(lastPageStatus(panel)).toEqual([
      { tabId: shopTab.id, url: shopTab.url, title: '订单', status: 'silent', reason: 'permission' },
      { tabId: internalTab.id, url: internalTab.url, status: 'silent', reason: 'restricted' },
      { tabId: deniedTab.id, url: deniedTab.url, status: 'silent', reason: 'site-denied' },
    ]);
  });

  it('已授权且已接入的页不再是 silent，也就没有原因行', async () => {
    const h = await loadBackground({
      tabs: [shopTab],
      storageSession: zenGroup,
      grantedOrigins: [SHOP_ORIGIN_PATTERN],
    });
    h.connectContent(shopTab);
    const panel = h.connectPanel(GROUP_ID);
    await settle();
    expect(lastPageStatus(panel)).toEqual([
      { tabId: shopTab.id, url: shopTab.url, title: '订单', status: 'background' },
    ]);
  });

  it('采样当刻仍在加载的页按瞬时态标注，不冒充「缺权限」', async () => {
    const h = await loadBackground({
      tabs: [{ ...shopTab, status: 'loading' }],
      storageSession: zenGroup,
      grantedOrigins: [SHOP_ORIGIN_PATTERN],
    });
    const panel = h.connectPanel(GROUP_ID);
    await settle();
    expect(lastPageStatus(panel)?.[0]).toMatchObject({ status: 'silent', reason: 'loading' });
  });
});

describe('面板发起的手动补接入（attach-page）', () => {
  it('本组成员：重走一次注入与激活，回执如实带成败', async () => {
    const h = await loadBackground({ tabs: [shopTab], storageSession: zenGroup });
    const panel = h.connectPanel(GROUP_ID);
    await settle();
    panel.emit({ kind: 'attach-page', tabId: shopTab.id });
    await settle();
    expect(h.injected).toEqual([shopTab.id]);
    expect(panel.received).toContainEqual({ kind: 'attach-page-result', tabId: shopTab.id, ok: true });
  });

  it('注入仍失败（站点权限未取得）：回 ok:false，不伪装成已接入', async () => {
    const h = await loadBackground({
      tabs: [shopTab],
      storageSession: zenGroup,
      injectionDeniedTabs: [shopTab.id],
    });
    const panel = h.connectPanel(GROUP_ID);
    await settle();
    panel.emit({ kind: 'attach-page', tabId: shopTab.id });
    await settle();
    expect(h.activated).toEqual([]);
    expect(panel.received).toContainEqual({ kind: 'attach-page-result', tabId: shopTab.id, ok: false });
  });

  it('落点已不在本组：不注入（注入面不越出任务组边界）', async () => {
    const outsideTab: FakeTab = { id: 71, url: 'https://news.example/', groupId: OTHER_GROUP_ID, windowId: WINDOW_ID };
    const h = await loadBackground({ tabs: [shopTab, outsideTab], storageSession: zenGroup });
    const panel = h.connectPanel(GROUP_ID);
    await settle();
    panel.emit({ kind: 'attach-page', tabId: outsideTab.id });
    await settle();
    expect(h.injected).toEqual([]);
    expect(panel.received).toContainEqual({ kind: 'attach-page-result', tabId: outsideTab.id, ok: false });
  });
});
