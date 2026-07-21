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

function readHostUserId(): string | null {
  try {
    const raw = localStorage.getItem('user');
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || !('id' in parsed)) return null;
    const id = (parsed as { id: unknown }).id;
    if (typeof id === 'string' && id !== '') return id;
    if (typeof id === 'number') return String(id);
    return null;
  } catch {
    return null;
  }
}

let activated = false;

function activate(): void {
  if (activated) return;
  activated = true;

  const pageAction = createPageActionRunner(createDomGuidePage());
  const snapshot = createSnapshotter();
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
  });

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
      routeDownstreamFrame(message.frame, { pageAction, executor, snapshot, send });
    }
  };

  const announce = (): void => {
    if (port === null) return;
    const hostUserId = readHostUserId();
    if (hostUserId !== null) port.postMessage({ kind: 'host-identity', hostUserId });
    port.postMessage({ kind: 'context-report', ...createContextReporter().collect() });
  };

  function connect(): void {
    const connected = chrome.runtime.connect({ name: SESSION_PORT_NAME });
    port = connected;
    connected.onMessage.addListener(routeMessage);
    connected.onDisconnect.addListener(() => {
      if (port === connected) port = null;
      scheduleReconnect();
    });
    announce();
  }

  connect();
  window.setInterval(() => send({ kind: 'ping' }), 20000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') announce();
  });
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
  });
  void matchesAutoActivate().then((autoActivate) => {
    const request: ContentRuntimeMessage = { kind: 'request-activate', autoActivate };
    void chrome.runtime.sendMessage(request).catch(() => {});
  });
}

boot();
