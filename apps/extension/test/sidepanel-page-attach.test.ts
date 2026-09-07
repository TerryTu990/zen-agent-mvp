// @vitest-environment jsdom
/**
 * 面板上的未接入页面信号区（adr-027 §4 当初接受的「注入失败对用户零信号」在此收口）。
 * 判据：已接入的页不占位、未接入的页逐条给出本机可答的原因、能重试的才给按钮、
 * 点按钮先在用户手势内问站点权限再请求补接入、补接入失败如实呈现。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { panelGroupKey } from '../src/activation.js';
import type { BackgroundToSidePanelMessage, SidePanelToBackgroundMessage } from '../src/messaging.js';
import { mountSidePanel, startSidePanel, type SidePanelElements } from '../src/sidepanel.js';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

interface PanelHarness {
  elements: SidePanelElements;
  sent: SidePanelToBackgroundMessage[];
  permissionRequests: Array<{ origins?: string[] }>;
  deliver(message: BackgroundToSidePanelMessage): void;
}

async function startPanel(): Promise<PanelHarness> {
  const activeTab = { id: 5, windowId: 1, groupId: 7, url: 'https://shop.example/orders', title: '订单' };
  const sent: SidePanelToBackgroundMessage[] = [];
  const permissionRequests: Array<{ origins?: string[] }> = [];
  const listeners: ((raw: unknown) => void)[] = [];
  const noopEvent = { addListener: () => undefined };
  (globalThis as unknown as { chrome: unknown }).chrome = {
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
    permissions: {
      request: async (descriptor: { origins?: string[] }) => {
        permissionRequests.push(descriptor);
        return true;
      },
    },
    storage: {
      local: { get: async () => ({}), set: async () => undefined },
      session: { get: async () => ({ [panelGroupKey(1)]: 7 }) },
      onChanged: noopEvent,
    },
    sidePanel: { close: async () => undefined },
  };

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
  return { elements, sent, permissionRequests, deliver };
}

const UNAUTHORIZED_PAGE = {
  tabId: 12,
  url: 'https://article.example/post/1',
  title: '一篇文章',
  status: 'silent' as const,
  reason: 'permission' as const,
};

function rowTexts(elements: SidePanelElements): string[] {
  return [...elements.pages.querySelectorAll('[data-za-page-row]')].map((row) => row.textContent ?? '');
}

describe('未接入页面的信号区', () => {
  beforeEach(() => {
    document.body.textContent = '';
  });

  it('每一页都接上时整块不占位', async () => {
    const { elements, deliver } = await startPanel();
    deliver({
      kind: 'group-page-status',
      pages: [{ tabId: 5, url: 'https://shop.example/orders', status: 'active' }],
    });
    expect(elements.pages.hidden).toBe(true);
    expect(rowTexts(elements)).toEqual([]);
  });

  it('未接入的页给出原因，可重试的才带补接入按钮', async () => {
    const { elements, deliver } = await startPanel();
    deliver({
      kind: 'group-page-status',
      pages: [
        { tabId: 5, url: 'https://shop.example/orders', status: 'active' },
        UNAUTHORIZED_PAGE,
        { tabId: 13, url: 'chrome://newtab/', status: 'silent', reason: 'restricted' },
      ],
    });
    expect(elements.pages.hidden).toBe(false);
    const rows = rowTexts(elements);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('尚未取得该站点的访问权限');
    expect(rows[0]).toContain('让 Zen 接入这一页');
    expect(rows[1]).toContain('浏览器不允许在这类页面接入');
    // 浏览器硬限制按了也只会再失败一次，不给必然无效的入口。
    expect(elements.pages.querySelector('[data-za-page-attach="13"]')).toBeNull();
  });

  it('点补接入：先在用户手势内问该站点的访问权限，再请求 background 重试注入', async () => {
    const { elements, sent, permissionRequests, deliver } = await startPanel();
    deliver({ kind: 'group-page-status', pages: [UNAUTHORIZED_PAGE] });
    elements.pages.querySelector<HTMLButtonElement>('[data-za-page-attach="12"]')?.click();
    await flush();
    expect(permissionRequests).toEqual([{ origins: ['https://article.example/*'] }]);
    expect(sent).toContainEqual({ kind: 'attach-page', tabId: 12 });
  });

  it('补接入仍未成功：如实呈现，不说成已接入', async () => {
    const { elements, deliver } = await startPanel();
    deliver({ kind: 'group-page-status', pages: [UNAUTHORIZED_PAGE] });
    deliver({ kind: 'attach-page-result', tabId: 12, ok: false });
    expect(elements.composerNotice.textContent).toContain('仍未接入');
    deliver({ kind: 'attach-page-result', tabId: 12, ok: true });
    expect(elements.composerNotice.textContent).toBe('已接入这一页');
  });
});
