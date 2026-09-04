/**
 * 快捷提问在 background 上的两个入口（R-5）：面板 chips 取数与右键菜单派生共用同一份清单。
 * 判据分三组：合并投影确实来自 /v1/packs + /v1/user-config、右键项由同一份清单派生并把点击
 * 送回面板、命中站点黑名单的页连会话都不建且右键项一个不留。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { sessionKeyForGroup, zenGroupKey } from '../src/activation.js';
import type { UserMessageFrame } from '../src/frames.js';
import {
  BASE_URL,
  disposeHarnesses,
  loadBackground,
  settle,
  SESSION_ID,
  type FakeTab,
  type Served,
  type ServedRequest,
} from './support/background-harness.js';

const GROUP_ID = 7;
const WINDOW_ID = 1;
const PAGE_URL = 'https://shop.example/orders';
const DENIED_ENTRY = 'https://bank.example';
const DENIED_URL = 'https://bank.example/accounts';

const tab: FakeTab = { id: 12, url: PAGE_URL, title: '订单', groupId: GROUP_ID, windowId: WINDOW_ID };
const deniedTab: FakeTab = { id: 11, url: DENIED_URL, title: '账户', groupId: GROUP_ID, windowId: WINDOW_ID };

const mappedGroup: Record<string, unknown> = {
  [sessionKeyForGroup(GROUP_ID)]: SESSION_ID,
  [zenGroupKey(GROUP_ID)]: true,
};

const INJECTION = { packId: 'shop', featureId: 'orders', toolIds: [], blocks: [], snapshotVersion: '1' };

const PACKS = {
  packs: [
    {
      packId: 'shop',
      quickActions: [
        { id: 'explain-selection', label: '解释选中内容', template: '请解释 {{selection}}', context: 'selection' },
        { id: 'summarize-page', label: '总结本页', template: '请总结 {{url}}', context: 'page' },
      ],
    },
  ],
};

const USER_CONFIG = {
  overlay: {
    packs: {
      '*': {
        quickActions: [{ id: 'my-note', label: '记一笔', template: '记一笔', context: 'none' }],
        disabledQuickActions: ['summarize-page'],
      },
    },
  },
};

/** 本组用例额外要用的三个只读端点；其余一律回 null 交回 harness 的默认应答（含事件流握手公钥）。 */
function serveQuickActions(request: ServedRequest): Served | null {
  if (request.url === `${BASE_URL}/v1/sessions/${SESSION_ID}/injection`) {
    return { status: 200, body: INJECTION };
  }
  if (request.url === `${BASE_URL}/v1/packs`) return { status: 200, body: PACKS };
  if (request.url === `${BASE_URL}/v1/user-config`) return { status: 200, body: USER_CONFIG };
  return null;
}

afterEach(disposeHarnesses);

async function panelWithQuickActions(options: { denylist?: string[]; tabs?: FakeTab[] } = {}) {
  const h = await loadBackground({
    tabs: options.tabs ?? [tab],
    storageSession: mappedGroup,
    ...(options.denylist !== undefined ? { denylist: options.denylist } : {}),
    serve: serveQuickActions,
  });
  return h;
}

describe('面板 chips 取数（quick-actions-request）', () => {
  it('合并 L1 声明与 L2 覆盖层后回投影：停用条目不在其中，模板不下发', async () => {
    const h = await panelWithQuickActions();
    const panel = h.connectPanel(GROUP_ID);
    panel.emit({ kind: 'quick-actions-request', siteDenied: false });
    await settle();
    const reply = panel.received.find(
      (message) => (message as { kind?: string }).kind === 'quick-actions',
    ) as { actions: Array<{ id: string; label: string }> } | undefined;
    expect(reply?.actions.map((action) => action.id)).toEqual(['explain-selection', 'my-note']);
    for (const action of reply?.actions ?? []) expect(action).not.toHaveProperty('template');
  });

  it('右键菜单由同一份清单派生：只 selection 类进菜单', async () => {
    const h = await panelWithQuickActions();
    const panel = h.connectPanel(GROUP_ID);
    panel.emit({ kind: 'quick-actions-request', siteDenied: false });
    await settle();
    expect(h.menus.map((item) => ({ id: item.id, title: item.title, contexts: item.contexts }))).toEqual([
      { id: 'za-qa:explain-selection', title: '解释选中内容', contexts: ['selection'] },
    ]);
  });

  it('点右键项 → 面板收到 compose-quick-action（带 id、标题与选区正文）', async () => {
    const h = await panelWithQuickActions();
    const panel = h.connectPanel(GROUP_ID);
    panel.emit({ kind: 'quick-actions-request', siteDenied: false });
    await settle();
    h.emitContextMenuClick({ menuItemId: 'za-qa:explain-selection', selectionText: '  这段话  ' }, tab);
    await settle();
    expect(panel.received).toContainEqual({
      kind: 'compose-quick-action',
      actionId: 'explain-selection',
      label: '解释选中内容',
      selectionText: '这段话',
    });
  });
});

describe('站点黑名单命中页', () => {
  it('连会话都不建，清单为空且右键项一个不留（快捷动作属激活后能力）', async () => {
    const h = await loadBackground({
      denylist: [DENIED_ENTRY],
      tabs: [deniedTab],
      storageSession: {},
      serve: serveQuickActions,
    });
    const panel = h.connectPanel(GROUP_ID);
    panel.emit({ kind: 'quick-actions-request', siteDenied: true });
    await settle();
    expect(h.requests.some((request) => request.url === `${BASE_URL}/v1/sessions`)).toBe(false);
    expect(panel.received).toContainEqual({ kind: 'quick-actions', actions: [] });
    expect(h.menus).toEqual([]);
  });

  it('切到命中页时把已注册的右键项撤掉（右键菜单是全局的，不随页面自动消失）', async () => {
    const h = await loadBackground({
      denylist: [DENIED_ENTRY],
      tabs: [tab, deniedTab],
      storageSession: mappedGroup,
      serve: serveQuickActions,
    });
    const panel = h.connectPanel(GROUP_ID);
    panel.emit({ kind: 'quick-actions-request', siteDenied: false });
    await settle();
    expect(h.menus).toHaveLength(1);
    h.emitMessage({ kind: 'request-activate', autoActivate: false }, deniedTab);
    await settle();
    expect(h.menus).toEqual([]);
  });
});

describe('快捷提问的上行帧', () => {
  it('面板只发 id 与选区正文，text 是「服务端查不到时的原文」', async () => {
    const h = await panelWithQuickActions();
    const panel = h.connectPanel(GROUP_ID);
    panel.emit({
      kind: 'user-message',
      messageId: 'm-quickaction-1',
      text: '解释选中内容',
      executionPreference: 'auto',
      quickActionId: 'explain-selection',
      selectionText: '这段话',
    });
    await settle();
    const frame = h.upstream().find((f) => f.type === 'user-message') as UserMessageFrame | undefined;
    expect(frame?.quickActionId).toBe('explain-selection');
    expect(frame?.selectionText).toBe('这段话');
    expect(frame?.text).toBe('解释选中内容');
  });
});
