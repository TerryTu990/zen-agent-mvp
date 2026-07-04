import type { HitlDecisionValue, HitlRequestFrame, JsonObject, TextDeltaFrame, ToolCardFrame } from './frames.js';
import { renderMarkdown } from './markdown.js';

type ToolMode = NonNullable<ToolCardFrame['mode']>;

const MODE_LABEL: Record<ToolMode, string> = {
  client: '客户端发起',
  server: '服务端发起',
};

export interface ConversationUi {
  appendUserMessage(text: string): void;
  /** 回合首个 delta 开新 assistant 气泡并增量追加；用户再次发言即关闭当前回合。 */
  appendTextDelta(frame: TextDeltaFrame): void;
  /** 呈现可定位、不含 token/密钥值的错误或状态说明（SEC-04）。 */
  showStatus(message: string): void;
  renderToolCard(frame: ToolCardFrame): void;
  /** 弹 HITL 卡片等用户裁决；客户端只呈现与回传、零治理判定。 */
  promptHitl(frame: HitlRequestFrame): Promise<HitlDecisionValue>;
}

const STATUS_LABEL: Record<ToolCardFrame['status'], string> = {
  running: '执行中',
  succeeded: '已完成',
  failed: '未成功',
};

/** 面向用户的实参摘要；仅供 HITL 卡片呈现用户须知悉的将发生内容，不进 tool-card。 */
function summarizeParams(params: JsonObject): string {
  const entries = Object.entries(params);
  if (entries.length === 0) return '（无参数）';
  return entries
    .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
    .join('，');
}

/** dom 任务授权卡的功能级摘要：只呈现任务/摘要/步数，不铺字段细节（一任务一确认，adr-011）。 */
function summarizeDomTask(params: JsonObject): { title: string; detail: string } {
  const summary = typeof params['summary'] === 'string' ? params['summary'] : '';
  const steps = Array.isArray(params['steps']) ? params['steps'].length : 0;
  const count = `共 ${steps} 步页面操作`;
  return {
    title: String(params['task']),
    detail: summary === '' ? count : `${summary}（${count}）`,
  };
}

const WHO_LABEL: Record<'user' | 'assistant', string> = {
  user: '你',
  assistant: 'zen-agent',
};

export function createConversationUi(messages: HTMLElement): ConversationUi {
  // assistant 气泡内的 .mdlite 容器；累积原始文本每次 delta 后全量重渲染，保证 markdown 结构完整。
  let assistantBody: HTMLElement | null = null;
  let assistantRaw = '';
  // 当前流式中的 assistant 气泡（挂 .streaming 显闪烁光标）；无 done 帧，以去抖判定流结束。
  let streamingBub: HTMLElement | null = null;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  // 同一 toolCallId 的状态迁移就地更新同一张卡片，避免 running→succeeded 产生两张卡。
  const toolCards = new Map<string, HTMLElement>();
  // 工具卡按调用模式归组，同 mode 的卡进同一 section body。
  const toolGroups = new Map<ToolMode, HTMLElement>();

  const scrollToEnd = (): void => {
    messages.scrollTop = messages.scrollHeight;
  };

  const clearStreaming = (): void => {
    if (settleTimer !== null) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
    if (streamingBub !== null) {
      streamingBub.classList.remove('streaming');
      streamingBub = null;
    }
  };

  /** 每条消息＝wrapper[data-role] > .za-who 署名 + .za-bub 气泡；返回气泡供填充。 */
  const appendMessage = (role: 'user' | 'assistant'): HTMLElement => {
    const wrap = document.createElement('div');
    wrap.className = 'za-msg';
    wrap.dataset['role'] = role;
    const who = document.createElement('div');
    who.className = 'za-who';
    who.textContent = WHO_LABEL[role];
    const bub = document.createElement('div');
    bub.className = 'za-bub';
    wrap.append(who, bub);
    messages.append(wrap);
    return bub;
  };

  const ensureToolGroup = (mode: ToolMode): HTMLElement => {
    let body = toolGroups.get(mode) ?? null;
    if (body === null) {
      const section = document.createElement('div');
      section.className = 'za-toolgroup';
      section.dataset['mode'] = mode;
      const title = document.createElement('div');
      title.className = 'za-toolgroup-title';
      title.textContent = MODE_LABEL[mode];
      body = document.createElement('div');
      body.className = 'za-toolgroup-body';
      section.append(title, body);
      messages.append(section);
      toolGroups.set(mode, body);
    }
    return body;
  };

  return {
    appendUserMessage(text) {
      clearStreaming();
      const bubble = appendMessage('user');
      bubble.textContent = text;
      scrollToEnd();
      assistantBody = null;
      assistantRaw = '';
    },
    appendTextDelta(frame) {
      if (assistantBody === null) {
        const bubble = appendMessage('assistant');
        bubble.classList.add('streaming');
        streamingBub = bubble;
        assistantBody = document.createElement('div');
        assistantBody.className = 'za-md mdlite';
        bubble.append(assistantBody);
        assistantRaw = '';
      }
      assistantRaw += frame.delta;
      assistantBody.textContent = '';
      assistantBody.append(renderMarkdown(assistantRaw));
      scrollToEnd();
      // 去抖：最后一个 delta 后短暂静默即视为流结束，撤下光标（无 done 帧兜底）。
      if (settleTimer !== null) clearTimeout(settleTimer);
      settleTimer = setTimeout(clearStreaming, 700);
    },
    showStatus(message) {
      clearStreaming();
      const status = document.createElement('div');
      status.className = 'za-status';
      status.textContent = message;
      messages.append(status);
      messages.scrollTop = messages.scrollHeight;
    },
    renderToolCard(frame) {
      clearStreaming();
      let card = toolCards.get(frame.toolCallId) ?? null;
      if (card === null) {
        card = document.createElement('div');
        card.setAttribute('data-za-toolcard', '');
        card.className = 'za-toolcard';
        toolCards.set(frame.toolCallId, card);
        ensureToolGroup(frame.mode ?? 'client').append(card);
      }
      card.setAttribute('data-status', frame.status);
      card.textContent = `${STATUS_LABEL[frame.status]}：${frame.summary ?? frame.toolId}`;
      scrollToEnd();
    },
    promptHitl(frame) {
      clearStreaming();
      return new Promise<HitlDecisionValue>((resolve) => {
        const card = document.createElement('div');
        card.setAttribute('data-za-hitl', '');
        card.className = 'za-hitl';

        // 带 task 的是 dom 任务级授权：功能级呈现 + 说明"批准后本任务自动执行、可停止"。
        const domTask = typeof frame.params['task'] === 'string' ? summarizeDomTask(frame.params) : null;

        const title = document.createElement('div');
        title.className = 'za-hitl-title';
        title.textContent = domTask === null ? `需你确认：${frame.toolId}` : `需你授权：${domTask.title}`;

        const detail = document.createElement('div');
        detail.className = 'za-hitl-detail';
        detail.textContent = domTask === null ? summarizeParams(frame.params) : domTask.detail;

        const hint = domTask === null ? null : document.createElement('div');
        if (hint !== null) {
          hint.className = 'za-hitl-hint';
          hint.textContent = '授权后本任务内的后续页面操作将自动执行；执行中可随时点「停止」。';
        }

        const actions = document.createElement('div');
        actions.className = 'za-hitl-actions';
        const approve = document.createElement('button');
        approve.setAttribute('data-za-hitl-approve', '');
        approve.className = 'za-hitl-approve';
        approve.textContent = domTask === null ? '确认执行' : '授权执行';
        const reject = document.createElement('button');
        reject.setAttribute('data-za-hitl-reject', '');
        reject.className = 'za-hitl-reject';
        reject.textContent = '拒绝';
        actions.append(approve, reject);

        card.append(title, detail);
        if (hint !== null) card.append(hint);
        if (frame.reason !== undefined) {
          const reason = document.createElement('div');
          reason.className = 'za-hitl-reason';
          reason.textContent = frame.reason;
          card.append(reason);
        }
        card.append(actions);
        messages.append(card);
        messages.scrollTop = messages.scrollHeight;

        const settle = (decision: HitlDecisionValue) => {
          card.remove();
          resolve(decision);
        };
        approve.addEventListener('click', () => settle('approve'));
        reject.addEventListener('click', () => settle('reject'));
      });
    },
  };
}
