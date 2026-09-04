// @vitest-environment jsdom
/**
 * 面板上的快捷提问 chips（R-5）：清单只来自 background 的合并投影，点击只发 quickActionId。
 * 判据：selection 类不进 chips（面板取不到页面选区）、本机跳过激活的页连取数请求都不发、
 * 点击发出的上行消息里没有模板（客户端不持第二份副本）、首条消息受理后按本页装配面收窄一次。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { panelGroupKey } from '../src/activation.js';
import type { BackgroundToSidePanelMessage, SidePanelToBackgroundMessage } from '../src/messaging.js';
import { siteDeniedSkipKey } from '../src/site-denylist.js';
import { mountSidePanel, startSidePanel, type SidePanelElements } from '../src/sidepanel.js';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

interface PanelOptions {
  sessionItems?: Record<string, unknown>;
  activeTab?: { id: number; windowId: number; groupId: number; url: string; title: string };
}

interface PanelHarness {
  elements: SidePanelElements;
  sent: SidePanelToBackgroundMessage[];
  deliver(message: BackgroundToSidePanelMessage): void;
}

async function startPanel(options: PanelOptions = {}): Promise<PanelHarness> {
  const activeTab = options.activeTab ?? { id: 5, windowId: 1, groupId: 7, url: 'https://shop.example', title: '订单' };
  const sessionItems: Record<string, unknown> = options.sessionItems ?? { [panelGroupKey(1)]: 7 };
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
      openOptionsPage: async () => undefined,
    },
    tabs: {
      getCurrent: async () => undefined,
      query: async () => [activeTab],
      onActivated: noopEvent,
      onUpdated: noopEvent,
    },
    storage: {
      local: { get: async () => ({}), set: async () => undefined },
      session: {
        get: async (keys: string | string[]) => {
          const wanted = typeof keys === 'string' ? [keys] : keys;
          return Object.fromEntries(Object.entries(sessionItems).filter(([key]) => wanted.includes(key)));
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
  await flush();
  return { elements, sent, deliver };
}

const ACTIONS = [
  { id: 'explain-selection', label: '解释选中内容', context: 'selection' as const },
  { id: 'summarize-page', label: '总结本页', context: 'page' as const },
  { id: 'my-note', label: '记一笔', context: 'none' as const },
];

function chipLabels(elements: SidePanelElements): string[] {
  return [...elements.quickActions.querySelectorAll('button')].map((chip) => chip.textContent ?? '');
}

describe('快捷提问 chips', () => {
  beforeEach(() => {
    document.body.textContent = '';
  });

  it('面板就绪即取数（面板不持有会话与令牌）', async () => {
    const { sent } = await startPanel();
    expect(sent).toContainEqual({ kind: 'quick-actions-request', siteDenied: false });
  });

  it('清单为空时整条不占位', async () => {
    const { elements, deliver } = await startPanel();
    deliver({ kind: 'quick-actions', actions: [] });
    expect(elements.quickActions.hidden).toBe(true);
    expect(chipLabels(elements)).toEqual([]);
  });

  it('只呈现材料在面板侧齐备的条目：selection 类归右键菜单', async () => {
    const { elements, deliver } = await startPanel();
    deliver({ kind: 'quick-actions', actions: ACTIONS });
    expect(elements.quickActions.hidden).toBe(false);
    expect(chipLabels(elements)).toEqual(['总结本页', '记一笔']);
  });

  it('点 chip 只发 id：上行消息里没有模板，text 是查不到时的原文', async () => {
    const { elements, sent, deliver } = await startPanel();
    deliver({ kind: 'quick-actions', actions: ACTIONS });
    elements.quickActions.querySelector<HTMLButtonElement>('[data-za-quick-action="summarize-page"]')?.click();
    await flush();
    const message = sent.find((entry) => entry.kind === 'user-message');
    expect(message).toMatchObject({ quickActionId: 'summarize-page', text: '总结本页' });
    expect(message).not.toHaveProperty('template');
  });

  it('右键选中的快捷提问按普通消息路径发出，带上选区正文', async () => {
    const { sent, deliver } = await startPanel();
    deliver({
      kind: 'compose-quick-action',
      actionId: 'explain-selection',
      label: '解释选中内容',
      selectionText: '这段话',
    });
    await flush();
    expect(sent.find((entry) => entry.kind === 'user-message')).toMatchObject({
      quickActionId: 'explain-selection',
      selectionText: '这段话',
      text: '解释选中内容',
    });
  });

  it('首条消息被受理后重取一次 chips：此刻会话才建立，清单可按本页 packId 收窄', async () => {
    const { elements, sent, deliver } = await startPanel();
    deliver({ kind: 'quick-actions', actions: ACTIONS });
    elements.quickActions.querySelector<HTMLButtonElement>('[data-za-quick-action="summarize-page"]')?.click();
    await flush();
    const sentMessage = sent.find((entry) => entry.kind === 'user-message');
    const messageId = (sentMessage as { messageId: string }).messageId;
    const requests = (): number => sent.filter((entry) => entry.kind === 'quick-actions-request').length;
    const before = requests();
    deliver({ kind: 'message-result', messageId, accepted: true });
    await flush();
    expect(requests()).toBe(before + 1);
    // 只在首条受理后重取：其后每条消息都重取会让每轮对话多两次投影拉取。
    deliver({ kind: 'message-result', messageId, accepted: true });
    await flush();
    expect(requests()).toBe(before + 1);
  });

  it('本机确实跳过了本页激活：面板不绑组、一条 chip 都不出现（右键项由 background 撤）', async () => {
    const { elements, sent } = await startPanel({
      activeTab: { id: 11, windowId: 1, groupId: 7, url: 'https://bank.example/accounts', title: '账户' },
      sessionItems: { [panelGroupKey(1)]: 7, [siteDeniedSkipKey(11)]: true },
    });
    // 命中页的面板压根不绑组、不连端口：连取数请求都发不出去，更不会因为一排 chips 建出会话。
    expect(sent).toEqual([]);
    expect(elements.quickActions.hidden).toBe(true);
    expect(chipLabels(elements)).toEqual([]);
  });
});
