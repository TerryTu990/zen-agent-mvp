import type { HitlDecisionValue, HitlRequestFrame, TextDeltaFrame, ToolCardFrame } from './frames.js';

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

export function createConversationUi(messages: HTMLElement): ConversationUi {
  let assistantBubble: HTMLElement | null = null;

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
    renderToolCard() {
      throw new Error('NOT_IMPLEMENTED: M3 代执行+HITL——工具卡片状态呈现');
    },
    promptHitl() {
      throw new Error('NOT_IMPLEMENTED: M3 代执行+HITL——HITL 卡片确认与 hitl-decision 回传');
    },
  };
}
