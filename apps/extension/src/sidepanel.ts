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
  type MessageDeliveryFailure,
  type SidePanelUiEvent,
  type SidePanelToBackgroundMessage,
} from './messaging.js';

const EXECUTION_PREFERENCE_KEY = 'za.executionPreference';
type PendingUserMessage = Extract<SidePanelToBackgroundMessage, { kind: 'user-message' }>;

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
            <button class="za-icon-button za-upload" data-za-upload type="button" aria-label="上传知识文档" title="上传 Markdown 或纯文本知识文档" disabled>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
            </button>
            <span class="za-composer-hint">Enter 发送 · Shift Enter 换行</span>
            <button class="za-action-button" data-za-action type="button" aria-label="发送消息" disabled>
              <svg class="za-send-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m0 0-6 6m6-6 6 6" /></svg>
              <span class="za-wait-icon" aria-hidden="true"></span>
              <span class="za-stop-icon" aria-hidden="true"></span>
            </button>
          </div>
        </div>
        <input data-za-file-input type="file" accept=".txt,.md,text/plain,text/markdown" multiple hidden />
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
  let submitting = false;
  let turnInProgress = false;
  const runningTools = new Set<string>();
  let operationRunning = false;
  let stopRequested = false;
  let hitlPending = false;
  let selectedFiles: File[] = [];
  let pendingMessageId: string | null = null;
  let pendingMessage: PendingUserMessage | null = null;
  let deliveryAwaiting = false;
  let activeMessageId: string | null = null;
  const completedMessageIds = new Set<string>();

  const deliveryFailureMessage = (failure: MessageDeliveryFailure | undefined, httpStatus: number | undefined): string => {
    switch (failure) {
      case 'configuration':
        return '扩展连接配置不完整，请在扩展设置中检查访问令牌和服务地址';
      case 'unauthorized':
        return '访问令牌无效或已过期，请在扩展设置中更新后重试';
      case 'session-expired':
        return '会话已失效，已准备重新连接，请直接重试';
      case 'protocol-invalid':
        return '服务端安全握手失败，请检查服务地址或签名配置';
      case 'delivery-unknown':
        return '消息投递状态暂时无法确认；将使用同一消息编号安全重试';
      case 'unreachable':
        return '无法连接服务端，请检查网络和服务地址后重试';
      case 'server-rejected':
        return httpStatus === undefined ? '服务端拒绝了消息，请稍后重试' : `服务端拒绝了消息（HTTP ${httpStatus}），请稍后重试`;
      default:
        return '会话暂不可用，请重新打开闲鱼页面后重试';
    }
  };

  const isBusy = (): boolean => submitting || deliveryAwaiting || turnInProgress || operationRunning || hitlPending;

  const updateComposer = (): void => {
    const busy = isBusy();
    elements.input.disabled = !ready || submitting;
    elements.upload.disabled = !ready || busy;
    const mode = operationRunning && !stopRequested ? 'stop' : busy ? 'waiting' : 'send';
    elements.action.disabled = !ready || mode === 'waiting' || (mode === 'send' && elements.input.value.trim() === '' && selectedFiles.length === 0);
    elements.action.dataset['mode'] = mode;
    elements.action.setAttribute('aria-label', mode === 'stop' ? '停止当前操作' : mode === 'waiting' ? '正在处理' : '发送消息');
    elements.action.closest<HTMLElement>('.za-composer-surface')?.setAttribute('data-za-composer-state', busy ? 'busy' : 'idle');
  };

  const resetActivity = (): void => {
    submitting = false;
    turnInProgress = false;
    runningTools.clear();
    operationRunning = false;
    stopRequested = false;
    hitlPending = false;
    pendingMessageId = null;
    pendingMessage = null;
    deliveryAwaiting = false;
    activeMessageId = null;
    completedMessageIds.clear();
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
        pendingMessage = null;
        pendingMessageId = null;
        deliveryAwaiting = false;
        selectedFiles.splice(index, 1);
        if (selectedFiles.length === 0) elements.composerNotice.textContent = '';
        renderAttachments();
        updateComposer();
      });
      chip.append(name, remove);
      elements.attachments.append(chip);
    });
  };

  const clearEmpty = (): void => elements.messages.querySelector('.za-empty')?.remove();
  const send = (message: SidePanelToBackgroundMessage): boolean => {
    if (port === null) return false;
    try {
      port.postMessage(message);
      return true;
    } catch {
      port = null;
      ready = false;
      updateComposer();
      return false;
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
      if (event.messageId !== undefined && event.messageId === pendingMessageId) {
        submitting = false;
        deliveryAwaiting = false;
        pendingMessageId = null;
        pendingMessage = null;
        elements.input.value = '';
        selectedFiles = [];
        renderAttachments();
      }
      activeMessageId = event.messageId ?? null;
      turnInProgress = event.messageId === undefined || !completedMessageIds.has(event.messageId);
      ui.appendUserMessage(event.text);
      if (turnInProgress) ui.showThinking();
      updateComposer();
    } else if (event.frame.type === 'text-delta') {
      ui.hideThinking();
      ui.appendTextDelta(event.frame);
    } else if (event.frame.type === 'turn-complete') {
      if (event.frame.messageId !== undefined) completedMessageIds.add(event.frame.messageId);
      if (event.frame.idle) {
        turnInProgress = false;
        activeMessageId = null;
        runningTools.clear();
        hitlPending = false;
        ui.hideThinking();
      } else if (event.frame.messageId !== undefined && event.frame.messageId === activeMessageId) {
        turnInProgress = true;
      }
      updateComposer();
    } else if (event.frame.type === 'tool-card') {
      if (event.frame.status === 'running') runningTools.add(event.frame.toolCallId);
      else runningTools.delete(event.frame.toolCallId);
      ui.renderToolCard(event.frame);
      updateComposer();
    } else {
      runningTools.clear();
      hitlPending = true;
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
      if (!message.running) stopRequested = false;
      updateComposer();
    } else if (message.kind === 'history-replay') {
      elements.messages.textContent = '';
      ui = createConversationUi(elements.messages);
      for (const event of message.events) renderUiEvent(event);
    } else if (message.kind === 'panel-ready') {
      ready = true;
      if (deliveryAwaiting && pendingMessage !== null) {
        submitting = true;
        ui.showThinking();
        if (!send(pendingMessage)) {
          submitting = false;
          deliveryAwaiting = false;
          ui.hideThinking();
          elements.composerNotice.textContent = '连接仍未恢复，草稿已保留，请稍后重试';
        }
      }
      updateComposer();
    } else if (message.kind === 'session-failed') {
      submitting = false;
      deliveryAwaiting = false;
      turnInProgress = false;
      ui.hideThinking();
      elements.composerNotice.textContent = `${deliveryFailureMessage(message.failure, undefined)}；草稿仍保留`;
      updateComposer();
    } else if (message.kind === 'message-result') {
      if (message.messageId !== pendingMessageId) return;
      submitting = false;
      deliveryAwaiting = false;
      if (message.accepted) {
        elements.input.value = '';
        selectedFiles = [];
        renderAttachments();
        pendingMessage = null;
        pendingMessageId = null;
        activeMessageId = message.messageId;
        turnInProgress = !completedMessageIds.has(message.messageId);
      } else {
        ui.hideThinking();
        elements.composerNotice.textContent = `${deliveryFailureMessage(message.failure, message.httpStatus)}；草稿仍保留`;
      }
      updateComposer();
    } else if (message.kind === 'hitl-result') {
      if (!message.accepted) elements.composerNotice.textContent = '确认结果未送达，确认卡已恢复，请重试';
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
      if (port === connected) {
        port = null;
        ready = false;
        updateComposer();
      }
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
    if (pendingMessage !== null) {
      submitting = true;
      pendingMessageId = pendingMessage.messageId;
      deliveryAwaiting = true;
      elements.composerNotice.textContent = '';
      ui.showThinking();
      if (!send(pendingMessage)) {
        submitting = false;
        deliveryAwaiting = false;
        pendingMessageId = null;
        ui.hideThinking();
        elements.composerNotice.textContent = '连接已中断，草稿仍保留；重连后请重新发送';
      }
      updateComposer();
      return;
    }
    const files = [...selectedFiles];
    submitting = true;
    elements.composerNotice.textContent = '';
    clearEmpty();
    ui.showThinking();
    updateComposer();
    let prepared: Awaited<ReturnType<typeof prepareAttachments>>;
    try {
      prepared = await prepareAttachments(files);
    } catch (error) {
      submitting = false;
      ui.hideThinking();
      updateComposer();
      elements.composerNotice.textContent = error instanceof Error ? error.message : '附件读取失败';
      return;
    }
    const displayText = text === '' ? `请查看附件：${prepared.map((file) => file.name).join('、')}` : text;
    const prompt = appendAttachmentsToPrompt(displayText, prepared);
    const messageId = crypto.randomUUID();
    pendingMessageId = messageId;
    deliveryAwaiting = true;
    pendingMessage = {
      kind: 'user-message',
      messageId,
      text: prompt,
      ...(prepared.length > 0 ? { displayText: `${displayText}\n附件：${prepared.map((file) => file.name).join('、')}` } : {}),
      executionPreference: elements.preference.value as ExecutionPreference,
    };
    const sent = send(pendingMessage);
    if (!sent) {
      submitting = false;
      deliveryAwaiting = false;
      pendingMessageId = null;
      pendingMessage = null;
      ui.hideThinking();
      elements.composerNotice.textContent = '连接已中断，草稿仍保留；重连后请重新发送';
      updateComposer();
      return;
    }
    updateComposer();
  };
  elements.action.addEventListener('click', () => {
    if (operationRunning && !stopRequested) {
      if (send({ kind: 'stop-operation' })) {
        stopRequested = true;
        updateComposer();
      }
      return;
    }
    if (isBusy()) return;
    void submit();
  });
  elements.upload.addEventListener('click', () => elements.fileInput.click());
  elements.fileInput.addEventListener('change', () => {
    pendingMessage = null;
    pendingMessageId = null;
    deliveryAwaiting = false;
    const additions = [...(elements.fileInput.files ?? [])];
    elements.fileInput.value = '';
    if (selectedFiles.length + additions.length > MAX_ATTACHMENT_COUNT) {
      elements.composerNotice.textContent = `每次最多上传 ${MAX_ATTACHMENT_COUNT} 个文件`;
      return;
    }
    selectedFiles.push(...additions);
    elements.composerNotice.textContent = '知识文档内容会发送给智能体；请勿上传卡密库存、令牌或凭证';
    renderAttachments();
    updateComposer();
  });
  elements.input.addEventListener('input', () => {
    pendingMessage = null;
    pendingMessageId = null;
    deliveryAwaiting = false;
    elements.input.style.height = 'auto';
    elements.input.style.height = `${Math.min(elements.input.scrollHeight, 144)}px`;
    updateComposer();
  });
  elements.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void submit();
    }
  });
  elements.preference.addEventListener('change', () => {
    pendingMessage = null;
    pendingMessageId = null;
    deliveryAwaiting = false;
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
