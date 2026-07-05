import { createContextReporter } from './context-report.js';
import { createConversationUi } from './conversation-hitl.js';
import { createDelegatedExecutor } from './delegated-execution.js';
import { createDomStepRunner, type DomNavigate } from './dom-steps.js';
import { createSnapshotter } from './page-snapshot.js';
import { routeDownstreamFrame } from './content-router.js';
import { createDomGuidePage, createPageActionRunner } from './page-action.js';
import {
  SESSION_PORT_NAME,
  type BackgroundToContentMessage,
  type BackgroundRuntimeMessage,
  type ContentToBackgroundMessage,
  type ContentRuntimeMessage,
} from './messaging.js';
import { DRAWER_DEFAULT_WIDTH, DRAWER_MAX_WIDTH, DRAWER_MIN_WIDTH } from './tuning.js';

const WIDTH_KEY = 'za.drawerWidth';
const COLLAPSED_KEY = 'za.drawerCollapsed';

// Atelier 设计令牌字面值内联（Shadow DOM 隔离，无法引用页面 CSS 变量）；取值/语义 SSOT 见根 DESIGN.md。
const PANEL_CSS = `
  :host {
    --ink: #1C1B18; --ink-soft: #615C54; --pencil: #8E887D; --pencil-lt: #B7B1A6;
    --paper: #FBFAF8; --paper-2: #F4F3EF; --line: #E6E2DA; --line-2: #D6D0C4;
    --clay: #B4552F; --clay-soft: #F2E6DE;
    --ok: #3E6B4E; --ok-soft: #E5EBE5; --bad: #A23A2C; --bad-soft: #F2E2DE; --warning: #8F6516;
    --n-act: #B4552F; --n-act-soft: #F2E6DE; --n-agent: #5E5396; --n-agent-soft: #ECEAF3;
    --n-ctrl: #8E887D; --n-ctrl-soft: #ECEAE3;
    --serif: 'Fraunces','Noto Serif SC',Georgia,serif;
    --sans: 'Hanken Grotesk','Noto Sans SC',system-ui,-apple-system,sans-serif;
    --mono: 'Geist Mono','Noto Sans Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
  }
  @keyframes za-rise { from { transform: translateY(12px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
  @keyframes za-blink { 50% { opacity: 0; } }
  .za-wrap { font: 13px/1.5 var(--sans); color: var(--ink); }

  .za-panel {
    position: fixed; top: 0; right: 0; bottom: 0; z-index: 2147483647;
    display: flex; flex-direction: column; width: 400px; max-width: 94vw;
    background: var(--paper); border-left: 1px solid var(--line-2);
    box-shadow: -14px 0 40px rgba(28, 27, 24, 0.12);
    transform: translateX(0); transition: transform .26s cubic-bezier(.16, 1, .3, 1);
  }
  .za-wrap.collapsed .za-panel { transform: translateX(105%); }

  .za-resize {
    position: absolute; top: 0; bottom: 0; left: 0; width: 6px; cursor: col-resize; z-index: 2;
  }
  .za-resize:hover { background: rgba(180, 85, 47, 0.32); }

  .za-header {
    flex: none; display: flex; align-items: center; gap: 8px;
    padding: 12px 14px; border-bottom: 1px solid var(--line-2); background: var(--n-agent-soft);
  }
  .za-brand-mark { flex: none; display: block; }
  .za-title { font-family: var(--serif); font-size: 15px; font-weight: 600; color: var(--n-agent); letter-spacing: .01em; }
  .za-collapse {
    margin-left: auto; width: 28px; height: 28px; display: grid; place-items: center;
    border: 1px solid var(--line-2); border-radius: 8px; background: var(--paper);
    color: var(--pencil); cursor: pointer; font-size: 15px; line-height: 1;
  }
  .za-collapse:hover { color: var(--ink); border-color: var(--n-agent); }

  [data-za-messages] { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 11px; }

  .za-msg { display: flex; flex-direction: column; gap: 4px; max-width: 92%; animation: za-rise .24s cubic-bezier(.16, 1, .3, 1) both; }
  .za-msg[data-role="user"] { align-self: flex-end; align-items: flex-end; }
  .za-msg[data-role="assistant"] { align-self: flex-start; }
  .za-who { font-family: var(--mono); font-size: 10.5px; letter-spacing: .09em; text-transform: uppercase; font-weight: 500; color: var(--pencil); padding: 0 4px; }
  .za-msg[data-role="assistant"] .za-who { color: var(--n-agent); }
  .za-bub { border: 1px solid var(--line); border-radius: 13px; padding: 9px 13px; font-size: 14px; line-height: 1.55; word-break: break-word; }
  .za-msg[data-role="user"] .za-bub { background: var(--ink); color: var(--paper-2); border-color: var(--ink); border-bottom-right-radius: 5px; white-space: pre-wrap; }
  .za-msg[data-role="assistant"] .za-bub { background: var(--paper-2); border-bottom-left-radius: 5px; }
  .za-msg[data-role="assistant"] .za-bub.streaming::after { content: '▌'; color: var(--clay); animation: za-blink 1s step-end infinite; margin-left: 1px; }

  .mdlite { font-size: 14px; color: var(--ink); }
  .mdlite > :first-child { margin-top: 0; }
  .mdlite > :last-child { margin-bottom: 0; }
  .mdlite h4, .mdlite h5, .mdlite h6 { margin: 10px 0 4px; color: var(--ink); }
  .mdlite h4 { font-size: 15px; } .mdlite h5 { font-size: 14px; } .mdlite h6 { font-size: 13px; }
  .mdlite p { margin: 5px 0; line-height: 1.6; }
  .mdlite ul, .mdlite ol { margin: 5px 0; padding-left: 20px; }
  .mdlite li { margin: 2px 0; line-height: 1.6; }
  .mdlite code { font-family: var(--mono); font-size: 12px; background: var(--paper); border: 1px solid var(--line); border-radius: 4px; padding: 1px 4px; }
  .mdlite pre { margin: 6px 0; background: var(--paper); border: 1px solid var(--line); border-radius: 8px; padding: 9px 11px; overflow-x: auto; font-family: var(--mono); font-size: 12px; }
  .mdlite pre code { background: none; border: none; padding: 0; }
  .mdlite table { border-collapse: collapse; margin: 6px 0; font-size: 12.5px; display: block; max-width: 100%; overflow-x: auto; }
  .mdlite th, .mdlite td { border: 1px solid var(--line-2); padding: 4px 9px; text-align: left; }
  .mdlite th { background: var(--paper); font-weight: 600; }

  .za-status { align-self: center; max-width: 92%; padding: 5px 12px; border-radius: 8px; font-family: var(--mono); font-size: 11.5px; color: var(--bad); background: var(--bad-soft); border: 1px solid var(--line-2); }

  .za-toolgroup { align-self: stretch; display: flex; flex-direction: column; gap: 6px; animation: za-rise .24s cubic-bezier(.16, 1, .3, 1) both; }
  .za-toolgroup-title { display: flex; align-items: center; gap: 7px; font-family: var(--mono); font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--pencil); }
  .za-toolgroup-title::before { content: ''; width: 8px; height: 8px; border-radius: 2px; background: var(--pencil); }
  .za-toolgroup[data-mode="client"] .za-toolgroup-title { color: var(--n-act); }
  .za-toolgroup[data-mode="client"] .za-toolgroup-title::before { background: var(--n-act); }
  .za-toolgroup[data-mode="server"] .za-toolgroup-title { color: var(--n-agent); }
  .za-toolgroup[data-mode="server"] .za-toolgroup-title::before { background: var(--n-agent); }
  .za-toolgroup-body { display: flex; flex-direction: column; gap: 6px; }

  .za-toolcard { padding: 8px 12px; border-radius: 10px; font-family: var(--mono); font-size: 12px; border: 1px solid var(--line); background: var(--paper-2); color: var(--ink-soft); }
  .za-toolcard[data-status="running"] { border-color: color-mix(in srgb, var(--warning) 45%, var(--line-2)); }
  .za-toolcard[data-status="succeeded"] { border-color: color-mix(in srgb, var(--ok) 40%, var(--line-2)); background: var(--ok-soft); }
  .za-toolcard[data-status="failed"] { border-color: color-mix(in srgb, var(--bad) 40%, var(--line-2)); background: var(--bad-soft); }

  .za-hitl { align-self: stretch; padding: 11px 13px; border-radius: 14px; background: var(--clay-soft); border: 1px solid color-mix(in srgb, var(--clay) 38%, var(--line-2)); display: flex; flex-direction: column; gap: 7px; animation: za-rise .24s cubic-bezier(.16, 1, .3, 1) both; }
  .za-hitl-title { font-weight: 600; color: var(--clay); }
  .za-hitl-detail, .za-hitl-reason { font-size: 12.5px; color: var(--ink-soft); word-break: break-word; }
  .za-hitl-hint { font-size: 11.5px; color: var(--pencil); }
  .za-stop { position: absolute; right: 14px; bottom: 76px; z-index: 3; display: none; padding: 7px 14px; border: none; border-radius: 999px; font: inherit; font-size: 12.5px; cursor: pointer; background: var(--ink); color: var(--paper); box-shadow: 0 4px 14px rgba(28, 27, 24, .28); }
  .za-stop[data-on] { display: block; }
  .za-hitl-actions { display: flex; gap: 8px; margin-top: 2px; }
  .za-hitl-approve, .za-hitl-reject { flex: 1; padding: 7px 0; border: none; border-radius: 8px; font: inherit; cursor: pointer; }
  .za-hitl-approve { background: var(--clay); color: #fff; }
  .za-hitl-reject { background: var(--paper); border: 1px solid var(--line-2); color: var(--ink); }

  .za-composer { flex: none; display: flex; gap: 8px; padding: 12px 14px; border-top: 1px solid var(--line-2); }
  #za-input { flex: 1; resize: none; height: 46px; max-height: 160px; padding: 8px 10px; border: 1px solid var(--line-2); border-radius: 10px; font: inherit; background: var(--paper); color: var(--ink); }
  #za-input:focus { outline: none; border-color: var(--clay); box-shadow: 0 0 0 2px var(--clay-soft); }
  #za-send { padding: 0 16px; border: none; border-radius: 10px; background: var(--n-agent); color: #fff; font: inherit; cursor: pointer; }

  .za-fab {
    position: fixed; right: 20px; bottom: 24px; z-index: 2147483647;
    display: none; align-items: center; padding: 0;
    border: 1px solid var(--line-2); border-radius: 50%; background: var(--paper); color: var(--ink);
    cursor: pointer; box-shadow: 0 8px 26px rgba(28, 27, 24, 0.16);
    transition: border-radius .28s cubic-bezier(.16, 1, .3, 1), transform .14s;
  }
  .za-fab-ico { width: 50px; height: 50px; flex: none; display: grid; place-items: center; }
  .za-fab-label { max-width: 0; opacity: 0; overflow: hidden; white-space: nowrap; font-family: var(--serif); font-size: 14px; transition: max-width .28s cubic-bezier(.16, 1, .3, 1), opacity .18s; }
  .za-fab:hover { border-radius: 28px; padding-right: 16px; transform: translateY(-1px); }
  .za-fab:hover .za-fab-label { max-width: 200px; opacity: 1; }
  .za-wrap.collapsed .za-fab { display: inline-flex; }
`;

interface Panel {
  messages: HTMLElement;
  input: HTMLTextAreaElement;
  sendButton: HTMLButtonElement;
  wrap: HTMLElement;
  panel: HTMLElement;
  resizeHandle: HTMLElement;
  collapseButton: HTMLButtonElement;
  fab: HTMLButtonElement;
  stopButton: HTMLButtonElement;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** zen 品牌标记（与 zen-flux 同族：clay 圆角方块 + paper 描边 Z）；经 DOM 命名空间构造，不用 innerHTML。 */
function createZenMark(size: number): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 120 120');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  const rect = document.createElementNS(SVG_NS, 'rect');
  for (const [k, v] of Object.entries({ x: '8', y: '8', width: '104', height: '104', rx: '26', fill: '#B4552F' })) {
    rect.setAttribute(k, v);
  }
  const path = document.createElementNS(SVG_NS, 'path');
  for (const [k, v] of Object.entries({
    d: 'M40 44 H80 L40 76 H80',
    stroke: '#F4F3EF',
    'stroke-width': '13',
    'stroke-linejoin': 'miter',
    fill: 'none',
  })) {
    path.setAttribute(k, v);
  }
  svg.append(rect, path);
  return svg;
}

function mountPanel(): Panel {
  const host = document.createElement('div');
  host.id = 'za-root';
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = PANEL_CSS;

  const wrap = document.createElement('div');
  wrap.className = 'za-wrap';

  const panel = document.createElement('div');
  panel.className = 'za-panel';

  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'za-resize';
  resizeHandle.title = '拖动改变宽度';

  const header = document.createElement('div');
  header.className = 'za-header';
  const brandMark = createZenMark(20);
  brandMark.classList.add('za-brand-mark');
  const title = document.createElement('span');
  title.className = 'za-title';
  title.textContent = 'zen-agent';
  const collapseButton = document.createElement('button');
  collapseButton.className = 'za-collapse';
  collapseButton.title = '收起面板';
  collapseButton.textContent = '⟩';
  header.append(brandMark, title, collapseButton);

  const messages = document.createElement('div');
  messages.setAttribute('data-za-messages', '');

  const composer = document.createElement('div');
  composer.className = 'za-composer';
  const input = document.createElement('textarea');
  input.id = 'za-input';
  const sendButton = document.createElement('button');
  sendButton.id = 'za-send';
  sendButton.textContent = '发送';
  composer.append(input, sendButton);

  // dom 批次执行期浮现的「停止」：点击即在步间中止并回传 user-stopped（服务端据此吊销任务授权）。
  const stopButton = document.createElement('button');
  stopButton.className = 'za-stop';
  stopButton.textContent = '⏹ 停止操作';

  panel.append(resizeHandle, header, messages, composer, stopButton);

  const fab = document.createElement('button');
  fab.className = 'za-fab';
  fab.title = '展开 zen';
  const fabIco = document.createElement('span');
  fabIco.className = 'za-fab-ico';
  fabIco.append(createZenMark(28));
  const fabLabel = document.createElement('span');
  fabLabel.className = 'za-fab-label';
  fabLabel.textContent = 'zen-agent';
  fab.append(fabIco, fabLabel);

  wrap.append(panel, fab);
  shadow.append(style, wrap);
  document.documentElement.append(host);
  return { messages, input, sendButton, wrap, panel, resizeHandle, collapseButton, fab, stopButton };
}

/** 页面同源读取当前登录宿主用户的 id（codeflow 存于 localStorage 'user'）；结构不符则返回 null。 */
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

function clampWidth(value: number): number {
  return Math.min(DRAWER_MAX_WIDTH, Math.max(DRAWER_MIN_WIDTH, value));
}

function wireDrawerControls(panelRefs: Panel): void {
  const { wrap, panel, resizeHandle, collapseButton, fab } = panelRefs;

  void chrome.storage.local.get([WIDTH_KEY, COLLAPSED_KEY]).then((items) => {
    const storedWidth = items[WIDTH_KEY];
    panel.style.width = `${typeof storedWidth === 'number' ? clampWidth(storedWidth) : DRAWER_DEFAULT_WIDTH}px`;
    wrap.classList.toggle('collapsed', items[COLLAPSED_KEY] === true);
  });

  const setCollapsed = (collapsed: boolean): void => {
    wrap.classList.toggle('collapsed', collapsed);
    void chrome.storage.local.set({ [COLLAPSED_KEY]: collapsed });
  };
  collapseButton.addEventListener('click', () => setCollapsed(true));
  fab.addEventListener('click', () => setCollapsed(false));

  // 右侧抽屉把手在左缘：向左拖变宽（next = startW - delta）。
  resizeHandle.addEventListener('mousedown', (event) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = panel.getBoundingClientRect().width;
    const onMove = (move: MouseEvent): void => {
      panel.style.width = `${clampWidth(startWidth - (move.clientX - startX))}px`;
    };
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      void chrome.storage.local.set({ [WIDTH_KEY]: panel.getBoundingClientRect().width });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
}

let activated = false;

function activate(): void {
  if (activated || document.getElementById('za-root') !== null) return;
  activated = true;
  const panelRefs = mountPanel();
  const { messages, input, sendButton, stopButton } = panelRefs;
  wireDrawerControls(panelRefs);
  const ui = createConversationUi(messages);
  const pageAction = createPageActionRunner(createDomGuidePage());
  // 快照器与 dom 解释器共享 ref 映射：解释器只解引用最近一次快照的 ref（adr-011）。
  const snapshot = createSnapshotter();
  let stopRequested = false;
  stopButton.addEventListener('click', () => {
    stopRequested = true;
  });
  // navigate 步经 background 在本组窗口开目标页并入组；requestId 关联回执，端口断则以失败兜底。
  const pendingNavigations = new Map<string, (result: { ok: boolean; url?: string; error?: string }) => void>();
  let navSeq = 0;
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
  // 执行期显隐停止按钮；每批开跑前复位停止标志（停止只作用于当前在跑的批次）。
  const executor = createDelegatedExecutor(fetch, {
    async run(steps) {
      stopRequested = false;
      stopButton.setAttribute('data-on', '');
      try {
        return await domRunner.run(steps);
      } finally {
        stopButton.removeAttribute('data-on');
      }
    },
  });

  let port: chrome.runtime.Port | null = null;
  let reconnectTimer: number | null = null;
  const scheduleReconnect = (): void => {
    // 幂等排程：单一在途重连，避免 onDisconnect 与 send 同时触发导致会话风暴。
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
  const routeMessage = (raw: unknown): void => {
    const message = raw as BackgroundToContentMessage;
    if (message.kind === 'status') {
      ui.showStatus(message.message);
    } else if (message.kind === 'user-echo') {
      ui.appendUserMessage(message.text);
    } else if (message.kind === 'navigate-result') {
      const resolveNav = pendingNavigations.get(message.requestId);
      if (resolveNav !== undefined) {
        pendingNavigations.delete(message.requestId);
        resolveNav({
          ok: message.ok,
          ...(message.url !== undefined ? { url: message.url } : {}),
          ...(message.error !== undefined ? { error: message.error } : {}),
        });
      }
    } else if (message.kind === 'frame') {
      routeDownstreamFrame(message.frame, { ui, pageAction, executor, snapshot, send });
    }
  };
  // (重)连即重发身份 + 上下文：background 复用已存 sessionId 时更新 currentUrl，无存时据此开会话。
  const announce = (): void => {
    if (port === null) return;
    const hostUserId = readHostUserId();
    if (hostUserId !== null) port.postMessage({ kind: 'host-identity', hostUserId });
    port.postMessage({ kind: 'context-report', ...createContextReporter().collect() });
  };
  function connect(): void {
    const p = chrome.runtime.connect({ name: SESSION_PORT_NAME });
    port = p;
    p.onMessage.addListener(routeMessage);
    p.onDisconnect.addListener(() => {
      if (port === p) port = null;
      scheduleReconnect();
    });
    announce();
  }
  connect();
  // 保活：每 20s（< MV3 30s 空闲阈值）一次端口消息，其到达即重置 SW 计时器，
  // 页面开着 SW 不被回收 → 会话与 SSE 稳定、in-flight HITL/代执行不丢。端口已断则触发重连。
  window.setInterval(() => send({ kind: 'ping' }), 20000);
  // 回到可见即重报上下文：组内活跃页跟随用户视线（HITL/exec/guide 路由到此页，adr-012）。
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') announce();
  });

  const submit = () => {
    const text = input.value.trim();
    if (text === '') return;
    input.value = '';
    ui.appendUserMessage(text);
    send({ kind: 'user-message', text });
  };
  sendButton.addEventListener('click', submit);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  });
}

/** 当前页 origin 是否命中 za.autoActivate 开关（配置级 dev/demo；非对话可改）。 */
async function matchesAutoActivate(): Promise<boolean> {
  try {
    const items = await chrome.storage.local.get('za.autoActivate');
    const list = items['za.autoActivate'];
    return Array.isArray(list) && list.includes(location.origin);
  } catch {
    return false;
  }
}

/**
 * 显式发起（ADR-013 批次④ §5）：content 加载不自动连会话，仅注册激活握手——
 * 收 background 的 activate 才挂面板连接；加载时上报是否命中 autoActivate，由 background 决定激活。
 * 仅在顶层文档运行（面板/会话归顶层；同源 iframe 只作快照下钻对象）。
 */
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
