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

describe('面板状态与用户须知载体（D4：顶部上下文块已撤，状态迁到面板根）', () => {
  beforeEach(() => {
    document.body.textContent = '';
  });

  it('顶部不再有页面上下文块：状态与任务组挂在面板根上', async () => {
    const { elements } = await startPanel();
    await flush();
    await flush();
    expect(document.querySelector('[data-za-context]')).toBeNull();
    expect(document.querySelector('[data-za-page-effect]')).toBeNull();
    expect(elements.shell.dataset['zaShell']).toBe('');
    expect(elements.shell.dataset['groupId']).toBe('7');
  });

  it('不再向 background 取注入自省（该消息种类已撤）', async () => {
    const { sent } = await startPanel();
    await flush();
    await flush();
    expect(sent.map((message) => message.kind)).not.toContain('injection-request');
  });

  it('本机确实跳过了本页激活：面板根 denied，composer notice 给客户端自述', async () => {
    const { elements } = await startPanel({
      activeTab: { id: 11, windowId: 1, groupId: 7, url: 'https://bank.example/accounts', title: '账户总览' },
      sessionItems: { [panelGroupKey(1)]: 7, [siteDeniedSkipKey(11)]: true },
    });
    await flush();
    await flush();
    expect(elements.shell.dataset['state']).toBe('denied');
    const text = elements.composerNotice.textContent ?? '';
    expect(text).toContain('不辅助的站点');
    expect(text).toContain('配置中心');
    // 只陈述当下与此后：拉黑前该页可能早已激活并上报过，任何「没有激活过/没有上报过」都是假话。
    expect(text).not.toContain('没有激活');
  });

  it('图标/右键入口在跳过激活的页上打开面板：给出自述而非「点图标创建任务组」的建组引导', async () => {
    const { elements } = await startPanel({
      activeTab: { id: 11, windowId: 1, groupId: -1, url: 'https://bank.example/accounts', title: '账户总览' },
      sessionItems: { [siteDeniedSkipKey(11)]: true },
    });
    await flush();
    await flush();
    expect(elements.composerNotice.textContent ?? '').not.toContain('创建任务组');
    expect(elements.composerNotice.textContent ?? '').toContain('不辅助的站点');
  });

  it('窗口里有遗留任务组时，跳过激活的页仍给自述、不绑那个组', async () => {
    const { elements, sent } = await startPanel({
      activeTab: { id: 11, windowId: 1, groupId: -1, url: 'https://bank.example/accounts', title: '账户总览' },
      sessionItems: { [panelGroupKey(1)]: 7, [siteDeniedSkipKey(11)]: true },
    });
    await flush();
    await flush();
    expect(elements.composerNotice.textContent ?? '').toContain('不辅助的站点');
    expect(sent.some((message) => message.kind === 'panel-bind')).toBe(false);
  });

  it('未跳过激活且无任务组：仍给建组引导（对照）', async () => {
    const { elements } = await startPanel({
      activeTab: { id: 12, windowId: 1, groupId: -1, url: 'https://shop.example/orders', title: '订单' },
      sessionItems: {},
    });
    await flush();
    await flush();
    expect(elements.composerNotice.textContent ?? '').toContain('创建任务组');
  });

  it('composer 操作行的齿轮按钮调用 openOptionsPage（A-UX-03 入口保留）', async () => {
    const harness = await startPanel();
    expect(harness.elements.configCenter.closest('.za-composer-actions')).not.toBeNull();
    expect(harness.elements.configCenter.getAttribute('aria-label')).toBe('打开配置中心');
    expect(harness.elements.configCenter.dataset['zaConfigCenter']).toBe('');
    harness.elements.configCenter.click();
    await flush();
    expect(harness.optionsOpened).toBe(1);
  });
});

describe('面板状态与「跳过激活」事实（N2-COPY-01）', () => {
  beforeEach(() => {
    document.body.textContent = '';
  });

  it('绑组之后切到跳过激活的页：状态落 denied、不冒充「已连接的任务页面」', async () => {
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

    expect(harness.elements.shell.dataset['state']).toBe('denied');
    const text = harness.elements.composerNotice.textContent ?? '';
    expect(text).toContain('不辅助的站点');
    expect(text).not.toContain('https://bank.example/accounts');
    expect(text).not.toContain('账户总览');
  });

  it('切回未跳过的页：状态回 ready，且不占 composer notice（对照）', async () => {
    const harness = await startPanel();
    harness.deliver({
      kind: 'task-context',
      groupId: 7,
      authorized: true,
      url: 'https://shop.example/orders',
      title: '订单',
    });
    await flush();

    expect(harness.elements.shell.dataset['state']).toBe('ready');
    expect(harness.elements.composerNotice.textContent).toBe('');
  });

  it('组外页面：状态 outside，composer notice 给一句须知', async () => {
    const harness = await startPanel();
    harness.deliver({ kind: 'task-context', groupId: 9, authorized: false, url: 'https://other.example/' });
    await flush();

    expect(harness.elements.shell.dataset['state']).toBe('outside');
    expect(harness.elements.composerNotice.textContent).toBe('当前页面不在任务组内');
  });

  it('操作反馈压过状态须知，且不被后续同态上下文更新抹掉', async () => {
    const harness = await startPanel();
    harness.deliver({ kind: 'task-context', groupId: 9, authorized: false, url: 'https://other.example/' });
    await flush();
    harness.deliver({ kind: 'hitl-result', hitlId: 'h1', accepted: false });
    expect(harness.elements.composerNotice.textContent).toContain('确认结果未送达');

    harness.deliver({ kind: 'task-context', groupId: 9, authorized: false, url: 'https://other.example/next' });
    await flush();
    expect(harness.elements.composerNotice.textContent).toContain('确认结果未送达');
  });

  it('状态迁移清掉陈旧操作反馈：切到跳过激活的页必须看到客户端自述', async () => {
    const harness = await startPanel();
    harness.deliver({
      kind: 'task-context',
      groupId: 7,
      authorized: true,
      url: 'https://shop.example/orders',
      title: '订单',
    });
    await flush();
    harness.deliver({ kind: 'hitl-result', hitlId: 'h1', accepted: false });
    expect(harness.elements.composerNotice.textContent).toContain('确认结果未送达');

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

    expect(harness.elements.shell.dataset['state']).toBe('denied');
    expect(harness.elements.composerNotice.textContent).toBe(SITE_DENIED_CLIENT_NOTICE);
  });

  it('状态迁移到组外：陈旧操作反馈同样让位给须知', async () => {
    const harness = await startPanel();
    harness.deliver({
      kind: 'task-context',
      groupId: 7,
      authorized: true,
      url: 'https://shop.example/orders',
      title: '订单',
    });
    await flush();
    harness.deliver({ kind: 'hitl-result', hitlId: 'h1', accepted: false });

    harness.deliver({ kind: 'task-context', groupId: 9, authorized: false, url: 'https://other.example/' });
    await flush();

    expect(harness.elements.composerNotice.textContent).toBe('当前页面不在任务组内');
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
