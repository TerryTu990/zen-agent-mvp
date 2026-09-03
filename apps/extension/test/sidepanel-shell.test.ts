// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type { BackgroundToSidePanelMessage, SidePanelToBackgroundMessage } from '../src/messaging.js';
import { mountSidePanel, startSidePanel, type SidePanelElements } from '../src/sidepanel.js';

interface PanelHarness {
  elements: SidePanelElements;
  sent: SidePanelToBackgroundMessage[];
  optionsOpened: number;
  deliver(message: BackgroundToSidePanelMessage): void;
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

/** 以最小 chrome 桩驱动真实面板：绑定任务组 → 建端口 → 收 panel-ready，落到可提交状态。 */
async function startPanel(): Promise<PanelHarness> {
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
      query: async () => [{ windowId: 1, groupId: 7, url: 'https://example.com', title: '页面' }],
      onActivated: noopEvent,
      onUpdated: noopEvent,
    },
    storage: {
      local: { get: async () => ({}), set: async () => undefined },
      session: { get: async () => ({ 'za.panelGroup.1': 7 }) },
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

  it('块内「打开配置中心」入口调用 openOptionsPage（A-UX-03）', async () => {
    const harness = await startPanel();
    harness.elements.configCenter.click();
    await flush();
    expect(harness.optionsOpened).toBe(1);
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
