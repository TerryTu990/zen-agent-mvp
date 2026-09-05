/**
 * 不变量 IN 的验收（adr-027 按需注入双轨模型）：**content 脚本只出现在两类页面上——
 * (a) 用户在本会话里对其发起了动作的页（图标 / 右键 / 快捷动作 / 服务端下发的定向帧）、
 * (b) 用户为 watch 自动化显式授权过 origin 的页；其余任何页面上不注入。
 * 注入面 = 授权集 − 站点黑名单。**
 *
 * 用例以「注入触发源」为单位枚举而非以代码路径为单位：轨一的每一种触发源各一条正例，
 * 「没有触发源」的情形单独成组，黑名单优先另成一组。按路径逐条补判定挡不住「又多出一条路径」，
 * 按触发源枚举才对得上不变量本身的措辞。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { pageHandlesKeyForGroup, sessionKeyForGroup, zenGroupKey } from '../src/activation.js';
import { contentScriptIdForOrigin, GRANTED_ORIGINS_KEY, originMatchPattern } from '../src/injection.js';
import { SITE_DENYLIST_KEY } from '../src/site-denylist.js';
import {
  BASE_URL,
  disposeHarnesses,
  loadBackground,
  settle,
  SESSION_ID,
  type FakeTab,
  type Harness,
  type Served,
  type ServedRequest,
} from './support/background-harness.js';

const GROUP_ID = 7;
const WINDOW_ID = 1;
const WORK_ORIGIN = 'https://shop.example';
const WORK_URL = `${WORK_ORIGIN}/orders`;
const OTHER_URL = `${WORK_ORIGIN}/orders/2`;
const BANK_ORIGIN = 'https://bank.example';
const BANK_URL = `${BANK_ORIGIN}/accounts`;

afterEach(disposeHarnesses);

const workTab: FakeTab = { id: 11, url: WORK_URL, title: '订单', groupId: GROUP_ID, windowId: WINDOW_ID };
const secondTab: FakeTab = { id: 12, url: OTHER_URL, title: '订单详情', groupId: GROUP_ID, windowId: WINDOW_ID };
const bankTab: FakeTab = { id: 13, url: BANK_URL, title: '账户', groupId: GROUP_ID, windowId: WINDOW_ID };
/** 组外的第三方页：用户从未在本会话里对它发起动作，也未授权其 origin。 */
const strangerTab: FakeTab = { id: 21, url: 'https://news.example/feed', title: '新闻', groupId: -1, windowId: WINDOW_ID };

const mappedGroup: Record<string, unknown> = {
  [sessionKeyForGroup(GROUP_ID)]: SESSION_ID,
  [zenGroupKey(GROUP_ID)]: true,
  [pageHandlesKeyForGroup(GROUP_ID)]: { nextSeq: 3, byTab: { '11': 'p1', '12': 'p2' } },
};

/** 快捷提问清单的最小服务端：右键派生项据此注册。 */
function serveQuickActions(request: ServedRequest): Served | null {
  if (request.url === `${BASE_URL}/v1/user-config`) return { status: 200, body: { overlay: { packs: {} } } };
  if (request.url === `${BASE_URL}/v1/packs`) {
    return {
      status: 200,
      body: {
        packs: [
          {
            packId: 'shop',
            generic: true,
            quickActions: [
              { id: 'explain-selection', label: '解释选中内容', template: '请解释 {{selection}}', context: 'selection' },
            ],
          },
        ],
      },
    };
  }
  return null;
}

describe('轨一：会话内的每一种注入触发源都注入目标页', () => {
  it('工具栏图标点击', async () => {
    const h = await loadBackground({ tabs: [workTab], storageSession: {} });
    h.emitIconClick(workTab);
    await settle();
    expect(h.injected).toContain(workTab.id);
  });

  it('右键兜底项「用 Zen 讲解选中内容」', async () => {
    const h = await loadBackground({ tabs: [workTab], storageSession: mappedGroup });
    h.emitContextMenuClick({ menuItemId: 'za-explain-selection', selectionText: '这段话' }, workTab);
    await settle();
    expect(h.injected).toContain(workTab.id);
  });

  it('右键派生的快捷提问项', async () => {
    const h = await loadBackground({
      tabs: [workTab],
      storageSession: mappedGroup,
      serve: serveQuickActions,
    });
    const panel = h.connectPanel(GROUP_ID);
    panel.emit({ kind: 'quick-actions-request', siteDenied: false });
    await settle();
    expect(h.menus.map((item) => item.id)).toContain('za-qa:explain-selection');
    h.emitContextMenuClick({ menuItemId: 'za-qa:explain-selection', selectionText: '这段话' }, workTab);
    await settle();
    expect(h.injected).toContain(workTab.id);
  });

  it('组内同 tab 导航补发（tabs.onUpdated status=complete）', async () => {
    const h = await loadBackground({ tabs: [workTab], storageSession: mappedGroup });
    h.emitTabUpdated(workTab.id, { status: 'complete' }, workTab);
    await settle();
    expect(h.injected).toContain(workTab.id);
  });

  it('拖入已映射组（tabs.onUpdated groupId 变更）', async () => {
    const h = await loadBackground({ tabs: [secondTab], storageSession: mappedGroup });
    h.emitTabUpdated(secondTab.id, { groupId: GROUP_ID }, secondTab);
    await settle();
    expect(h.injected).toContain(secondTab.id);
  });

  it('navigate 代执行开出的新页', async () => {
    const h = await loadBackground({ tabs: [workTab], storageSession: mappedGroup });
    const port = h.connectContent(workTab);
    port.emit({ kind: 'navigate-request', requestId: 'r1', url: 'https://shop.example/checkout' });
    await settle();
    const created = [...h.tabs.values()].find((tab) => tab.url === 'https://shop.example/checkout');
    expect(created).toBeDefined();
    expect(h.injected).toContain(created!.id);
  });

  it('服务端下发的定向帧：目标页尚未注入即先注入，端口接入后再投递', async () => {
    const h = await loadBackground({ tabs: [workTab, secondTab], storageSession: mappedGroup });
    const active = h.connectContent(workTab);
    active.emit({ kind: 'context-report', url: WORK_URL, title: '订单' });
    await settle();
    h.pushDownstream({ type: 'snapshot-request', sessionId: SESSION_ID, requestId: 'req-1', page: 'p2' });
    await settle();
    expect(h.injected).toContain(secondTab.id);

    const target = h.connectContent(secondTab);
    await settle();
    expect(
      target.received.some(
        (message) =>
          (message as { kind?: string; frame?: { type?: string } }).kind === 'frame' &&
          (message as { frame?: { type?: string } }).frame?.type === 'snapshot-request',
      ),
    ).toBe(true);
  });
});

describe('轨二：只对「L2 声明 ∩ 本机已授权」的 origin 常驻注册', () => {
  const serveUserConfig =
    (grantedOrigins: string[]) =>
    (request: ServedRequest): Served | null => {
      if (request.url === `${BASE_URL}/v1/user-config`) {
        return {
          status: 200,
          body: {
            overlay: { schemaVersion: 1, packs: { '*': { grantedOrigins } } },
            revision: 'rev-1',
          },
        };
      }
      if (request.url === `${BASE_URL}/v1/automation-descriptors`) return { status: 200, body: { descriptors: [] } };
      return null;
    };

  it('两侧都有即注册该 origin（载荷恒为插件自带 dist/content.js）', async () => {
    const h = await loadBackground({
      tabs: [],
      grantedOrigins: [originMatchPattern(WORK_ORIGIN)],
      serve: serveUserConfig([WORK_ORIGIN]),
    });
    await settle(20);
    expect(h.registrations.map((item) => item.id)).toEqual([contentScriptIdForOrigin(WORK_ORIGIN)]);
    expect(h.registrations[0]?.matches).toEqual([originMatchPattern(WORK_ORIGIN)]);
    expect(h.registrations[0]?.js).toEqual(['dist/content.js']);
  });

  it('L2 声明了但本机未授权：不注册（本机授权是浏览器判定，插件不得自行扩张注入面）', async () => {
    const h = await loadBackground({ tabs: [], grantedOrigins: [], serve: serveUserConfig([WORK_ORIGIN]) });
    await settle(20);
    expect(h.registrations).toEqual([]);
  });

  it('本机授权了但 L2 未声明：不注册（注入面取交集，本机多出的授权不构成放行）', async () => {
    const h = await loadBackground({
      tabs: [],
      grantedOrigins: [originMatchPattern(WORK_ORIGIN)],
      serve: serveUserConfig([]),
    });
    await settle(20);
    expect(h.registrations).toEqual([]);
  });

  it('授权撤销即对称注销：L2 移除该 origin 后本族注册项被清掉', async () => {
    let granted = [WORK_ORIGIN];
    const h = await loadBackground({
      tabs: [],
      grantedOrigins: [originMatchPattern(WORK_ORIGIN)],
      serve: (request) => serveUserConfig(granted)(request),
    });
    await settle(20);
    expect(h.registrations).toHaveLength(1);
    granted = [];
    h.emitStorageChanged({ 'za.serverBaseUrl': { oldValue: BASE_URL, newValue: BASE_URL } });
    await settle(20);
    expect(h.registrations).toEqual([]);
  });
});

describe('没有触发源的页面上不注入', () => {
  it('组外第三方页加载完成：不注入、不注册', async () => {
    const h = await loadBackground({ tabs: [strangerTab], storageSession: mappedGroup });
    h.emitTabUpdated(strangerTab.id, { status: 'complete' }, strangerTab);
    await settle();
    expect(h.injected).toEqual([]);
    expect(h.registrations).toEqual([]);
  });

  it('用户从未发起任何动作：全程零注入', async () => {
    const h = await loadBackground({ tabs: [strangerTab, workTab], storageSession: {} });
    await settle(20);
    expect(h.injected).toEqual([]);
    expect(h.registrations).toEqual([]);
  });

  it('非 zen 分组内的导航不补发注入（用户自建标签组）', async () => {
    const userGroupTab: FakeTab = { ...strangerTab, groupId: 99 };
    const h = await loadBackground({ tabs: [userGroupTab], storageSession: mappedGroup });
    h.emitTabUpdated(userGroupTab.id, { status: 'complete' }, userGroupTab);
    await settle();
    expect(h.injected).toEqual([]);
  });
});

describe('黑名单优先于授权：两轨都不注入', () => {
  it('图标点击命中黑名单页：不注入', async () => {
    const h = await loadBackground({
      denylist: [BANK_ORIGIN],
      tabs: [bankTab],
      storageSession: mappedGroup,
    });
    h.emitIconClick(bankTab);
    await settle();
    expect(h.injected).toEqual([]);
  });

  it('定向帧目标页命中黑名单：不注入', async () => {
    const h = await loadBackground({
      denylist: [BANK_ORIGIN],
      tabs: [workTab, bankTab],
      storageSession: {
        ...mappedGroup,
        [pageHandlesKeyForGroup(GROUP_ID)]: { nextSeq: 3, byTab: { '11': 'p1', '13': 'p2' } },
      },
    });
    const active = h.connectContent(workTab);
    active.emit({ kind: 'context-report', url: WORK_URL, title: '订单' });
    await settle();
    h.pushDownstream({ type: 'snapshot-request', sessionId: SESSION_ID, requestId: 'req-1', page: 'p2' });
    await settle();
    expect(h.injected).not.toContain(bankTab.id);
  });

  it('已授权 origin 落进黑名单：常驻注册被撤销', async () => {
    const h = await loadBackground({
      tabs: [],
      grantedOrigins: [originMatchPattern(BANK_ORIGIN)],
      serve: (request) => {
        if (request.url === `${BASE_URL}/v1/user-config`) {
          return {
            status: 200,
            body: {
              overlay: {
                schemaVersion: 1,
                packs: { '*': { grantedOrigins: [BANK_ORIGIN], siteDenylist: [BANK_ORIGIN] } },
              },
              revision: 'rev-1',
            },
          };
        }
        if (request.url === `${BASE_URL}/v1/automation-descriptors`) {
          return { status: 200, body: { descriptors: [] } };
        }
        return null;
      },
    });
    await settle(20);
    expect(h.local[SITE_DENYLIST_KEY]).toEqual([BANK_ORIGIN]);
    expect(h.local[GRANTED_ORIGINS_KEY]).toEqual([BANK_ORIGIN]);
    expect(h.registrations).toEqual([]);
  });
});

/**
 * 注入失败（该 origin 未授权且无 activeTab / 页面本身不可注入）：本页保持无 content。
 * 客户端不为此单独提示——失败对用户不可观察，能力缺席由服务端的 silent 页叙述兜住。
 */
describe('注入失败：本页保持无 content，不降级不改投', () => {
  it('轨一注入失败即不发 activate（不伪装成功）', async () => {
    const h = await loadBackground({
      tabs: [workTab],
      storageSession: {},
      injectionDeniedTabs: [workTab.id],
    });
    h.emitIconClick(workTab);
    await settle();
    expect(h.injected).toEqual([]);
    expect(h.activated).toEqual([]);
  });

  it('定向帧目标页注入失败：丢帧，不改投同组他页', async () => {
    const h = await loadBackground({
      tabs: [workTab, secondTab],
      storageSession: mappedGroup,
      injectionDeniedTabs: [secondTab.id],
    });
    const active = h.connectContent(workTab);
    active.emit({ kind: 'context-report', url: WORK_URL, title: '订单' });
    await settle();
    const before = active.received.length;
    h.pushDownstream({ type: 'snapshot-request', sessionId: SESSION_ID, requestId: 'req-1', page: 'p2' });
    await settle();

    expect(h.injected).not.toContain(secondTab.id);
    expect(
      active.received.slice(before).filter((message) => (message as { kind?: string }).kind === 'frame'),
      '目标页注入不进去时，帧不得落到同组的活跃页上',
    ).toEqual([]);
  });
});
