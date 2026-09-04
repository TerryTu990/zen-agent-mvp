/**
 * background 的 chrome/fetch 替身与驱动面（测试专用，不参与打包）。
 * 只覆盖被测入口实际触达的 API；未覆盖的调用一律静默失败，避免无关后台拉取干扰断言。
 * 下行帧经真实 SSE 字节流推入，上行帧经真实 fetch 记录：被测的是 background 的完整通路，不是打桩过的分支。
 */
import { vi } from 'vitest';
import type { DownstreamFrame, ExecInstructionFrame, UpstreamFrame } from '../../src/frames.js';
import { SESSION_PORT_NAME, SIDE_PANEL_PORT_NAME } from '../../src/messaging.js';
import { SITE_DENYLIST_KEY } from '../../src/site-denylist.js';

export const BASE_URL = 'http://127.0.0.1:8787';
export const SESSION_ID = 'sess-1';
/** 在任何替身安装之前取到的真实定时器：替身自身用它排期，撤下替身后仍能取消。 */
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
/** 明显的假值：只为让 identity 走缓存命中，不是任何真实凭证。 */
const TOKEN_CANARY = 'fake-anon-token-canary';

export interface FakeTab {
  id: number;
  url: string;
  title?: string;
  groupId: number;
  windowId: number;
  /** 导航已发起但尚未提交：真实 Chrome 此刻 url 为空串，目标地址只在 pendingUrl 上。 */
  pendingUrl?: string;
}

export interface FakePort {
  name: string;
  sender: { tab: { id: number; url: string; windowId: number; groupId: number } };
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(callback: (message: unknown) => void): void };
  onDisconnect: { addListener(callback: () => void): void };
  /** 由测试注入一帧上行消息（content/面板 → background）。 */
  emit(message: unknown): void;
  /** background 回投给该端口的消息。 */
  received: unknown[];
}

export interface ServedRequest {
  url: string;
  method: string;
  body: unknown;
}

export type Served = { status: number; headers?: Record<string, string>; body?: unknown; stream?: boolean };

/** chrome.contextMenus.create 的入参投影：右键入口的注册结果按此断言。 */
export interface ContextMenuItem {
  id: string;
  title: string;
  contexts: string[];
}

export interface Harness {
  local: Record<string, unknown>;
  /** 当前注册着的右键菜单项（removeAll 会清空）。 */
  menus: ContextMenuItem[];
  /** 探针专用：模拟用户点了某个右键菜单项。 */
  emitContextMenuClick(info: { menuItemId: string; selectionText?: string }, tab: FakeTab): void;
  session: Record<string, unknown>;
  tabs: Map<number, FakeTab>;
  /** 收到 {kind:'activate'} 的 tabId，按发生序。 */
  activated: number[];
  /** 被 chrome.scripting.executeScript 注入 content 脚本的 tabId，按发生序（重复注入重复记）。 */
  injected: number[];
  /** 当前动态注册着的 content script 项（轨二）。 */
  registrations: Array<{ id: string; matches?: string[]; js?: string[] }>;
  /** 本机 chrome.permissions 已授予的 origin 匹配模式。 */
  grantedOrigins: string[];
  requests: ServedRequest[];
  emitMessage(message: unknown, tab: FakeTab): void;
  emitIconClick(tab: FakeTab): void;
  emitTabUpdated(tabId: number, changeInfo: Record<string, unknown>, tab: FakeTab): void;
  emitAlarm(name: string): void;
  /** 探针专用：模拟 chrome.storage.local.set 引发的 onChanged 广播。 */
  emitStorageChanged(changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, areaName?: string): void;
  /** 探针专用：模拟任意 tab 被关闭（含不在任务组内的 tab）。 */
  emitTabRemoved(tabId: number): void;
  connectContent(tab: FakeTab): FakePort;
  connectPanel(groupId: number): FakePort;
  /** 实际到达 POST /frames 的上行帧，按发生序。 */
  upstream(): UpstreamFrame[];
  /** 经 SSE 下发一帧（会话已建立后才有订阅者）。 */
  pushDownstream(frame: DownstreamFrame): void;
  /** 用事件流握手公钥对应的私钥补签，产出可通过 background 验签的指令帧。 */
  signExec(frame: Omit<ExecInstructionFrame, 'signature'>): Promise<ExecInstructionFrame>;
}

/** 微任务与 0 延时宏任务反复放行，让被 void 掉的异步链跑完。 */
export async function settle(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

const timerCleanups: Array<() => void> = [];

/**
 * 拆除本用例装载过的全部宿主替身：先取消它们遗留的定时器，再撤下全局替身。
 * 顺序不可颠倒——替身撤下后仍在跑的回调会撞上不存在的 chrome，那是测试写法制造的噪声。
 */
export function disposeHarnesses(): void {
  while (timerCleanups.length > 0) timerCleanups.pop()!();
  vi.unstubAllGlobals();
}

function servedResponse(served: Served, stream?: ReadableStream<Uint8Array>): Response {
  return {
    ok: served.status >= 200 && served.status < 300,
    status: served.status,
    headers: new Headers(served.headers ?? {}),
    body: served.stream === true ? (stream ?? new ReadableStream<Uint8Array>({ start() {} })) : null,
    json: async () => served.body ?? {},
    text: async () => JSON.stringify(served.body ?? {}),
  } as unknown as Response;
}

function base64Url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** 与 exec-verification 的规范化序列同构（键序稳定）：签名覆盖面必须逐字段一致，否则验签必假。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

export interface LoadOptions {
  denylist?: string[];
  tabs?: FakeTab[];
  storageSession?: Record<string, unknown>;
  /**
   * 覆盖默认服务端应答；返回 null = 该请求网络不可达。默认应答已覆盖会话/事件流/上行帧。
   * 可返回 Promise 把该请求停在「已发出、尚未回」的形态，供断言这段往返窗口内的行为。
   */
  serve?: (request: ServedRequest) => Served | Promise<Served> | null | undefined;
  /** 新开页停在「导航未提交」形态（url 空、目标在 pendingUrl），复现真实 Chrome 的 navigate 瞬间。 */
  createLeavesUrlPending?: boolean;
  /** 本机已授权的 origin 匹配模式（chrome.permissions 初值）。 */
  grantedOrigins?: string[];
  /** 这些 tabId 上的 executeScript 一律 reject，复现「未授权且无 activeTab」的注入失败。 */
  injectionDeniedTabs?: number[];
  /**
   * 被测模块每次读 storage.local 时同步回调（读值之前）。
   * 用于在「异步链已启动、尚未产生副作用」的窗口里插入动作——该窗口在真实 Chrome 上同样存在。
   */
  onLocalRead?: (keys: string | string[] | null) => void;
}

/** 已映射会话的最小服务端：事件流可连（带签名握手头）、上行帧被接收；其余请求一律网络不可达。 */
export function defaultServe(publicKey: string) {
  return (request: ServedRequest): Served | null => {
    if (request.url === `${BASE_URL}/v1/sessions` && request.method === 'POST') {
      return { status: 200, body: { sessionId: SESSION_ID } };
    }
    if (request.url === `${BASE_URL}/v1/sessions/${SESSION_ID}/events`) {
      return {
        status: 200,
        stream: true,
        headers: {
          'x-zen-agent-exec-algorithm': 'Ed25519',
          'x-zen-agent-exec-public-key': publicKey,
        },
      };
    }
    if (request.url === `${BASE_URL}/v1/sessions/${SESSION_ID}/frames`) {
      return { status: 200, body: { messageState: 'complete' } };
    }
    return null;
  };
}

export async function loadBackground(options: LoadOptions = {}): Promise<Harness> {
  const keyPair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const publicKey = base64Url(await crypto.subtle.exportKey('spki', keyPair.publicKey));
  const fallbackServe = defaultServe(publicKey);

  const local: Record<string, unknown> = {
    'za.anonToken': { token: TOKEN_CANARY, expiresAt: Math.floor(Date.now() / 1000) + 3600, baseUrl: BASE_URL },
  };
  if (options.denylist !== undefined) local[SITE_DENYLIST_KEY] = options.denylist;
  const session: Record<string, unknown> = { ...options.storageSession };
  const tabs = new Map<number, FakeTab>();
  for (const tab of options.tabs ?? []) tabs.set(tab.id, { ...tab });
  const activated: number[] = [];
  const injected: number[] = [];
  const registrations: Array<{ id: string; matches?: string[]; js?: string[] }> = [];
  const grantedOrigins: string[] = [...(options.grantedOrigins ?? [])];
  const injectionDenied = new Set(options.injectionDeniedTabs ?? []);
  const requests: ServedRequest[] = [];
  const sseControllers = new Set<ReadableStreamDefaultController<Uint8Array>>();
  let nextTabId = 900;
  let nextGroupId = 800;

  const listeners: {
    message: Array<(message: unknown, sender: unknown, sendResponse: () => void) => void>;
    iconClick: Array<(tab: FakeTab) => void>;
    tabUpdated: Array<(tabId: number, changeInfo: unknown, tab: FakeTab) => void>;
    connect: Array<(port: FakePort) => void>;
    alarm: Array<(alarm: { name: string }) => void>;
    storageChanged: Array<(changes: unknown, areaName: string) => void>;
    tabRemoved: Array<(tabId: number, info: unknown) => void>;
    contextMenuClick: Array<(info: unknown, tab: FakeTab) => void>;
  } = {
    message: [], iconClick: [], tabUpdated: [], connect: [], alarm: [],
    storageChanged: [], tabRemoved: [], contextMenuClick: [],
  };
  const menus: ContextMenuItem[] = [];

  const areaOf = (store: Record<string, unknown>, onRead?: (keys: string | string[] | null) => void) => ({
    async get(keys: string | string[] | null): Promise<Record<string, unknown>> {
      onRead?.(keys);
      const wanted = keys === null ? Object.keys(store) : typeof keys === 'string' ? [keys] : keys;
      const picked: Record<string, unknown> = {};
      for (const key of wanted) if (key in store) picked[key] = store[key];
      return picked;
    },
    async set(items: Record<string, unknown>): Promise<void> {
      Object.assign(store, items);
    },
    async remove(keys: string | string[]): Promise<void> {
      for (const key of typeof keys === 'string' ? [keys] : keys) delete store[key];
    },
  });

  const chromeMock = {
    storage: {
      local: areaOf(local, options.onLocalRead),
      session: areaOf(session),
      onChanged: {
        addListener: (cb: (changes: unknown, areaName: string) => void): void => void listeners.storageChanged.push(cb),
      },
    },
    runtime: {
      onConnect: { addListener: (cb: (port: FakePort) => void): void => void listeners.connect.push(cb) },
      onMessage: {
        addListener: (cb: (message: unknown, sender: unknown, sendResponse: () => void) => void): void =>
          void listeners.message.push(cb),
      },
      onStartup: { addListener: (): void => {} },
      onInstalled: { addListener: (): void => {} },
    },
    action: {
      onClicked: { addListener: (cb: (tab: FakeTab) => void): void => void listeners.iconClick.push(cb) },
    },
    contextMenus: {
      removeAll: async (): Promise<void> => {
        menus.length = 0;
      },
      create: (item: ContextMenuItem): void => {
        menus.push(item);
      },
      onClicked: {
        addListener: (fn: (info: unknown, tab: FakeTab) => void): void => {
          listeners.contextMenuClick.push(fn);
        },
      },
    },
    scripting: {
      executeScript: async (injection: { target: { tabId: number } }): Promise<unknown[]> => {
        if (injectionDenied.has(injection.target.tabId)) throw new Error('Cannot access contents of the page');
        injected.push(injection.target.tabId);
        return [];
      },
      registerContentScripts: async (scripts: Array<{ id: string }>): Promise<void> => {
        registrations.push(...scripts);
      },
      unregisterContentScripts: async (filter: { ids: string[] }): Promise<void> => {
        for (const id of filter.ids) {
          const index = registrations.findIndex((item) => item.id === id);
          if (index !== -1) registrations.splice(index, 1);
        }
      },
      getRegisteredContentScripts: async (): Promise<unknown[]> => [...registrations],
    },
    permissions: {
      getAll: async (): Promise<{ origins: string[] }> => ({ origins: [...grantedOrigins] }),
      contains: async (descriptor: { origins?: string[] }): Promise<boolean> =>
        (descriptor.origins ?? []).every((origin) => grantedOrigins.includes(origin)),
      request: async (descriptor: { origins?: string[] }): Promise<boolean> => {
        for (const origin of descriptor.origins ?? []) {
          if (!grantedOrigins.includes(origin)) grantedOrigins.push(origin);
        }
        return true;
      },
      remove: async (descriptor: { origins?: string[] }): Promise<boolean> => {
        for (const origin of descriptor.origins ?? []) {
          const index = grantedOrigins.indexOf(origin);
          if (index !== -1) grantedOrigins.splice(index, 1);
        }
        return true;
      },
    },
    alarms: {
      getAll: async (): Promise<unknown[]> => [],
      clear: async (): Promise<boolean> => true,
      create: (): void => {},
      onAlarm: { addListener: (cb: (alarm: { name: string }) => void): void => void listeners.alarm.push(cb) },
    },
    sidePanel: {
      setOptions: async (): Promise<void> => {},
      open: async (): Promise<void> => {},
      close: async (): Promise<void> => {},
    },
    tabGroups: {
      query: async (): Promise<unknown[]> => [],
      update: async (): Promise<unknown> => ({}),
      onRemoved: { addListener: (): void => {} },
    },
    tabs: {
      async get(tabId: number): Promise<FakeTab> {
        const tab = tabs.get(tabId);
        if (tab === undefined) throw new Error('no such tab');
        return tab;
      },
      async query(queryInfo: { groupId?: number }): Promise<FakeTab[]> {
        const all = [...tabs.values()];
        return queryInfo.groupId === undefined ? all : all.filter((tab) => tab.groupId === queryInfo.groupId);
      },
      async create(props: { url: string; windowId?: number }): Promise<FakeTab> {
        nextTabId += 1;
        const pending = options.createLeavesUrlPending === true;
        const tab: FakeTab = {
          id: nextTabId,
          url: pending ? '' : props.url,
          ...(pending ? { pendingUrl: props.url } : {}),
          groupId: -1,
          windowId: props.windowId ?? 1,
        };
        tabs.set(tab.id, tab);
        return tab;
      },
      async group(opts: { tabIds: number | number[]; groupId?: number }): Promise<number> {
        const groupId = opts.groupId ?? (nextGroupId += 1);
        for (const id of Array.isArray(opts.tabIds) ? opts.tabIds : [opts.tabIds]) {
          const tab = tabs.get(id);
          if (tab !== undefined) tab.groupId = groupId;
        }
        return groupId;
      },
      async update(tabId: number, props: { url?: string }): Promise<FakeTab> {
        const tab = tabs.get(tabId);
        if (tab === undefined) throw new Error('no such tab');
        if (props.url !== undefined) tab.url = props.url;
        return tab;
      },
      async sendMessage(tabId: number, message: unknown): Promise<void> {
        if ((message as { kind?: string } | null)?.kind === 'activate') activated.push(tabId);
      },
      onUpdated: {
        addListener: (cb: (tabId: number, changeInfo: unknown, tab: FakeTab) => void): void =>
          void listeners.tabUpdated.push(cb),
      },
      onActivated: { addListener: (): void => {} },
      onRemoved: {
        addListener: (cb: (tabId: number, info: unknown) => void): void => void listeners.tabRemoved.push(cb),
      },
    },
  };

  // 被测模块排期的定时器登记在案，供 disposeHarnesses 在拆替身之前逐个取消。
  const liveTimers = new Set<ReturnType<typeof setTimeout>>();
  timerCleanups.push(() => {
    for (const timer of liveTimers) realClearTimeout(timer);
    liveTimers.clear();
  });
  vi.stubGlobal('setTimeout', (handler: (...args: unknown[]) => void, delayMs?: number, ...args: unknown[]) => {
    const timer: ReturnType<typeof setTimeout> = realSetTimeout(() => {
      liveTimers.delete(timer);
      handler(...args);
    }, delayMs);
    liveTimers.add(timer);
    return timer;
  });
  vi.stubGlobal('clearTimeout', (timer: ReturnType<typeof setTimeout>) => {
    liveTimers.delete(timer);
    realClearTimeout(timer);
  });

  vi.stubGlobal('chrome', chromeMock);
  vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}): Promise<Response> => {
    const request: ServedRequest = {
      url: String(input),
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
    };
    requests.push(request);
    const served = await (options.serve?.(request) ?? fallbackServe(request));
    if (served === null || served === undefined) throw new Error('network unreachable');
    if (served.stream !== true) return servedResponse(served);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        sseControllers.add(controller);
      },
    });
    return servedResponse(served, stream);
  });

  vi.resetModules();
  await import('../../src/background.js');
  await settle();

  const attach = (name: string, tab: FakeTab): FakePort => {
    const messageListeners: Array<(message: unknown) => void> = [];
    const port: FakePort = {
      name,
      sender: { tab: { id: tab.id, url: tab.url, windowId: tab.windowId, groupId: tab.groupId } },
      postMessage: (message) => void port.received.push(message),
      disconnect: () => {},
      onMessage: { addListener: (cb) => void messageListeners.push(cb) },
      onDisconnect: { addListener: () => {} },
      emit: (message) => {
        for (const cb of messageListeners) cb(message);
      },
      received: [],
    };
    for (const cb of listeners.connect) cb(port);
    return port;
  };

  return {
    local,
    session,
    tabs,
    activated,
    injected,
    registrations,
    grantedOrigins,
    requests,
    emitMessage(message, tab) {
      const sender = { tab: { id: tab.id, url: tab.url, windowId: tab.windowId, groupId: tab.groupId } };
      for (const cb of listeners.message) cb(message, sender, () => {});
    },
    emitIconClick(tab) {
      for (const cb of listeners.iconClick) cb(tab);
    },
    emitTabUpdated(tabId, changeInfo, tab) {
      for (const cb of listeners.tabUpdated) cb(tabId, changeInfo, tab);
    },
    emitAlarm(name) {
      for (const cb of listeners.alarm) cb({ name });
    },
    emitStorageChanged(changes, areaName = 'local') {
      for (const cb of listeners.storageChanged) cb(changes, areaName);
    },
    emitTabRemoved(tabId) {
      tabs.delete(tabId);
      for (const cb of listeners.tabRemoved) cb(tabId, { isWindowClosing: false, windowId: 1 });
    },
    menus,
    emitContextMenuClick(info, tab) {
      for (const cb of listeners.contextMenuClick) cb(info, tab);
    },
    connectContent(tab) {
      return attach(SESSION_PORT_NAME, tab);
    },
    connectPanel(groupId) {
      const port = attach(SIDE_PANEL_PORT_NAME, {
        id: -1,
        url: '',
        groupId,
        windowId: 1,
      });
      port.emit({ kind: 'panel-bind', groupId });
      return port;
    },
    upstream() {
      return requests
        .filter((request) => request.url.endsWith('/frames'))
        .map((request) => request.body as UpstreamFrame);
    },
    pushDownstream(frame) {
      const chunk = new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`);
      for (const controller of sseControllers) controller.enqueue(chunk);
    },
    async signExec(frame) {
      const payload = stableStringify({
        sessionId: frame.sessionId,
        nonce: frame.nonce,
        issuedAt: frame.issuedAt,
        expiresAt: frame.expiresAt,
        ttl: frame.ttl,
        toolCallId: frame.toolCallId,
        ...(frame.page !== undefined ? { targetPage: frame.page } : {}),
        request: frame.request,
      });
      const signature = await crypto.subtle.sign(
        { name: 'Ed25519' },
        keyPair.privateKey,
        new TextEncoder().encode(payload),
      );
      return { ...frame, signature: base64Url(signature) };
    },
  };
}
