// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type { BackgroundToSidePanelMessage, SidePanelToBackgroundMessage } from '../src/messaging.js';
import { panelGroupKey } from '../src/activation.js';
import { siteDeniedSkipKey } from '../src/site-denylist.js';
import {
  mountSidePanel,
  SITE_DENIED_CLIENT_NOTICE,
  startSidePanel,
  type SidePanelElements,
} from '../src/sidepanel.js';

interface PanelHarness {
  elements: SidePanelElements;
  sent: SidePanelToBackgroundMessage[];
  optionsOpened: number;
  deliver(message: BackgroundToSidePanelMessage): void;
  /** 面板挂起之后用户切了页：活动标签页与 storage.session 登记一并换掉。 */
  switchTo(tab: PanelOptions['activeTab'], sessionItems?: Record<string, unknown>): void;
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

interface PanelOptions {
  /** storage.session 内容：任务组绑定与「本机确实跳过了激活」的事实登记经此进入面板。 */
  sessionItems?: Record<string, unknown>;
  /** 当前窗口活动标签页。 */
  activeTab?: { id: number; windowId: number; groupId: number; url: string; title: string };
}

/** 以最小 chrome 桩驱动真实面板：绑定任务组 → 建端口 → 收 panel-ready，落到可提交状态。 */
async function startPanel(options: PanelOptions = {}): Promise<PanelHarness> {
  const current = {
    activeTab: options.activeTab ?? { id: 5, windowId: 1, groupId: 7, url: 'https://example.com', title: '页面' },
  };
  const sessionItems: Record<string, unknown> = options.sessionItems ?? { [panelGroupKey(1)]: 7 };
  const sent: SidePanelToBackgroundMessage[] = [];
  const listeners: ((raw: unknown) => void)[] = [];
  const noopEvent = { addListener: () => undefined };
  const harness = { optionsOpened: 0 };
  const chromeStub = {
    runtime: {
      connect: () => ({
        onMessage: { addListener: (fn: (raw: unknown) => void) => listeners.push(fn) },
        onDisconnect: noopEvent,
        postMessage: (message: SidePanelToBackgroundMessage) => sent.push(message),
        disconnect: () => undefined,
      }),
      openOptionsPage: async () => {
        harness.optionsOpened += 1;
      },
    },
    tabs: {
      getCurrent: async () => undefined,
      query: async () => [current.activeTab],
      onActivated: noopEvent,
      onUpdated: noopEvent,
    },
    storage: {
      local: { get: async () => ({}), set: async () => undefined },
      session: {
        get: async (keys: string | string[]) => {
          const wanted = typeof keys === 'string' ? [keys] : keys;
          return Object.fromEntries(
            Object.entries(sessionItems).filter(([key]) => wanted.includes(key)),
          );
        },
      },
      onChanged: noopEvent,
    },
    sidePanel: { close: async () => undefined },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = chromeStub;

  const root = document.createElement('main');
  document.body.append(root);
  const elements = mountSidePanel(root);
  startSidePanel(elements);
  await flush();
  const deliver = (message: BackgroundToSidePanelMessage): void => {
    for (const listener of listeners) listener(message);
  };
  deliver({ kind: 'panel-ready' });
  return {
    elements,
    sent,
    deliver,
    switchTo(tab, extraSessionItems = {}) {
      current.activeTab = tab ?? current.activeTab;
      Object.assign(sessionItems, extraSessionItems);
    },
    get optionsOpened() {
      return harness.optionsOpened;
    },
  };
}

describe('Side Panel shell', () => {
  beforeEach(() => {
    document.body.textContent = '';
  });

  it('leaves branding to Chrome and exposes the accessible combined composer controls', () => {
    const root = document.createElement('main');
    const elements = mountSidePanel(root);

    expect(root.querySelector('.za-topbar')).toBeNull();
    expect(root.textContent).not.toContain('电商智能体');
    expect(elements.action.getAttribute('aria-label')).toBe('发送消息');
    expect(elements.action.querySelector('.za-stop-icon')).not.toBeNull();
    expect(elements.upload.getAttribute('aria-label')).toBe('上传知识文档');
  });
});

describe('面板「本页生效」块（A-UX-02 / A-UX-03）', () => {
  beforeEach(() => {
    document.body.textContent = '';
  });

  it('展开即向 background 取数（面板不持有会话与令牌，U7 客户端零判定）', async () => {
    const { elements, sent } = await startPanel();
    expect(sent.some((message) => message.kind === 'injection-request')).toBe(false);
    elements.pageEffect.open = true;
    elements.pageEffect.dispatchEvent(new Event('toggle'));
    await flush();
    expect(sent.filter((message) => message.kind === 'injection-request')).toHaveLength(1);
  });

  it('本机确实跳过了本页激活：块内改给客户端自述，不再向 background 取数（否则拿回的 base-only 会误导归因）', async () => {
    const { elements, sent } = await startPanel({
      activeTab: { id: 11, windowId: 1, groupId: 7, url: 'https://bank.example/accounts', title: '账户总览' },
      sessionItems: { [panelGroupKey(1)]: 7, [siteDeniedSkipKey(11)]: true },
    });
    elements.pageEffect.open = true;
    elements.pageEffect.dispatchEvent(new Event('toggle'));
    await flush();
    const text = elements.pageEffectBody.textContent ?? '';
    expect(text).toContain('不辅助');
    expect(text).toContain('配置中心');
    // 只陈述当下与此后：拉黑前该页可能早已激活并上报过，任何「没有激活过/没有上报过」都是假话。
    expect(text).not.toContain('没有激活');
    expect(text).not.toContain('没有把本页地址上报');
    // 也不冒充服务端那条「已见过该页、按 site-denied 装配」的结论。
    expect(text).not.toContain('本轮不装配任何站点包');
    expect(sent.some((message) => message.kind === 'injection-request')).toBe(false);
  });

  it('本页在名单内但本机并未跳过激活（拉黑前已激活）：仍照常取数，不用自述顶掉服务端抬头', async () => {
    const { elements, sent, deliver } = await startPanel({
      activeTab: { id: 11, windowId: 1, groupId: 7, url: 'https://bank.example/accounts', title: '账户总览' },
    });
    elements.pageEffect.open = true;
    elements.pageEffect.dispatchEvent(new Event('toggle'));
    await flush();
    expect(sent.filter((message) => message.kind === 'injection-request')).toHaveLength(1);
    deliver({
      kind: 'injection-result',
      ok: true,
      description: {
        snapshotVersion: 'v1', packId: null, featureId: null, blocks: [], toolIds: [], reason: 'site-denied',
      },
    });
    await flush();
    expect(elements.pageEffectBody.textContent ?? '').toContain('本轮不装配任何站点包');
  });

  it('未跳过激活的普通页：照常取数（对照：自述只由跳过事实驱动）', async () => {
    const { elements, sent } = await startPanel({
      activeTab: { id: 12, windowId: 1, groupId: 7, url: 'https://shop.example/orders', title: '订单' },
    });
    elements.pageEffect.open = true;
    elements.pageEffect.dispatchEvent(new Event('toggle'));
    await flush();
    expect(sent.filter((message) => message.kind === 'injection-request')).toHaveLength(1);
  });

  it('取数成功后逐行渲染服务端描述，并附「本块不含内建工具」的限定说明', async () => {
    const { elements, deliver } = await startPanel();
    elements.pageEffect.open = true;
    elements.pageEffect.dispatchEvent(new Event('toggle'));
    await flush();
    deliver({
      kind: 'injection-result',
      ok: true,
      description: {
        snapshotVersion: '1.0.0',
        packId: 'shop',
        featureId: 'order-list',
        blocks: [],
        toolIds: ['shop.list'],
        packName: '示例商店',
        packVersion: '1.2.0',
        packSource: 'official',
        featureTitle: '订单处理',
        reason: 'pack',
      },
    });
    await flush();
    const text = elements.pageEffectBody.textContent ?? '';
    expect(text).toContain('示例商店');
    expect(text).toContain('v1.2.0');
    expect(text).toContain('订单处理');
    expect(text).toContain('1 项');
    expect(text).toContain('不在此列');
  });

  it('取数失败只呈现人读原因，不残留上一次结果', async () => {
    const { elements, deliver } = await startPanel();
    elements.pageEffect.open = true;
    elements.pageEffect.dispatchEvent(new Event('toggle'));
    await flush();
    deliver({ kind: 'injection-result', ok: false, error: '无法连接服务端，请检查网络后重试' });
    await flush();
    expect(elements.pageEffectBody.textContent).toContain('无法连接服务端');
  });

  it('图标/右键入口在跳过激活的页上打开面板：给出自述而非「点图标创建任务组」的建组引导', async () => {
    const { elements } = await startPanel({
      activeTab: { id: 11, windowId: 1, groupId: -1, url: 'https://bank.example/accounts', title: '账户总览' },
      sessionItems: { [siteDeniedSkipKey(11)]: true },
    });
    await flush();
    await flush();
    expect(elements.contextDetail.textContent ?? '').not.toContain('创建任务组');
    expect(elements.contextDetail.textContent ?? '').toContain('不辅助');
  });

  it('窗口里有遗留任务组时，跳过激活的页仍给自述、不绑那个组', async () => {
    const { elements, sent } = await startPanel({
      activeTab: { id: 11, windowId: 1, groupId: -1, url: 'https://bank.example/accounts', title: '账户总览' },
      sessionItems: { [panelGroupKey(1)]: 7, [siteDeniedSkipKey(11)]: true },
    });
    await flush();
    await flush();
    expect(elements.contextDetail.textContent ?? '').toContain('不辅助');
    expect(sent.some((message) => message.kind === 'panel-bind')).toBe(false);
  });

  it('未跳过激活且无任务组：仍给建组引导（对照）', async () => {
    const { elements } = await startPanel({
      activeTab: { id: 12, windowId: 1, groupId: -1, url: 'https://shop.example/orders', title: '订单' },
      sessionItems: {},
    });
    await flush();
    await flush();
    expect(elements.contextDetail.textContent ?? '').toContain('创建任务组');
  });

  it('块内「打开配置中心」入口调用 openOptionsPage（A-UX-03）', async () => {
    const harness = await startPanel();
    harness.elements.configCenter.click();
    await flush();
    expect(harness.optionsOpened).toBe(1);
  });
});

describe('面板抬头与「跳过激活」事实（N2-COPY-01）', () => {
  beforeEach(() => {
    document.body.textContent = '';
  });

  it('绑组之后切到跳过激活的页：抬头改给客户端自述，不冒充「已连接的任务页面」', async () => {
    const harness = await startPanel();
    harness.switchTo(
      { id: 11, windowId: 1, groupId: 7, url: 'https://bank.example/accounts', title: '账户总览' },
      { [siteDeniedSkipKey(11)]: true },
    );
    harness.deliver({
      kind: 'task-context',
      groupId: 7,
      authorized: true,
      url: 'https://bank.example/accounts',
      title: '账户总览',
    });
    await flush();

    expect(harness.elements.context.dataset['state']).not.toBe('ready');
    expect(harness.elements.contextDetail.textContent ?? '').toContain('不辅助');
    expect(harness.elements.contextDetail.textContent ?? '').not.toContain('https://bank.example/accounts');
    expect(harness.elements.contextTitle.textContent ?? '').not.toContain('账户总览');
  });

  it('切回未跳过的页：抬头照常回到服务端上下文（对照：自述只由跳过事实驱动）', async () => {
    const harness = await startPanel();
    harness.deliver({
      kind: 'task-context',
      groupId: 7,
      authorized: true,
      url: 'https://shop.example/orders',
      title: '订单',
    });
    await flush();

    expect(harness.elements.context.dataset['state']).toBe('ready');
    expect(harness.elements.contextTitle.textContent).toBe('订单');
    expect(harness.elements.contextDetail.textContent).toBe('https://shop.example/orders');
  });
});

describe('客户端自述文案的承诺范围', () => {
  it('只承诺「不再自动上报本页信息」与「不在本页执行下发的操作指令」，不承诺「不做任何操作」', () => {
    expect(SITE_DENIED_CLIENT_NOTICE).toContain('不再自动向服务端发送本页信息');
    expect(SITE_DENIED_CLIENT_NOTICE).toContain('不在本页执行下发的操作指令');
    expect(SITE_DENIED_CLIENT_NOTICE).not.toContain('任何操作');
  });

  // D-1 裁定「存储读失败那一轮 fail-open」：后果必须让用户看得到，不能只写在开发文档里。
  it('写明配置读取失败的那一轮会退回照常处理（N2-COPY-04）', () => {
    expect(SITE_DENIED_CLIENT_NOTICE).toContain('配置读取失败');
    expect(SITE_DENIED_CLIENT_NOTICE).toContain('照常');
  });

  it('写明闸门拦不住的两件事：主动发送仍上行、本页仍可能被导航走', () => {
    // 右键「用 Zen 讲解选中内容」把本页正文灌进输入框，用户按发送即以 origin=null 上行，闸门不拦。
    expect(SITE_DENIED_CLIENT_NOTICE).toContain('主动发送');
    expect(SITE_DENIED_CLIENT_NOTICE).toContain('仍会上行');
    expect(SITE_DENIED_CLIENT_NOTICE).toContain('导航');
  });
});

describe('右键「用 Zen 讲解选中内容」落到输入框（S4 选区入口）', () => {
  beforeEach(() => {
    document.body.textContent = '';
  });

  it('选区以带「页面选区」标记的引用块进入输入框，并保留原有草稿', async () => {
    const { elements, deliver } = await startPanel();
    elements.input.value = '帮我看看';
    elements.input.dispatchEvent(new Event('input'));
    deliver({ kind: 'compose-quote', text: '七日无理由退货' });
    await flush();
    expect(elements.input.value).toContain('页面选区');
    expect(elements.input.value).toContain('> 七日无理由退货');
    expect(elements.input.value).toContain('帮我看看');
  });

  it('多行选区逐行加引用前缀（边界）', async () => {
    const { elements, deliver } = await startPanel();
    deliver({ kind: 'compose-quote', text: '第一行\n第二行' });
    await flush();
    expect(elements.input.value).toContain('> 第一行\n> 第二行');
  });
});
