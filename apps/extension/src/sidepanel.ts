import { panelGroupKey, TAB_GROUP_ID_NONE } from './activation.js';
import { createConversationUi } from './conversation-hitl.js';
import type { ExecutionPreference } from './frames.js';
import {
  SIDE_PANEL_PORT_NAME,
  type BackgroundToSidePanelMessage,
  type SidePanelUiEvent,
  type SidePanelToBackgroundMessage,
} from './messaging.js';

const EXECUTION_PREFERENCE_KEY = 'za.executionPreference';

interface SidePanelElements {
  messages: HTMLElement;
  input: HTMLTextAreaElement;
  send: HTMLButtonElement;
  stop: HTMLButtonElement;
  preference: HTMLSelectElement;
  context: HTMLElement;
  contextTitle: HTMLElement;
  contextDetail: HTMLElement;
}

export function mountSidePanel(root: HTMLElement): SidePanelElements {
  root.innerHTML = `
    <section class="za-shell" aria-label="Zen Commerce Agent 控制台">
      <header class="za-topbar">
        <div class="za-mark" aria-hidden="true">Z</div>
        <div class="za-brand"><h1>Zen Commerce</h1><p>闲鱼电商智能体</p></div>
      </header>
      <section class="za-context" data-za-context data-state="waiting" aria-live="polite">
        <span class="za-context-dot" aria-hidden="true"></span>
        <div class="za-context-copy">
          <div class="za-context-title">等待连接任务页面</div>
          <div class="za-context-detail">打开闲鱼卖家后台后点击 Zen Commerce 图标</div>
        </div>
        <label>
          <span hidden>执行偏好</span>
          <select class="za-preference" data-za-preference aria-label="执行偏好">
            <option value="auto">自动选择</option>
            <option value="dom-only">仅客户端 DOM</option>
            <option value="prefer-client-api">优先客户端 API</option>
            <option value="prefer-server-api">优先服务端 API</option>
          </select>
        </label>
      </section>
      <section data-za-messages aria-live="polite">
        <div class="za-empty"><strong>把操作交给 Zen</strong><span>对话会留在这里；页面只负责观察与执行。</span></div>
      </section>
      <footer class="za-composer">
        <div class="za-composer-row">
          <textarea id="za-input" aria-label="给 Zen 发送消息" placeholder="描述你想完成的浏览器操作…" disabled></textarea>
          <button id="za-send" type="button" disabled>发送</button>
        </div>
        <button class="za-stop" data-za-stop type="button" disabled>停止当前操作</button>
      </footer>
    </section>`;
  const messages = root.querySelector<HTMLElement>('[data-za-messages]');
  const input = root.querySelector<HTMLTextAreaElement>('#za-input');
  const send = root.querySelector<HTMLButtonElement>('#za-send');
  const stop = root.querySelector<HTMLButtonElement>('[data-za-stop]');
  const preference = root.querySelector<HTMLSelectElement>('[data-za-preference]');
  const context = root.querySelector<HTMLElement>('[data-za-context]');
  const contextTitle = root.querySelector<HTMLElement>('.za-context-title');
  const contextDetail = root.querySelector<HTMLElement>('.za-context-detail');
  if (
    messages === null ||
    input === null ||
    send === null ||
    stop === null ||
    preference === null ||
    context === null ||
    contextTitle === null ||
    contextDetail === null
  ) {
    throw new Error('Side Panel 初始化失败');
  }
  return { messages, input, send, stop, preference, context, contextTitle, contextDetail };
}

function startSidePanel(elements: SidePanelElements): void {
  let ui = createConversationUi(elements.messages);
  let port: chrome.runtime.Port | null = null;
  let boundGroupId: number | null = null;
  let windowId: number | null = null;
  let reconnectTimer: number | null = null;

  const clearEmpty = (): void => elements.messages.querySelector('.za-empty')?.remove();
  const send = (message: SidePanelToBackgroundMessage): void => {
    if (port === null) return;
    try {
      port.postMessage(message);
    } catch {
      port = null;
    }
  };

  const updateContext = (message: Extract<BackgroundToSidePanelMessage, { kind: 'task-context' }>): void => {
    elements.context.dataset['state'] = message.authorized ? 'ready' : 'outside';
    elements.contextTitle.textContent = message.authorized ? message.title ?? '任务页面已连接' : '当前页面不在任务组内';
    elements.contextDetail.textContent = message.url ?? `任务组 ${message.groupId}`;
  };

  const renderUiEvent = (event: SidePanelUiEvent): void => {
    clearEmpty();
    if (event.kind === 'status') {
      ui.showStatus(event.message);
    } else if (event.kind === 'user-echo') {
      ui.appendUserMessage(event.text);
    } else if (event.frame.type === 'text-delta') {
      ui.appendTextDelta(event.frame);
    } else if (event.frame.type === 'tool-card') {
      ui.renderToolCard(event.frame);
    } else {
      const frame = event.frame;
      void ui.promptHitl(frame).then((decision) => {
        send({ kind: 'hitl-decision', hitlId: frame.hitlId, decision });
      });
    }
  };

  const routeMessage = (raw: unknown): void => {
    const message = raw as BackgroundToSidePanelMessage;
    if (message.kind === 'task-context') {
      updateContext(message);
    } else if (message.kind === 'operation-state') {
      elements.stop.disabled = !message.running;
    } else if (message.kind === 'history-replay') {
      elements.messages.textContent = '';
      ui = createConversationUi(elements.messages);
      for (const event of message.events) renderUiEvent(event);
    } else if (message.kind === 'panel-ready') {
      elements.input.disabled = false;
      elements.send.disabled = false;
    } else {
      renderUiEvent(message);
    }
  };

  const announceBrowsingContext = async (): Promise<void> => {
    if (boundGroupId === null || windowId === null) return;
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    send({
      kind: 'browsing-context',
      groupId: tab?.groupId ?? TAB_GROUP_ID_NONE,
      ...(tab?.url !== undefined ? { url: tab.url } : {}),
      ...(tab?.title !== undefined ? { title: tab.title } : {}),
    });
  };

  const connect = (): void => {
    if (boundGroupId === null) return;
    const connected = chrome.runtime.connect({ name: SIDE_PANEL_PORT_NAME });
    port = connected;
    connected.onMessage.addListener(routeMessage);
    connected.onDisconnect.addListener(() => {
      if (port === connected) port = null;
      if (reconnectTimer !== null) return;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, 300);
    });
    connected.postMessage({ kind: 'panel-bind', groupId: boundGroupId } satisfies SidePanelToBackgroundMessage);
    void announceBrowsingContext();
  };

  const submit = (): void => {
    const text = elements.input.value.trim();
    if (text === '') return;
    elements.input.value = '';
    send({
      kind: 'user-message',
      text,
      executionPreference: elements.preference.value as ExecutionPreference,
    });
  };
  elements.send.addEventListener('click', submit);
  elements.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  });
  elements.stop.addEventListener('click', () => send({ kind: 'stop-operation' }));
  elements.preference.addEventListener('change', () => {
    void chrome.storage.local.set({ [EXECUTION_PREFERENCE_KEY]: elements.preference.value });
  });
  chrome.tabs.onActivated.addListener((activeInfo) => {
    if (activeInfo.windowId === windowId) void announceBrowsingContext();
  });
  window.setInterval(() => send({ kind: 'ping' }), 20000);

  void chrome.storage.local.get(EXECUTION_PREFERENCE_KEY).then((items) => {
    const stored = items[EXECUTION_PREFERENCE_KEY];
    if (typeof stored === 'string' && [...elements.preference.options].some((option) => option.value === stored)) {
      elements.preference.value = stored;
    }
  });

  void chrome.tabs.query({ active: true, currentWindow: true }).then(async ([tab]) => {
    if (tab?.windowId === undefined) return;
    windowId = tab.windowId;
    const key = panelGroupKey(windowId);
    const stored = (await chrome.storage.session.get(key))[key];
    const fallback = tab.groupId ?? TAB_GROUP_ID_NONE;
    boundGroupId = typeof stored === 'number' ? stored : fallback;
    if (boundGroupId === TAB_GROUP_ID_NONE) {
      elements.contextTitle.textContent = '没有可恢复的 Zen 任务';
      elements.contextDetail.textContent = '在目标页面点击 Zen 图标创建任务组';
      return;
    }
    connect();
  });
}

const root = document.getElementById('za-sidepanel');
if (root !== null) startSidePanel(mountSidePanel(root));
