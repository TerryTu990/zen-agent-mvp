// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type { BackgroundToSidePanelMessage, SidePanelToBackgroundMessage } from '../src/messaging.js';
import { mountSidePanel, startSidePanel, type SidePanelElements } from '../src/sidepanel.js';

interface PanelHarness {
  elements: SidePanelElements;
  sent: SidePanelToBackgroundMessage[];
  deliver(message: BackgroundToSidePanelMessage): void;
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

const userBubbles = (elements: SidePanelElements): string[] =>
  [...elements.messages.querySelectorAll('.za-msg[data-role="user"] .za-bub')].map((node) => node.textContent ?? '');

/** 以最小 chrome 桩驱动真实面板：绑定任务组 → 建端口 → 收 panel-ready，落到可提交状态。 */
async function startPanel(): Promise<PanelHarness> {
  const sent: SidePanelToBackgroundMessage[] = [];
  const listeners: ((raw: unknown) => void)[] = [];
  const noopEvent = { addListener: () => undefined };
  const chromeStub = {
    runtime: {
      connect: () => ({
        onMessage: { addListener: (fn: (raw: unknown) => void) => listeners.push(fn) },
        onDisconnect: noopEvent,
        postMessage: (message: SidePanelToBackgroundMessage) => sent.push(message),
        disconnect: () => undefined,
      }),
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
  return { elements, sent, deliver };
}

describe('Side Panel 本地即时回显', () => {
  beforeEach(() => {
    document.body.textContent = '';
  });

  it('回车即把消息渲染进对话并清空输入框，不等服务端回声', async () => {
    const { elements, sent } = await startPanel();
    elements.input.value = '帮我下单';
    elements.input.dispatchEvent(new Event('input'));
    elements.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await flush();

    expect(elements.input.value).toBe('');
    expect(userBubbles(elements)).toEqual(['帮我下单']);
    expect(elements.messages.querySelector('.za-thinking')).not.toBeNull();
    expect(sent.some((message) => message.kind === 'user-message' && message.text === '帮我下单')).toBe(true);
  });

  it('服务端回声落定同一个气泡，不产生重复消息', async () => {
    const { elements, sent, deliver } = await startPanel();
    elements.input.value = '查订单';
    elements.input.dispatchEvent(new Event('input'));
    elements.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await flush();
    const message = sent.find((item) => item.kind === 'user-message');
    const messageId = message?.kind === 'user-message' ? message.messageId : '';

    deliver({ kind: 'message-result', messageId, accepted: true });
    deliver({ kind: 'user-echo', text: '查订单', messageId });

    expect(userBubbles(elements)).toEqual(['查订单']);
  });

  it('投递被拒时撤下回显气泡并把草稿还原回输入框', async () => {
    const { elements, sent, deliver } = await startPanel();
    elements.input.value = '改地址';
    elements.input.dispatchEvent(new Event('input'));
    elements.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await flush();
    const message = sent.find((item) => item.kind === 'user-message');
    const messageId = message?.kind === 'user-message' ? message.messageId : '';

    deliver({ kind: 'message-result', messageId, accepted: false, failure: 'unreachable' });

    expect(userBubbles(elements)).toEqual([]);
    expect(elements.input.value).toBe('改地址');
    expect(elements.messages.querySelector('.za-thinking')).toBeNull();
  });

  it('重连重放不含未确认消息时重建气泡，草稿不凭空消失', async () => {
    const { elements, deliver } = await startPanel();
    elements.input.value = '继续';
    elements.input.dispatchEvent(new Event('input'));
    elements.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await flush();

    deliver({ kind: 'history-replay', events: [{ kind: 'user-echo', text: '上一轮' }] });

    expect(userBubbles(elements)).toEqual(['上一轮', '继续']);
  });
});
