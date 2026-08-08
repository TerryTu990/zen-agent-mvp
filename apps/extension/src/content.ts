import { createContextReporter } from './context-report.js';
import { createDelegatedExecutor } from './delegated-execution.js';
import { createDomStepRunner, type DomNavigate } from './dom-steps.js';
import { isPageDownstreamFrame, routeDownstreamFrame } from './content-router.js';
import { createDomGuidePage, createPageActionRunner } from './page-action.js';
import { createSnapshotter } from './page-snapshot.js';
import {
  SESSION_PORT_NAME,
  type BackgroundRuntimeMessage,
  type BackgroundToContentMessage,
  type ContentRuntimeMessage,
  type ContentToBackgroundMessage,
} from './messaging.js';

let activated = false;
// 激活后可从模块作用域触达的上下文重报：boot 收 refresh-context 时调用；未激活时为 null（无会话可报）。
let liveAnnounce: (() => void) | null = null;
const pageInstanceId = crypto.randomUUID();

function activate(): void {
  if (activated) return;
  activated = true;

  const snapshot = createSnapshotter();
  const pageAction = createPageActionRunner(
    createDomGuidePage(document, (ref) => snapshot.resolve(ref)),
  );
  let stopRequested = false;
  let port: chrome.runtime.Port | null = null;
  let reconnectTimer: number | null = null;
  const pendingNavigations = new Map<string, (result: { ok: boolean; url?: string; error?: string }) => void>();
  let navSeq = 0;

  const scheduleReconnect = (): void => {
    if (reconnectTimer !== null) return;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 300);
  };

  const send = (message: ContentToBackgroundMessage): void => {
    if (port === null) {
      scheduleReconnect();
      return;
    }
    try {
      port.postMessage(message);
    } catch {
      port = null;
      scheduleReconnect();
    }
  };

  const navigate: DomNavigate = (url) =>
    new Promise((resolveNav) => {
      navSeq += 1;
      const requestId = `nav-${navSeq}`;
      pendingNavigations.set(requestId, resolveNav);
      send({ kind: 'navigate-request', requestId, url });
    });
  const domRunner = createDomStepRunner(
    (ref) => snapshot.resolve(ref),
    undefined,
    () => stopRequested,
    navigate,
  );
  const executor = createDelegatedExecutor(fetch, {
    async run(steps) {
      stopRequested = false;
      send({ kind: 'operation-state', running: true });
      try {
        return await domRunner.run(steps);
      } finally {
        send({ kind: 'operation-state', running: false });
      }
    },
  }, () => ({ url: location.href, pageInstanceId }));

  const routeMessage = (raw: unknown): void => {
    const message = raw as BackgroundToContentMessage;
    if (message.kind === 'stop-operation') {
      stopRequested = true;
      return;
    }
    if (message.kind === 'navigate-result') {
      const resolveNav = pendingNavigations.get(message.requestId);
      if (resolveNav !== undefined) {
        pendingNavigations.delete(message.requestId);
        resolveNav({
          ok: message.ok,
          ...(message.url !== undefined ? { url: message.url } : {}),
          ...(message.error !== undefined ? { error: message.error } : {}),
        });
      }
      return;
    }
    if (message.kind === 'frame' && isPageDownstreamFrame(message.frame)) {
      routeDownstreamFrame(message.frame, { pageAction, executor, snapshot, send, pageInstanceId });
    }
  };

  // 经 send 上报：bfcache 恢复时端口已断而 onDisconnect 尚未派发，直接 postMessage 会抛异常
  // 且不触发重连；send 失败即断线重连，重连后 connect() 对可见页补报。
  const announce = (): void => {
    send({ kind: 'context-report', ...createContextReporter().collect() });
  };
  liveAnnounce = announce;

  // 仅用户视线所在页上报（后台页/预渲染页不抢活跃页路由）；SPA 同文档导航同守此判定。
  const announceIfVisible = (): void => {
    if (document.visibilityState === 'visible') announce();
  };

  function connect(): void {
    const connected = chrome.runtime.connect({ name: SESSION_PORT_NAME });
    port = connected;
    connected.onMessage.addListener(routeMessage);
    connected.onDisconnect.addListener(() => {
      if (port === connected) port = null;
      scheduleReconnect();
    });
    // 仅用户视线所在页上报上下文（后台页/预渲染页不抢活跃页路由）；转入可见时由 visibilitychange 补报。
    if (document.visibilityState === 'visible') announce();
  }

  connect();
  window.setInterval(() => send({ kind: 'ping' }), 20000);
  document.addEventListener('visibilitychange', announceIfVisible);
  // hash 路由与 back/forward 是同文档导航（不重载 tab/不失焦），isolated world 仍收得到这两个 window 事件；
  // pushState/replaceState 无对应 window 事件，走 background 的 refresh-context 兜底（见 boot）。
  window.addEventListener('hashchange', announceIfVisible);
  window.addEventListener('popstate', announceIfVisible);
}

async function matchesAutoActivate(): Promise<boolean> {
  try {
    const items = await chrome.storage.local.get('za.autoActivate');
    const list = items['za.autoActivate'];
    return Array.isArray(list) && list.includes(location.origin);
  } catch {
    return false;
  }
}

function boot(): void {
  if (window.top !== window) return;
  chrome.runtime.onMessage.addListener((raw) => {
    const message = raw as BackgroundRuntimeMessage | null;
    if (message?.kind === 'activate') activate();
    else if (message?.kind === 'refresh-context' && document.visibilityState === 'visible') liveAnnounce?.();
  });
  void matchesAutoActivate().then((autoActivate) => {
    const request: ContentRuntimeMessage = { kind: 'request-activate', autoActivate };
    void chrome.runtime.sendMessage(request).catch(() => {});
  });
}

boot();
