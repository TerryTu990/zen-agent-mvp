import { panelGroupKey, TAB_GROUP_ID_NONE } from './activation.js';
import {
  appendAttachmentsToPrompt,
  MAX_ATTACHMENT_COUNT,
  prepareAttachments,
} from './composer-attachments.js';
import { createConversationUi } from './conversation-hitl.js';
import type { ExecutionPreference } from './frames.js';
import {
  SIDE_PANEL_PORT_NAME,
  type BackgroundToSidePanelMessage,
  type SidePanelUiEvent,
  type SidePanelToBackgroundMessage,
} from './messaging.js';

const EXECUTION_PREFERENCE_KEY = 'za.executionPreference';

export interface SidePanelElements {
  messages: HTMLElement;
  input: HTMLTextAreaElement;
  action: HTMLButtonElement;
  upload: HTMLButtonElement;
  fileInput: HTMLInputElement;
  attachments: HTMLElement;
  composerNotice: HTMLElement;
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
        <div class="za-brand"><h1>Zen Commerce Agent</h1><p>电商智能体</p></div>
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
        <div class="za-composer-surface" data-za-composer-state="idle">
          <div class="za-attachments" data-za-attachments hidden></div>
          <textarea id="za-input" rows="1" aria-label="给 Zen 发送消息" placeholder="向 Zen 交代任务…" disabled></textarea>
          <div class="za-composer-actions">
            <button class="za-icon-button za-upload" data-za-upload type="button" aria-label="上传文件" title="上传文本文件" disabled>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
            </button>
            <span class="za-composer-hint">Enter 发送 · Shift Enter 换行</span>
            <button class="za-action-button" data-za-action type="button" aria-label="发送消息" disabled>
              <svg class="za-send-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m0 0-6 6m6-6 6 6" /></svg>
              <span class="za-stop-icon" aria-hidden="true"></span>
            </button>
          </div>
        </div>
        <input data-za-file-input type="file" accept=".txt,.md,.csv,.json,.log,.xml,.yaml,.yml,text/*,application/json" multiple hidden />
        <div class="za-composer-notice" data-za-composer-notice aria-live="polite"></div>
      </footer>
    </section>`;
  const messages = root.querySelector<HTMLElement>('[data-za-messages]');
  const input = root.querySelector<HTMLTextAreaElement>('#za-input');
  const action = root.querySelector<HTMLButtonElement>('[data-za-action]');
  const upload = root.querySelector<HTMLButtonElement>('[data-za-upload]');
  const fileInput = root.querySelector<HTMLInputElement>('[data-za-file-input]');
  const attachments = root.querySelector<HTMLElement>('[data-za-attachments]');
  const composerNotice = root.querySelector<HTMLElement>('[data-za-composer-notice]');
  const preference = root.querySelector<HTMLSelectElement>('[data-za-preference]');
  const context = root.querySelector<HTMLElement>('[data-za-context]');
  const contextTitle = root.querySelector<HTMLElement>('.za-context-title');
  const contextDetail = root.querySelector<HTMLElement>('.za-context-detail');
  if (
    messages === null ||
    input === null ||
    action === null ||
    upload === null ||
    fileInput === null ||
    attachments === null ||
    composerNotice === null ||
    preference === null ||
    context === null ||
    contextTitle === null ||
    contextDetail === null
  ) {
    throw new Error('Side Panel 初始化失败');
  }
  return {
    messages,
    input,
    action,
    upload,
    fileInput,
    attachments,
    composerNotice,
    preference,
    context,
    contextTitle,
    contextDetail,
  };
}

export function startSidePanel(elements: SidePanelElements): void {
  let ui = createConversationUi(elements.messages);
  let port: chrome.runtime.Port | null = null;
  let boundGroupId: number | null = null;
  let windowId: number | null = null;
  let reconnectTimer: number | null = null;
  let connectionGeneration = 0;
  let ready = false;
  let awaitingResponse = false;
  let streamActive = false;
  let toolRunning = false;
  let operationRunning = false;
  let streamSettleTimer: number | null = null;
  let selectedFiles: File[] = [];

  const isBusy = (): boolean => awaitingResponse || streamActive || toolRunning || operationRunning;

  const updateComposer = (): void => {
    const busy = isBusy();
    elements.input.disabled = !ready;
    elements.upload.disabled = !ready || busy;
    elements.action.disabled = !ready || (!busy && elements.input.value.trim() === '' && selectedFiles.length === 0);
    elements.action.dataset['mode'] = busy ? 'stop' : 'send';
    elements.action.setAttribute('aria-label', busy ? '停止当前操作' : '发送消息');
    elements.action.closest<HTMLElement>('.za-composer-surface')?.setAttribute('data-za-composer-state', busy ? 'busy' : 'idle');
  };

  const resetActivity = (): void => {
    if (streamSettleTimer !== null) {
      window.clearTimeout(streamSettleTimer);
      streamSettleTimer = null;
    }
    awaitingResponse = false;
    streamActive = false;
    toolRunning = false;
    operationRunning = false;
    ui.hideThinking();
    updateComposer();
  };

  const renderAttachments = (): void => {
    elements.attachments.textContent = '';
    elements.attachments.hidden = selectedFiles.length === 0;
    selectedFiles.forEach((file, index) => {
      const chip = document.createElement('span');
      chip.className = 'za-attachment-chip';
      const name = document.createElement('span');
      name.textContent = file.name;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.setAttribute('aria-label', `移除附件 ${file.name}`);
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        selectedFiles.splice(index, 1);
        renderAttachments();
        updateComposer();
      });
      chip.append(name, remove);
      elements.attachments.append(chip);
    });
  };

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
      awaitingResponse = false;
      streamActive = false;
      ui.hideThinking();
      updateComposer();
      ui.showStatus(event.message);
    } else if (event.kind === 'user-echo') {
      ui.appendUserMessage(event.text);
      if (awaitingResponse) ui.showThinking();
    } else if (event.frame.type === 'text-delta') {
      awaitingResponse = false;
      streamActive = true;
      ui.hideThinking();
      ui.appendTextDelta(event.frame);
      updateComposer();
      if (streamSettleTimer !== null) window.clearTimeout(streamSettleTimer);
      streamSettleTimer = window.setTimeout(() => {
        streamActive = false;
        updateComposer();
      }, 900);
    } else if (event.frame.type === 'tool-card') {
      awaitingResponse = false;
      streamActive = false;
      toolRunning = event.frame.status === 'running';
      ui.renderToolCard(event.frame);
      updateComposer();
    } else {
      awaitingResponse = false;
      streamActive = false;
      toolRunning = false;
      updateComposer();
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
      operationRunning = message.running;
      updateComposer();
    } else if (message.kind === 'history-replay') {
      elements.messages.textContent = '';
      ui = createConversationUi(elements.messages);
      for (const event of message.events) renderUiEvent(event);
    } else if (message.kind === 'panel-ready') {
      ready = true;
      updateComposer();
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
    const groupId = boundGroupId;
    const generation = connectionGeneration;
    const connected = chrome.runtime.connect({ name: SIDE_PANEL_PORT_NAME });
    port = connected;
    connected.onMessage.addListener(routeMessage);
    connected.onDisconnect.addListener(() => {
      if (port === connected) port = null;
      if (generation !== connectionGeneration) return;
      if (reconnectTimer !== null) return;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, 300);
    });
    connected.postMessage({ kind: 'panel-bind', groupId } satisfies SidePanelToBackgroundMessage);
    void announceBrowsingContext();
  };

  const bindGroup = (groupId: number): void => {
    if (groupId === TAB_GROUP_ID_NONE || (boundGroupId === groupId && port !== null)) return;
    connectionGeneration += 1;
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const previous = port;
    port = null;
    previous?.disconnect();
    boundGroupId = groupId;
    elements.context.dataset['groupId'] = String(groupId);
    elements.context.dataset['state'] = 'waiting';
    elements.contextTitle.textContent = '正在连接任务页面';
    elements.contextDetail.textContent = `任务组 ${groupId}`;
    elements.messages.textContent = '';
    ui = createConversationUi(elements.messages);
    ready = false;
    resetActivity();
    connect();
  };

  const submit = async (): Promise<void> => {
    const text = elements.input.value.trim();
    if ((text === '' && selectedFiles.length === 0) || isBusy()) return;
    elements.composerNotice.textContent = '';
    let prepared: Awaited<ReturnType<typeof prepareAttachments>>;
    try {
      prepared = await prepareAttachments(selectedFiles);
    } catch (error) {
      elements.composerNotice.textContent = error instanceof Error ? error.message : '附件读取失败';
      return;
    }
    const displayText = text === '' ? `请查看附件：${prepared.map((file) => file.name).join('、')}` : text;
    const prompt = appendAttachmentsToPrompt(displayText, prepared);
    elements.input.value = '';
    selectedFiles = [];
    renderAttachments();
    awaitingResponse = true;
    updateComposer();
    clearEmpty();
    ui.showThinking();
    send({
      kind: 'user-message',
      text: prompt,
      ...(prepared.length > 0 ? { displayText: `${displayText}\n附件：${prepared.map((file) => file.name).join('、')}` } : {}),
      executionPreference: elements.preference.value as ExecutionPreference,
    });
  };
  elements.action.addEventListener('click', () => {
    if (isBusy()) {
      send({ kind: 'stop-operation' });
      resetActivity();
      return;
    }
    void submit();
  });
  elements.upload.addEventListener('click', () => elements.fileInput.click());
  elements.fileInput.addEventListener('change', () => {
    const additions = [...(elements.fileInput.files ?? [])];
    elements.fileInput.value = '';
    if (selectedFiles.length + additions.length > MAX_ATTACHMENT_COUNT) {
      elements.composerNotice.textContent = `每次最多上传 ${MAX_ATTACHMENT_COUNT} 个文件`;
      return;
    }
    selectedFiles.push(...additions);
    elements.composerNotice.textContent = '';
    renderAttachments();
    updateComposer();
  });
  elements.input.addEventListener('input', () => {
    elements.input.style.height = 'auto';
    elements.input.style.height = `${Math.min(elements.input.scrollHeight, 144)}px`;
    updateComposer();
  });
  elements.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  });
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
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'session') return;
      const changed = changes[key]?.newValue;
      if (typeof changed === 'number') bindGroup(changed);
    });
    const stored = (await chrome.storage.session.get(key))[key];
    const fallback = tab.groupId ?? TAB_GROUP_ID_NONE;
    const initialGroupId = typeof stored === 'number' ? stored : fallback;
    if (initialGroupId === TAB_GROUP_ID_NONE) {
      elements.contextTitle.textContent = '没有可恢复的 Zen 任务';
      elements.contextDetail.textContent = '在目标页面点击 Zen 图标创建任务组';
      return;
    }
    bindGroup(initialGroupId);
  });
}

const root = document.getElementById('za-sidepanel');
if (root !== null) startSidePanel(mountSidePanel(root));
