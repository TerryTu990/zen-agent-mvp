/**
 * 快捷提问在 background 上的两个入口（R-5）：面板 chips 取数与右键菜单派生共用同一份清单。
 * 判据分五组：取数只走两个无会话投影端点（/v1/packs + /v1/user-config，开面板不建会话）、
 * 会话已建立后按注入自省的 packId/featureId 过滤、右键菜单在兜底项之后追加派生项、
 * 命中站点黑名单的页连取数都不发、以及首屏兜底面只在本页可激活时才呈现。
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
    {
      packId: 'generic-web',
      generic: true,
      quickActions: [
        { id: 'explain-anything', label: '讲讲这段', template: '请讲讲 {{selection}}', context: 'selection' },
        { id: 'what-is-this-page', label: '这页是干嘛的', template: '这页 {{url}} 是干嘛的', context: 'page' },
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
        // 本机名单镜像由这一次应答覆写：不带则命中页用例的名单会被照实清空。
        siteDenylist: [DENIED_ENTRY],
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

/** 面板收到的最后一份 chips 投影（无则 undefined）。 */
function lastQuickActions(panel: { received: unknown[] }): Array<{ id: string; label: string }> | undefined {
  const replies = panel.received.filter(
    (message) => (message as { kind?: string }).kind === 'quick-actions',
  ) as Array<{ actions: Array<{ id: string; label: string }> }>;
  return replies[replies.length - 1]?.actions;
}

/** 发一条消息把会话建起来（chips 自身不建会话，故按 packId 过滤须先有会话）。 */
async function openSessionByMessage(panel: { emit(message: unknown): void }): Promise<void> {
  panel.emit({
    kind: 'user-message',
    messageId: 'm-open-session',
    text: '你好',
    executionPreference: 'auto',
  });
  await settle();
}

describe('面板 chips 取数（quick-actions-request）', () => {
  it('尚无会话：只走两个无会话投影端点，一条 POST /v1/sessions 都不发', async () => {
    const h = await loadBackground({
      tabs: [tab],
      storageSession: { [zenGroupKey(GROUP_ID)]: true },
      serve: serveQuickActions,
    });
    const panel = h.connectPanel(GROUP_ID);
    panel.emit({ kind: 'quick-actions-request', siteDenied: false });
    await settle();
    expect(h.requests.some((request) => request.method === 'POST' && request.url === `${BASE_URL}/v1/sessions`)).toBe(false);
    expect(h.requests.some((request) => request.url.endsWith('/injection'))).toBe(false);
    expect(h.requests.some((request) => request.url === `${BASE_URL}/v1/packs`)).toBe(true);
    expect(h.requests.some((request) => request.url === `${BASE_URL}/v1/user-config`)).toBe(true);
  });

  it('尚无会话：首屏 = generic 兜底包声明 + L2 全局作用域（停用条目仍摘除）', async () => {
    const h = await loadBackground({
      tabs: [tab],
      storageSession: { [zenGroupKey(GROUP_ID)]: true },
      serve: serveQuickActions,
    });
    const panel = h.connectPanel(GROUP_ID);
    panel.emit({ kind: 'quick-actions-request', siteDenied: false });
    await settle();
    expect(lastQuickActions(panel)?.map((action) => action.id)).toEqual([
      'explain-anything',
      'what-is-this-page',
      'my-note',
    ]);
    for (const action of lastQuickActions(panel) ?? []) expect(action).not.toHaveProperty('template');
  });

  it('会话已建立：按注入自省的 packId 过滤，停用条目不在其中，模板不下发', async () => {
    const h = await panelWithQuickActions();
    const panel = h.connectPanel(GROUP_ID);
    await openSessionByMessage(panel);
    panel.emit({ kind: 'quick-actions-request', siteDenied: false });
    await settle();
    expect(lastQuickActions(panel)?.map((action) => action.id)).toEqual(['explain-selection', 'my-note']);
    for (const action of lastQuickActions(panel) ?? []) expect(action).not.toHaveProperty('template');
  });

  it('右键菜单：兜底项常驻，派生的 selection 类项追加在其后', async () => {
    const h = await panelWithQuickActions();
    const panel = h.connectPanel(GROUP_ID);
    await openSessionByMessage(panel);
    panel.emit({ kind: 'quick-actions-request', siteDenied: false });
    await settle();
    expect(h.menus.map((item) => ({ id: item.id, title: item.title, contexts: item.contexts }))).toEqual([
      { id: 'za-explain-selection', title: '用 Zen 讲解选中内容', contexts: ['selection'] },
      { id: 'za-qa:explain-selection', title: '解释选中内容', contexts: ['selection'] },
    ]);
  });

  it('本页一条 selection 类快捷提问都没有：右键仍有兜底项', async () => {
    const h = await loadBackground({
      tabs: [tab],
      storageSession: mappedGroup,
      serve: (request) => {
        if (request.url === `${BASE_URL}/v1/packs`) {
          return { status: 200, body: { packs: [{ packId: 'shop', quickActions: [] }] } };
        }
        return serveQuickActions(request);
      },
    });
    const panel = h.connectPanel(GROUP_ID);
    await openSessionByMessage(panel);
    panel.emit({ kind: 'quick-actions-request', siteDenied: false });
    await settle();
    expect(h.menus.map((item) => item.id)).toEqual(['za-explain-selection']);
  });

  it('点右键项 → 面板收到 compose-quick-action（带 id、标题与选区正文）', async () => {
    const h = await panelWithQuickActions();
    const panel = h.connectPanel(GROUP_ID);
    await openSessionByMessage(panel);
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

describe('尚无会话时的首屏兜底面：本页可激活才给', () => {
  /**
   * 兜底包只在有 http/https 来源的页上激活。浏览器内部页永远不产生上下文上报，本轮 packId 恒为空，
   * 呈现的 chip 点下去必然查不到模板——那正是「在新标签页点『总结本页』，agent 答无法总结本页」的来路。
   */
  it('活动页是浏览器内部页：一条 chip 都不给（点下去必然展不开）', async () => {
    const internalTab: FakeTab = { id: 21, url: 'chrome://newtab/', groupId: GROUP_ID, windowId: WINDOW_ID };
    const h = await loadBackground({
      tabs: [internalTab],
      storageSession: { [zenGroupKey(GROUP_ID)]: true },
      serve: serveQuickActions,
    });
    const panel = h.connectPanel(GROUP_ID);
    panel.emit({ kind: 'quick-actions-request', siteDenied: false });
    await settle();
    expect(lastQuickActions(panel)).toEqual([]);
    expect(h.menus.map((item) => item.id)).toEqual(['za-explain-selection']);
  });

  it('组内活动页是 http/https：兜底面照常呈现（对照，收窄只由地址驱动）', async () => {
    const internalTab: FakeTab = {
      id: 21,
      url: 'chrome://newtab/',
      groupId: GROUP_ID,
      windowId: WINDOW_ID,
      active: false,
    };
    const h = await loadBackground({
      tabs: [internalTab, { ...tab, active: true }],
      storageSession: { [zenGroupKey(GROUP_ID)]: true },
      serve: serveQuickActions,
    });
    const panel = h.connectPanel(GROUP_ID);
    panel.emit({ kind: 'quick-actions-request', siteDenied: false });
    await settle();
    expect(lastQuickActions(panel)?.map((action) => action.id)).toEqual([
      'explain-anything',
      'what-is-this-page',
      'my-note',
    ]);
  });
});

describe('站点黑名单命中页', () => {
  it('连取数都不发，清单为空且右键只剩兜底项（快捷动作属激活后能力）', async () => {
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
    expect(h.requests.some((request) => request.url === `${BASE_URL}/v1/packs`)).toBe(false);
    expect(panel.received).toContainEqual({ kind: 'quick-actions', actions: [] });
    expect(h.menus.map((item) => item.id)).toEqual(['za-explain-selection']);
  });

  it('切到命中页时把派生的右键项撤掉（右键菜单是全局的，不随页面自动消失）', async () => {
    const h = await loadBackground({
      denylist: [DENIED_ENTRY],
      tabs: [tab, deniedTab],
      storageSession: mappedGroup,
      serve: serveQuickActions,
    });
    const panel = h.connectPanel(GROUP_ID);
    await openSessionByMessage(panel);
    panel.emit({ kind: 'quick-actions-request', siteDenied: false });
    await settle();
    expect(h.menus).toHaveLength(2);
    h.emitMessage({ kind: 'request-activate' }, deniedTab);
    await settle();
    expect(h.menus.map((item) => item.id)).toEqual(['za-explain-selection']);
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
