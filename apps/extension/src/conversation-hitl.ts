import type { HitlDecisionValue, HitlRequestFrame, TextDeltaFrame, ToolCardFrame } from './frames.js';

export interface ConversationUi {
  appendTextDelta(frame: TextDeltaFrame): void;
  renderToolCard(frame: ToolCardFrame): void;
  /** 弹 HITL 卡片等用户裁决；客户端只呈现与回传、零治理判定。 */
  promptHitl(frame: HitlRequestFrame): Promise<HitlDecisionValue>;
}

export function createConversationUi(): ConversationUi {
  return {
    appendTextDelta() {
      throw new Error('NOT_IMPLEMENTED: M1 讲解闭环——会话 UI（流式气泡渲染）');
    },
    renderToolCard() {
      throw new Error('NOT_IMPLEMENTED: M3 代执行+HITL——工具卡片状态呈现');
    },
    promptHitl() {
      throw new Error('NOT_IMPLEMENTED: M3 代执行+HITL——HITL 卡片确认与 hitl-decision 回传');
    },
  };
}
