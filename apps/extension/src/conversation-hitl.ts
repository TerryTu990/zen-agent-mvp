import type { HitlDecisionValue, HitlRequestFrame, JsonObject, TextDeltaFrame, ToolCardFrame } from './frames.js';

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
  return entries.map(([key, value]) => `${key}: ${String(value)}`).join('，');
}

export function createConversationUi(messages: HTMLElement): ConversationUi {
  let assistantBubble: HTMLElement | null = null;
  // 同一 toolCallId 的状态迁移就地更新同一张卡片，避免 running→succeeded 产生两张卡。
  const toolCards = new Map<string, HTMLElement>();

  const appendBubble = (role: 'user' | 'assistant', text: string): HTMLElement => {
    const bubble = document.createElement('div');
    bubble.className = 'za-msg';
    bubble.dataset['role'] = role;
    bubble.textContent = text;
    messages.append(bubble);
    messages.scrollTop = messages.scrollHeight;
    return bubble;
  };

  return {
    appendUserMessage(text) {
      appendBubble('user', text);
      assistantBubble = null;
    },
    appendTextDelta(frame) {
      assistantBubble ??= appendBubble('assistant', '');
      assistantBubble.textContent += frame.delta;
      messages.scrollTop = messages.scrollHeight;
    },
    showStatus(message) {
      const status = document.createElement('div');
      status.className = 'za-status';
      status.textContent = message;
      messages.append(status);
      messages.scrollTop = messages.scrollHeight;
    },
    renderToolCard(frame) {
      let card = toolCards.get(frame.toolCallId) ?? null;
      if (card === null) {
        card = document.createElement('div');
        card.setAttribute('data-za-toolcard', '');
        card.className = 'za-toolcard';
        toolCards.set(frame.toolCallId, card);
        messages.append(card);
      }
      card.setAttribute('data-status', frame.status);
      card.textContent = `${STATUS_LABEL[frame.status]}：${frame.summary ?? frame.toolId}`;
      messages.scrollTop = messages.scrollHeight;
    },
    promptHitl(frame) {
      return new Promise<HitlDecisionValue>((resolve) => {
        const card = document.createElement('div');
        card.setAttribute('data-za-hitl', '');
        card.className = 'za-hitl';

        const title = document.createElement('div');
        title.className = 'za-hitl-title';
        title.textContent = `需你确认：${frame.toolId}`;

        const detail = document.createElement('div');
        detail.className = 'za-hitl-detail';
        detail.textContent = summarizeParams(frame.params);

        const actions = document.createElement('div');
        actions.className = 'za-hitl-actions';
        const approve = document.createElement('button');
        approve.setAttribute('data-za-hitl-approve', '');
        approve.className = 'za-hitl-approve';
        approve.textContent = '确认执行';
        const reject = document.createElement('button');
        reject.setAttribute('data-za-hitl-reject', '');
        reject.className = 'za-hitl-reject';
        reject.textContent = '拒绝';
        actions.append(approve, reject);

        card.append(title, detail);
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
