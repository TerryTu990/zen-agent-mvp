import { isAssistableUrl, panelGroupKey, TAB_GROUP_ID_NONE } from './activation.js';
import {
  appendAttachmentsToPrompt,
  MAX_ATTACHMENT_COUNT,
  prepareAttachments,
} from './composer-attachments.js';
import { renderConfigDraftCard } from './config-draft-card.js';
import { createConversationUi, type UserMessageHandle } from './conversation-hitl.js';
import type { ExecutionPreference } from './frames.js';
import { renderInjectionView } from './injection-view.js';
import {
  SIDE_PANEL_PORT_NAME,
  type BackgroundToSidePanelMessage,
  type MessageDeliveryFailure,
  type SidePanelUiEvent,
  type SidePanelToBackgroundMessage,
} from './messaging.js';

const EXECUTION_PREFERENCE_KEY = 'za.executionPreference';
type PendingUserMessage = Extract<SidePanelToBackgroundMessage, { kind: 'user-message' }>;

/**
 * 提交瞬间落地的本地回显：气泡先出、输入框即刻清空，不等服务端回声。
 * draft/files 是撤下时还原输入框所需的草稿；handle 为 null 表示气泡已随历史重放被清掉，须重建。
 */
interface LocalEcho {
  messageId: string;
  text: string;
  draft: string;
  files: File[];
  handle: UserMessageHandle | null;
}
type TaskContextMessage = Extract<BackgroundToSidePanelMessage, { kind: 'task-context' }>;

export interface ContextHeaderView {
  state: 'waiting' | 'ready' | 'unassistable' | 'outside';
  title: string;
  detail: string;
}

/** 面板头部四态视图：message 为 null 表示已绑组但尚未收到上下文（waiting）。 */
export function contextHeaderView(message: TaskContextMessage | null, groupId: number): ContextHeaderView {
  if (message === null) {
    return { state: 'waiting', title: '正在连接任务页面', detail: `任务组 ${groupId}` };
  }
  if (!message.authorized) {
    return {
      state: 'outside',
      title: '当前页面不在任务组内',
      detail: message.url ?? `任务组 ${message.groupId}`,
    };
  }
  if (message.assistable === false) {
    return {
      state: 'unassistable',
      title: '此页面无法辅助',
      detail: '切换到站点页面，或让 Zen 导航后继续',
    };
  }
  return {
    state: 'ready',
    title: message.title ?? '任务页面已连接',
    detail: message.url ?? `任务组 ${message.groupId}`,
  };
}

/**
 * navigate 代执行开新页的瞬间 tab.url 尚未 commit（空值 + loading/pendingUrl）：
 * 此时不能据空 URL 判为不可辅助，应省略 assistable（缺省视为可辅助），等 URL commit 后 onUpdated 重报定态。
 */
export function urlPendingCommit(
  tab: { url?: string; status?: string; pendingUrl?: string } | undefined,
): boolean {
  if (tab === undefined) return false;
  const urlMissing = tab.url === undefined || tab.url === '';
  return urlMissing && (tab.status === 'loading' || tab.pendingUrl !== undefined);
}

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
  injection: HTMLElement;
  injectionToggle: HTMLButtonElement;
}

export function mountSidePanel(root: HTMLElement): SidePanelElements {
  root.innerHTML = `
    <section class="za-shell" aria-label="Zen Agent 控制台">
      <section class="za-context" data-za-context data-state="waiting" aria-live="polite">
        <span class="za-context-dot" aria-hidden="true"></span>
        <div class="za-context-copy">
          <div class="za-context-title">等待连接任务页面</div>
          <div class="za-context-detail">打开要辅助的站点后点击 Zen Agent 图标</div>
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
        <button class="za-injection-toggle" data-za-injection-toggle type="button" aria-expanded="false" aria-label="查看当前页面注入构成" title="查看当前页面注入构成">注入</button>
      </section>
      <section class="za-injection" data-za-injection aria-label="当前页面注入构成" aria-live="polite" hidden></section>
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
        <p class="za-composer-disclaimer">AI 也可能会犯错，请仔细检查回答</p>
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
  const injection = root.querySelector<HTMLElement>('[data-za-injection]');
  const injectionToggle = root.querySelector<HTMLButtonElement>('[data-za-injection-toggle]');
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
    contextDetail === null ||
    injection === null ||
    injectionToggle === null
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
    injection,
    injectionToggle,
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
  let preparingMessageId: string | null = null;
  let pendingMessageId: string | null = null;
  let pendingMessage: PendingUserMessage | null = null;
  let deliveryAwaiting = false;
  let localEcho: LocalEcho | null = null;
  let activeMessageId: string | null = null;
  const completedMessageIds = new Set<string>();
  const stoppedMessageIds = new Set<string>();
  const renderedMessageIds = new Set<string>();

  const deliveryFailureMessage = (failure: MessageDeliveryFailure | undefined, httpStatus: number | undefined): string => {
    switch (failure) {
      case 'configuration':
        return '扩展连接配置不完整，请在扩展设置中检查服务地址';
      case 'unauthorized':
        return '身份校验未通过，已尝试重新登录，请稍后重试';
      case 'session-expired':
        return '会话已失效，已准备重新连接，请直接重试';
      case 'session-interrupted':
        return '上一回合因服务重启中断，投递状态无法确认；请先核对订单或消息状态，再决定是否重新发送';
      case 'protocol-invalid':
        return '服务端安全握手失败，请检查服务地址或签名配置';
      case 'delivery-unknown':
        return '消息投递状态暂时无法确认；将使用同一消息编号安全重试';
      case 'unreachable':
        return '无法连接服务端，请检查网络和服务地址后重试';
      case 'server-rejected':
        return httpStatus === undefined ? '服务端拒绝了消息，请稍后重试' : `服务端拒绝了消息（HTTP ${httpStatus}），请稍后重试`;
      default:
        return '会话暂不可用，请重新打开该站点页面后重试';
    }
  };

  const isBusy = (): boolean => stopRequested || submitting || deliveryAwaiting || turnInProgress || operationRunning || hitlPending;

  const scrollMessagesToLatest = (): void => {
    window.requestAnimationFrame(() => {
      elements.messages.scrollTop = elements.messages.scrollHeight;
    });
  };

  const updateComposer = (): void => {
    const busy = isBusy();
    elements.input.disabled = !ready || submitting;
    elements.upload.disabled = !ready || busy;
    const mode = busy && !stopRequested ? 'stop' : busy ? 'waiting' : 'send';
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
    preparingMessageId = null;
    pendingMessageId = null;
    pendingMessage = null;
    deliveryAwaiting = false;
    localEcho = null;
    activeMessageId = null;
    completedMessageIds.clear();
    stoppedMessageIds.clear();
    renderedMessageIds.clear();
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

  const autosizeInput = (): void => {
    elements.input.style.height = 'auto';
    elements.input.style.height = `${Math.min(elements.input.scrollHeight, 144)}px`;
  };

  /** 提交即回显：气泡先出、草稿离开输入框，界面不再停在"内容还在输入框但已开始思考"的中间态。 */
  const showLocalEcho = (messageId: string, text: string): void => {
    clearEmpty();
    localEcho = { messageId, text, draft: elements.input.value, files: selectedFiles, handle: ui.appendUserMessage(text) };
    elements.input.value = '';
    autosizeInput();
    selectedFiles = [];
    renderAttachments();
  };

  /** 投递失败时撤下回显并还原草稿；程序化赋值不触发 input 事件，pendingMessage 得以保留供原样重试。 */
  const revertLocalEcho = (): void => {
    if (localEcho === null) return;
    localEcho.handle?.remove();
    elements.input.value = localEcho.draft;
    autosizeInput();
    selectedFiles = localEcho.files;
    localEcho = null;
    renderAttachments();
  };

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

  const closeInjection = (): void => {
    elements.injection.hidden = true;
    elements.injection.textContent = '';
    elements.injectionToggle.setAttribute('aria-expanded', 'false');
  };

  const applyContextHeader = (view: ContextHeaderView): void => {
    elements.context.dataset['state'] = view.state;
    elements.contextTitle.textContent = view.title;
    elements.contextDetail.textContent = view.detail;
  };

  const updateContext = (message: TaskContextMessage): void => {
    applyContextHeader(contextHeaderView(message, message.groupId));
  };

  const renderUiEvent = (event: SidePanelUiEvent): void => {
    clearEmpty();
    if (event.kind === 'status') {
      ui.showStatus(event.message);
    } else if (event.kind === 'user-echo') {
      if (event.messageId !== undefined) renderedMessageIds.add(event.messageId);
      const stopped = event.messageId !== undefined && stoppedMessageIds.delete(event.messageId);
      if (event.messageId !== undefined && event.messageId === pendingMessageId) {
        submitting = false;
        deliveryAwaiting = false;
        pendingMessageId = null;
        pendingMessage = null;
      }
      activeMessageId = stopped ? null : (event.messageId ?? null);
      turnInProgress = !stopped && (event.messageId === undefined || !completedMessageIds.has(event.messageId));
      // 本条已本地回显过：以服务端文本落定同一个气泡，不再追加第二个。
      const echoed = localEcho !== null && localEcho.messageId === event.messageId ? localEcho : null;
      if (echoed?.handle != null) echoed.handle.settle(event.text);
      else ui.appendUserMessage(event.text);
      if (echoed !== null) localEcho = null;
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
    } else if (event.frame.type === 'config-draft') {
      ui.hideThinking();
      renderConfigDraftCard(elements.messages, event.frame, (decision) => {
        send({ kind: 'config-decision', draftId: decision.draftId, decision: decision.decision });
      });
    } else {
      runningTools.clear();
      hitlPending = true;
      updateComposer();
      const frame = event.frame;
      void ui.promptHitl(frame).then((decision) => {
        if (decision !== null) send({ kind: 'hitl-decision', hitlId: frame.hitlId, decision });
      });
    }
    scrollMessagesToLatest();
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
      if (localEcho !== null) localEcho.handle = null;
      for (const event of message.events) renderUiEvent(event);
      // 重放不含这条（服务端尚未确认）时重建气泡，避免待投递的消息在重连后凭空消失。
      if (localEcho !== null) localEcho.handle = ui.appendUserMessage(localEcho.text);
    } else if (message.kind === 'panel-ready') {
      ready = true;
      if (deliveryAwaiting && pendingMessage !== null) {
        submitting = true;
        ui.showThinking();
        if (!send(pendingMessage)) {
          submitting = false;
          deliveryAwaiting = false;
          revertLocalEcho();
          ui.hideThinking();
          elements.composerNotice.textContent = '连接仍未恢复，草稿已保留，请稍后重试';
        }
      }
      updateComposer();
    } else if (message.kind === 'session-failed') {
      submitting = false;
      deliveryAwaiting = false;
      turnInProgress = false;
      revertLocalEcho();
      ui.hideThinking();
      elements.composerNotice.textContent = pendingMessage === null
        ? deliveryFailureMessage(message.failure, undefined)
        : `${deliveryFailureMessage(message.failure, undefined)}；草稿仍保留`;
      updateComposer();
    } else if (message.kind === 'message-result') {
      if (message.messageId !== pendingMessageId) return;
      submitting = false;
      deliveryAwaiting = false;
      if (message.accepted) {
        pendingMessage = null;
        pendingMessageId = null;
        activeMessageId = message.messageId;
        turnInProgress = !completedMessageIds.has(message.messageId);
      } else {
        revertLocalEcho();
        ui.hideThinking();
        if (message.failure === 'session-interrupted') {
          pendingMessage = null;
          pendingMessageId = null;
        }
        elements.composerNotice.textContent = `${deliveryFailureMessage(message.failure, message.httpStatus)}；草稿仍保留`;
      }
      updateComposer();
    } else if (message.kind === 'stop-result') {
      if (!message.accepted) {
        stopRequested = false;
        elements.composerNotice.textContent = '停止请求未被接受，请重试';
        updateComposer();
      } else {
        if (message.messageId !== undefined && !renderedMessageIds.has(message.messageId)) {
          stoppedMessageIds.add(message.messageId);
        }
        submitting = false;
        deliveryAwaiting = false;
        turnInProgress = false;
        operationRunning = false;
        stopRequested = false;
        hitlPending = false;
        runningTools.clear();
        preparingMessageId = null;
        pendingMessage = null;
        pendingMessageId = null;
        activeMessageId = null;
        elements.input.value = '';
        selectedFiles = [];
        renderAttachments();
        ui.hideThinking();
        ui.cancelHitl();
        elements.composerNotice.textContent = '当前任务已停止';
        updateComposer();
      }
    } else if (message.kind === 'hitl-result') {
      if (!message.accepted) elements.composerNotice.textContent = '确认结果未送达，确认卡已恢复，请重试';
    } else if (message.kind === 'injection-result') {
      // 抽屉已关闭说明用户已不再查看，迟到的响应直接丢弃。
      if (!elements.injection.hidden) {
        if (message.ok) renderInjectionView(elements.injection, message.description);
        else elements.injection.textContent = message.error;
      }
    } else {
      renderUiEvent(message);
    }
    scrollMessagesToLatest();
  };

  /**
   * 面板页也可被当普通标签页打开（开发/E2E）。那种形态下自身就是未分组的活动页，
   * 自我收起会把自己关掉，故先判形态：侧边栏中 getCurrent() 无当前标签页。
   */
  const runningAsSidePanel = chrome.tabs
    .getCurrent()
    .then((tab) => tab === undefined)
    .catch(() => false);

  const announceBrowsingContext = async (): Promise<void> => {
    if (boundGroupId === null || windowId === null) return;
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    // 切到未分组标签页即收起：面板只属于任务组。
    // 背景页按标签页关闭只能阻止面板在组外"被打开"，关不掉已经开着的面板——
    // 已打开的面板只有它自己能关。切到另一个 zen 组不在此列：那由背景页改绑处理。
    if ((tab?.groupId ?? TAB_GROUP_ID_NONE) === TAB_GROUP_ID_NONE && (await runningAsSidePanel)) {
      // 正式关闭 API（Chrome 141+）；旧版本无此方法时回退 window.close()。
      await (typeof chrome.sidePanel.close === 'function'
        ? chrome.sidePanel.close({ windowId }).catch(() => window.close())
        : Promise.resolve(window.close()));
      return;
    }
    send({
      kind: 'browsing-context',
      groupId: tab?.groupId ?? TAB_GROUP_ID_NONE,
      ...(tab?.url !== undefined ? { url: tab.url } : {}),
      ...(tab?.title !== undefined ? { title: tab.title } : {}),
      ...(urlPendingCommit(tab) ? {} : { assistable: isAssistableUrl(tab?.url) }),
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
    applyContextHeader(contextHeaderView(null, groupId));
    elements.messages.textContent = '';
    ui = createConversationUi(elements.messages);
    closeInjection();
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
      showLocalEcho(pendingMessage.messageId, pendingMessage.displayText ?? pendingMessage.text);
      ui.showThinking();
      scrollMessagesToLatest();
      if (!send(pendingMessage)) {
        submitting = false;
        deliveryAwaiting = false;
        pendingMessageId = null;
        revertLocalEcho();
        ui.hideThinking();
        elements.composerNotice.textContent = '连接已中断，草稿仍保留；重连后请重新发送';
      }
      updateComposer();
      return;
    }
    const files = [...selectedFiles];
    const messageId = crypto.randomUUID();
    preparingMessageId = messageId;
    pendingMessageId = messageId;
    submitting = true;
    elements.composerNotice.textContent = '';
    clearEmpty();
    ui.showThinking();
    scrollMessagesToLatest();
    updateComposer();
    let prepared: Awaited<ReturnType<typeof prepareAttachments>>;
    try {
      prepared = await prepareAttachments(files);
    } catch (error) {
      if (preparingMessageId !== messageId) return;
      preparingMessageId = null;
      pendingMessageId = null;
      submitting = false;
      ui.hideThinking();
      updateComposer();
      elements.composerNotice.textContent = error instanceof Error ? error.message : '附件读取失败';
      return;
    }
    if (preparingMessageId !== messageId) return;
    preparingMessageId = null;
    const displayText = text === '' ? `请查看附件：${prepared.map((file) => file.name).join('、')}` : text;
    const prompt = appendAttachmentsToPrompt(displayText, prepared);
    const echoText = prepared.length === 0 ? displayText : `${displayText}\n附件：${prepared.map((file) => file.name).join('、')}`;
    deliveryAwaiting = true;
    pendingMessage = {
      kind: 'user-message',
      messageId,
      text: prompt,
      ...(prepared.length > 0 ? { displayText: echoText } : {}),
      executionPreference: elements.preference.value as ExecutionPreference,
    };
    showLocalEcho(messageId, echoText);
    const sent = send(pendingMessage);
    if (!sent) {
      submitting = false;
      deliveryAwaiting = false;
      pendingMessageId = null;
      pendingMessage = null;
      revertLocalEcho();
      ui.hideThinking();
      elements.composerNotice.textContent = '连接已中断，草稿仍保留；重连后请重新发送';
      updateComposer();
      return;
    }
    updateComposer();
  };
  elements.action.addEventListener('click', () => {
    if (isBusy() && !stopRequested) {
      // 投递响应返回前 activeMessageId 仍可能指向上一回合；当前待投递编号优先。
      const messageId = pendingMessageId ?? activeMessageId;
      if (send({ kind: 'stop-operation', ...(messageId !== null ? { messageId } : {}) })) {
        if (preparingMessageId === messageId) preparingMessageId = null;
        stopRequested = true;
        updateComposer();
      }
      return;
    }
    if (isBusy()) return;
    void submit();
  });
  elements.injectionToggle.addEventListener('click', () => {
    if (!elements.injection.hidden) {
      closeInjection();
      return;
    }
    elements.injection.hidden = false;
    elements.injectionToggle.setAttribute('aria-expanded', 'true');
    elements.injection.textContent = '正在读取当前页面注入构成…';
    if (!send({ kind: 'injection-request' })) {
      elements.injection.textContent = '连接已中断，暂时无法读取当前页面注入构成';
    }
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
    autosizeInput();
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
  // 同 tab 地址栏导航/标题晚到也要跟随；按 changeInfo 键过滤，避免高频变更触发无谓的 tabs.query。
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (windowId === null || tab.windowId !== windowId || !tab.active) return;
    if (changeInfo.url === undefined && changeInfo.title === undefined && changeInfo.status === undefined) return;
    void announceBrowsingContext();
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
