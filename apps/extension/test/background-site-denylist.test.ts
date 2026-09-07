/**
 * 站点黑名单在 background 上的行为回归，按机制分组：五个激活入口、「用户可见副作用不先于判定发生」
 * 的先后序、组页面清单的句柄对齐、以及名单缓存的来源与失败语义。
 * 不变量 SD 本身（命中页不发帧 / 不执行下行指令 / 不登记为活跃页）以**帧种类**为单位枚举，
 * 见 invariant-site-denied.test.ts——那一组是不变量的权威验收，本文件只补它不覆盖的机制细节
 * （拉黑前那一报如实上行、句柄不悬空、L2 拉取失败保留名单）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  pageHandlesKeyForGroup,
  panelGroupKey,
  sessionKeyForGroup,
  TAB_GROUP_ID_NONE,
  zenGroupKey,
} from '../src/activation.js';
import type { GroupPageEntry, GroupPagesFrame } from '../src/frames.js';
import { siteDeniedSkipKey, SITE_DENYLIST_KEY } from '../src/site-denylist.js';
import { GRANTED_ORIGINS_KEY } from '../src/injection.js';
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
const DENIED_ENTRY = 'https://bank.example';
const DENIED_URL = 'https://bank.example/accounts';
const ALLOWED_URL = 'https://shop.example/orders';

afterEach(disposeHarnesses);

const deniedTab: FakeTab = { id: 11, url: DENIED_URL, title: '账户总览', groupId: GROUP_ID, windowId: WINDOW_ID };
const allowedTab: FakeTab = { id: 12, url: ALLOWED_URL, title: '订单', groupId: GROUP_ID, windowId: WINDOW_ID };

/** 已建会话且已登记的 zen 组：四个激活入口都以此为前置。 */
const mappedGroup: Record<string, unknown> = {
  [sessionKeyForGroup(GROUP_ID)]: SESSION_ID,
  [zenGroupKey(GROUP_ID)]: true,
};

describe('站点黑名单守住全部激活入口（判定下沉到 sendActivate）', () => {
  it('激活握手（content request-activate）：命中即不发 activate；未命中照常发（正常）', async () => {
    const h = await loadBackground({
      denylist: [DENIED_ENTRY],
      tabs: [deniedTab, allowedTab],
      storageSession: mappedGroup,
    });
    h.emitMessage({ kind: 'request-activate' }, deniedTab);
    await settle();
    expect(h.activated).toEqual([]);

    h.emitMessage({ kind: 'request-activate' }, allowedTab);
    await settle();
    expect(h.activated).toEqual([allowedTab.id]);
  });

  it('工具栏图标点击：命中即不发 activate', async () => {
    const h = await loadBackground({
      denylist: [DENIED_ENTRY],
      tabs: [deniedTab, allowedTab],
      storageSession: mappedGroup,
    });
    h.emitIconClick(deniedTab);
    await settle();
    expect(h.activated).toEqual([]);

    h.emitIconClick(allowedTab);
    await settle();
    expect(h.activated).toEqual([allowedTab.id]);
  });

  it('组内导航补发（tabs.onUpdated status=complete）：命中即不发 activate', async () => {
    const h = await loadBackground({
      denylist: [DENIED_ENTRY],
      tabs: [deniedTab, allowedTab],
      storageSession: mappedGroup,
    });
    h.emitTabUpdated(deniedTab.id, { status: 'complete' }, deniedTab);
    await settle();
    expect(h.activated).toEqual([]);

    h.emitTabUpdated(allowedTab.id, { status: 'complete' }, allowedTab);
    await settle();
    expect(h.activated).toEqual([allowedTab.id]);
  });

  it('拖入已映射组（tabs.onUpdated groupId 变更）：命中即不发 activate', async () => {
    const h = await loadBackground({
      denylist: [DENIED_ENTRY],
      tabs: [deniedTab, allowedTab],
      storageSession: mappedGroup,
    });
    h.emitTabUpdated(deniedTab.id, { groupId: GROUP_ID }, deniedTab);
    await settle();
    expect(h.activated).toEqual([]);

    h.emitTabUpdated(allowedTab.id, { groupId: GROUP_ID }, allowedTab);
    await settle();
    expect(h.activated).toEqual([allowedTab.id]);
  });

  it('navigate 代执行开页：新开的页落在名单内即不发 activate（边界）', async () => {
    const h = await loadBackground({
      denylist: [DENIED_ENTRY],
      tabs: [allowedTab],
      storageSession: mappedGroup,
    });
    const port = h.connectContent(allowedTab);
    port.emit({ kind: 'navigate-request', requestId: 'r1', url: DENIED_URL });
    await settle();
    expect([...h.tabs.values()].some((tab) => tab.url === DENIED_URL)).toBe(true);
    expect(h.activated).toEqual([]);

    port.emit({ kind: 'navigate-request', requestId: 'r2', url: 'https://other.example/carts' });
    await settle();
    const opened = [...h.tabs.values()].find((tab) => tab.url === 'https://other.example/carts');
    expect(opened).toBeDefined();
    expect(h.activated).toEqual([opened!.id]);
  });

  it('navigate 代执行开页：新页导航尚未提交（url 空、目标在 pendingUrl）同样挡下（边界）', async () => {
    const h = await loadBackground({
      denylist: [DENIED_ENTRY],
      tabs: [allowedTab],
      storageSession: mappedGroup,
      createLeavesUrlPending: true,
    });
    const port = h.connectContent(allowedTab);
    port.emit({ kind: 'navigate-request', requestId: 'r1', url: DENIED_URL });
    await settle();
    expect([...h.tabs.values()].some((tab) => tab.pendingUrl === DENIED_URL)).toBe(true);
    expect(h.activated).toEqual([]);
  });

  it('名单为空（拉取失败回空）→ 全部入口照常激活（异常：客户端不确定不拦）', async () => {
    const h = await loadBackground({ tabs: [deniedTab], storageSession: mappedGroup });
    h.emitIconClick(deniedTab);
    await settle();
    h.emitTabUpdated(deniedTab.id, { status: 'complete' }, deniedTab);
    await settle();
    expect(h.activated).toEqual([deniedTab.id, deniedTab.id]);
  });
});

describe('上行闸门：已激活页在名单保存后不再上报页面上下文', () => {
  const contextReport = { kind: 'context-report', url: DENIED_URL, title: '账户总览' };

  it('端口仍在、页面继续 announce，但名单保存后的上报一律不上行（正常：这是最可能发生的流程）', async () => {
    const h = await loadBackground({
      denylist: [],
      tabs: [deniedTab],
      storageSession: mappedGroup,
      serve,
    });
    const port = h.connectContent(deniedTab);
    port.emit(contextReport);
    await settle();
    // 拉黑前这一报如实上行——服务端上下文里因此留有该 URL，下一轮 compose 才判得出 site-denied。
    expect(reportedContextUrls(h)).toEqual([DENIED_URL]);

    h.local[SITE_DENYLIST_KEY] = [DENIED_ENTRY];
    port.emit(contextReport);
    port.emit(contextReport);
    await settle();
    expect(reportedContextUrls(h)).toEqual([DENIED_URL]);
  });

  it('名单为空则同一序列全部上行（对照：丢弃只由名单驱动）', async () => {
    const h = await loadBackground({
      denylist: [],
      tabs: [deniedTab],
      storageSession: mappedGroup,
      serve,
    });
    const port = h.connectContent(deniedTab);
    port.emit(contextReport);
    await settle();
    port.emit(contextReport);
    port.emit(contextReport);
    await settle();
    expect(reportedContextUrls(h)).toEqual([DENIED_URL, DENIED_URL, DENIED_URL]);
  });

  it('同组未命中页不受牵连，照常上行（边界：闸门按上报 URL 逐帧判，不按组停摆）', async () => {
    const h = await loadBackground({
      denylist: [DENIED_ENTRY],
      tabs: [deniedTab, allowedTab],
      storageSession: mappedGroup,
      serve,
    });
    const deniedPort = h.connectContent(deniedTab);
    const allowedPort = h.connectContent(allowedTab);
    deniedPort.emit(contextReport);
    allowedPort.emit({ kind: 'context-report', url: ALLOWED_URL, title: '订单' });
    await settle();
    expect(reportedContextUrls(h)).toEqual([ALLOWED_URL]);
  });
});

describe('激活入口的用户可见副作用不先于黑名单判定发生', () => {
  const looseDeniedTab: FakeTab = {
    id: 21,
    url: DENIED_URL,
    title: '账户总览',
    groupId: TAB_GROUP_ID_NONE,
    windowId: WINDOW_ID,
  };
  const looseAllowedTab: FakeTab = {
    id: 22,
    url: ALLOWED_URL,
    title: '订单',
    groupId: TAB_GROUP_ID_NONE,
    windowId: WINDOW_ID,
  };

  it('工具栏图标点击：命中站点的未分组页不被拉进新建的 Zen 组，也不登记会话组（正常）', async () => {
    const h = await loadBackground({ denylist: [DENIED_ENTRY], tabs: [looseDeniedTab] });
    h.emitIconClick(looseDeniedTab);
    await settle();
    expect(h.tabs.get(looseDeniedTab.id)?.groupId).toBe(TAB_GROUP_ID_NONE);
    expect(h.session[panelGroupKey(WINDOW_ID)]).toBeUndefined();
    expect(Object.keys(h.session).some((key) => key.startsWith('za.zenGroup'))).toBe(false);
    expect(h.activated).toEqual([]);
  });

  it('工具栏图标点击：未命中页照常建组并登记（对照）', async () => {
    const h = await loadBackground({ denylist: [DENIED_ENTRY], tabs: [looseAllowedTab] });
    h.emitIconClick(looseAllowedTab);
    await settle();
    const groupId = h.tabs.get(looseAllowedTab.id)?.groupId ?? TAB_GROUP_ID_NONE;
    expect(groupId).not.toBe(TAB_GROUP_ID_NONE);
    expect(h.session[zenGroupKey(groupId)]).toBe(true);
    expect(h.activated).toEqual([looseAllowedTab.id]);
  });

  it('激活握手一律不建组：脚本在页内不构成开会话的理由，未分组页命不命中都一样（边界）', async () => {
    const h = await loadBackground({ denylist: [DENIED_ENTRY], tabs: [looseDeniedTab, looseAllowedTab] });
    h.emitMessage({ kind: 'request-activate' }, looseDeniedTab);
    h.emitMessage({ kind: 'request-activate' }, looseAllowedTab);
    await settle();
    expect(h.tabs.get(looseDeniedTab.id)?.groupId).toBe(TAB_GROUP_ID_NONE);
    expect(h.tabs.get(looseAllowedTab.id)?.groupId).toBe(TAB_GROUP_ID_NONE);
    expect(Object.keys(h.session).some((key) => key.startsWith('za.zenGroup'))).toBe(false);
    expect(h.activated).toEqual([]);
  });
});

/** 已映射会话的最小服务端：事件流可连、上行帧被接收；其余请求一律网络不可达。 */
const serve = (request: ServedRequest): Served | null => {
  if (request.url === `${BASE_URL}/v1/sessions/${SESSION_ID}/events`) {
    return {
      status: 200,
      stream: true,
      headers: {
        'x-zen-agent-exec-algorithm': 'Ed25519',
        'x-zen-agent-exec-public-key': 'fake-public-key',
      },
    };
  }
  if (request.url === `${BASE_URL}/v1/sessions/${SESSION_ID}/frames`) {
    return { status: 200, body: { messageState: 'complete' } };
  }
  return null;
};

/** 实际到达服务端的 context-report 帧的 url，按发生序。 */
function reportedContextUrls(harness: Harness): string[] {
  return harness.requests
    .filter((request) => request.url.endsWith('/frames'))
    .map((request) => request.body as { type?: string; url?: string })
    .filter((body) => body.type === 'context-report')
    .map((body) => body.url ?? '');
}

describe('任务组页面清单不泄露黑名单站点', () => {
  async function reportedPages(harness: Harness): Promise<GroupPageEntry[] | undefined> {
    await new Promise((resolve) => setTimeout(resolve, 350));
    await settle();
    return harness.requests
      .filter((request) => request.url.endsWith('/frames'))
      .map((request) => request.body as { type?: string; pages?: GroupPageEntry[] })
      .find((body) => body.type === 'group-pages')?.pages;
  }

  it('命中条目不进 group-pages 帧（正常：该页 url/title 是 LLM 可见面）', async () => {
    const h = await loadBackground({
      denylist: [DENIED_ENTRY],
      tabs: [allowedTab, deniedTab],
      storageSession: mappedGroup,
      serve,
    });
    h.connectContent(allowedTab);
    expect((await reportedPages(h))?.map((page) => page.url)).toEqual([ALLOWED_URL]);
  });

  it('名单为空时全量上报（对照：过滤只由名单驱动）', async () => {
    const h = await loadBackground({
      denylist: [],
      tabs: [allowedTab, deniedTab],
      storageSession: mappedGroup,
      serve,
    });
    h.connectContent(allowedTab);
    const urls = (await reportedPages(h))?.map((page) => page.url) ?? [];
    expect([...urls].sort()).toEqual([DENIED_URL, ALLOWED_URL].sort());
  });

  it('名单保存即重报清单：服务端手里的旧清单不再留着命中页的条目', async () => {
    const h = await loadBackground({
      denylist: [],
      tabs: [allowedTab, deniedTab],
      storageSession: mappedGroup,
      serve,
    });
    h.connectContent(allowedTab);
    expect((await reportedPages(h))?.map((page) => page.url).sort()).toEqual([DENIED_URL, ALLOWED_URL].sort());

    const mark = h.upstream().length;
    h.local[SITE_DENYLIST_KEY] = [DENIED_ENTRY];
    h.emitStorageChanged({ [SITE_DENYLIST_KEY]: { oldValue: [], newValue: [DENIED_ENTRY] } });
    await new Promise((resolve) => setTimeout(resolve, 350));
    await settle();

    const resent = h
      .upstream()
      .slice(mark)
      .filter((frame): frame is GroupPagesFrame => frame.type === 'group-pages')
      .flatMap((frame) => frame.pages);
    expect(resent.length).toBeGreaterThan(0);
    expect(resent.map((page) => page.url)).not.toContain(DENIED_URL);
  });

  it('命中页不留悬空句柄：句柄表只登记未被过滤的成员（边界）', async () => {
    const h = await loadBackground({
      denylist: [DENIED_ENTRY],
      tabs: [allowedTab, deniedTab],
      storageSession: mappedGroup,
      serve,
    });
    h.connectContent(allowedTab);
    await reportedPages(h);
    const table = h.session[pageHandlesKeyForGroup(GROUP_ID)] as { byTab: Record<string, string> } | undefined;
    expect(Object.keys(table?.byTab ?? {})).toEqual([String(allowedTab.id)]);
  });
});

/**
 * 「本机确实跳过了这一页的激活」是面板客户端自述的唯一判据。
 * 它一旦不再成立却仍留着，面板就会对着一个照常辅助的页说「本站不辅助」——
 * 与自述本身的承诺相反。故名单变更与该页离开命中站点两条路都必须撤销它。
 */
describe('跳过激活的事实登记随事实撤销（N2-COPY-02）', () => {
  async function skippedScene(): Promise<Harness> {
    const h = await loadBackground({
      denylist: [DENIED_ENTRY],
      tabs: [deniedTab, allowedTab],
      storageSession: { ...mappedGroup },
      serve,
    });
    h.emitIconClick(deniedTab);
    await settle();
    expect(h.session[siteDeniedSkipKey(deniedTab.id)]).toBe(true);
    return h;
  }

  it('用户把条目移出名单：该页的跳过登记随之撤销', async () => {
    const h = await skippedScene();
    h.local[SITE_DENYLIST_KEY] = [];
    h.emitStorageChanged({ [SITE_DENYLIST_KEY]: { oldValue: [DENIED_ENTRY], newValue: [] } });
    await settle(20);
    expect(h.session[siteDeniedSkipKey(deniedTab.id)]).toBeUndefined();
  });

  it('该 tab 导航离开命中站点：跳过登记随之撤销', async () => {
    const h = await skippedScene();
    const navigated = { ...deniedTab, url: ALLOWED_URL };
    h.tabs.set(deniedTab.id, navigated);
    h.emitTabUpdated(deniedTab.id, { url: ALLOWED_URL }, navigated);
    await settle(20);
    expect(h.session[siteDeniedSkipKey(deniedTab.id)]).toBeUndefined();
  });

  it('名单仍命中该页时登记保留（对照：撤销只由事实不再成立驱动）', async () => {
    const h = await skippedScene();
    h.emitStorageChanged({ [SITE_DENYLIST_KEY]: { oldValue: [DENIED_ENTRY], newValue: [DENIED_ENTRY] } });
    h.emitTabUpdated(deniedTab.id, { url: DENIED_URL }, deniedTab);
    await settle(20);
    expect(h.session[siteDeniedSkipKey(deniedTab.id)]).toBe(true);
  });
});

describe('L2 拉取失败不清空本机名单', () => {
  it('/v1/user-config 拉取失败 → 保留上次名单（宁可多挡一站，不因网络抖动静默清空隐私开关）', async () => {
    const h = await loadBackground({
      denylist: [DENIED_ENTRY],
      tabs: [deniedTab],
      storageSession: mappedGroup,
      serve: () => null,
    });
    expect(h.local[SITE_DENYLIST_KEY]).toEqual([DENIED_ENTRY]);
    h.emitIconClick(deniedTab);
    await settle();
    expect(h.activated).toEqual([]);
  });

  it('黑名单与站点授权集派生自同一次 /v1/user-config 拉取，不为任一项另发请求', async () => {
    const h = await loadBackground({
      tabs: [deniedTab],
      serve: (request) => {
        if (request.url === `${BASE_URL}/v1/user-config`) {
          return {
            status: 200,
            body: {
              revision: 'rev-1',
              overlay: {
                schemaVersion: 1,
                packs: { '*': { siteDenylist: [DENIED_ENTRY], grantedOrigins: ['https://shop.example'] } },
              },
            },
          };
        }
        return null;
      },
    });
    expect(h.requests.filter((request) => request.url === `${BASE_URL}/v1/user-config`)).toHaveLength(1);
    expect(h.local[SITE_DENYLIST_KEY]).toEqual([DENIED_ENTRY]);
    expect(h.local[GRANTED_ORIGINS_KEY]).toEqual(['https://shop.example']);
  });

  it('/v1/user-config 拉取成功且名单为空 → 覆写为空（用户确实清空了名单）', async () => {
    const h = await loadBackground({
      denylist: [DENIED_ENTRY],
      tabs: [deniedTab],
      storageSession: mappedGroup,
      serve: (request) =>
        request.url === `${BASE_URL}/v1/user-config`
          ? { status: 200, body: { revision: 'rev-1', overlay: { schemaVersion: 1, packs: { '*': {} } } } }
          : null,
    });
    expect(h.local[SITE_DENYLIST_KEY]).toEqual([]);
  });
});
