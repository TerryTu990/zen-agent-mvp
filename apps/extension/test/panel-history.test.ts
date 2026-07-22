import { describe, expect, it } from 'vitest';
import type { SidePanelUiEvent } from '../src/messaging.js';
import { reducePanelHistory, removeSettledHitl } from '../src/panel-history.js';

describe('Side Panel UI 历史', () => {
  it('持久化回合完成信号供重连时恢复 idle 状态', () => {
    const history: SidePanelUiEvent[] = [{ kind: 'user-echo', text: '问题' }];
    const completed: SidePanelUiEvent = { kind: 'frame', frame: { type: 'turn-complete', sessionId: 's1', idle: true } };

    expect(reducePanelHistory(history, completed)).toEqual([...history, completed]);
  });

  it('连续文本增量合并，用户消息之后开启下一段 assistant 文本', () => {
    let history: SidePanelUiEvent[] = [];
    history = reducePanelHistory(history, { kind: 'frame', frame: { type: 'text-delta', sessionId: 's1', delta: '你' } });
    history = reducePanelHistory(history, { kind: 'frame', frame: { type: 'text-delta', sessionId: 's1', delta: '好' } });
    history = reducePanelHistory(history, { kind: 'user-echo', text: '下一问' });
    history = reducePanelHistory(history, { kind: 'frame', frame: { type: 'text-delta', sessionId: 's1', delta: '答' } });
    expect(history).toHaveLength(3);
    expect(history[0]).toMatchObject({ kind: 'frame', frame: { delta: '你好' } });
  });

  it('同一工具卡状态就地替换，避免重开后显示重复卡片', () => {
    const running: SidePanelUiEvent = {
      kind: 'frame',
      frame: { type: 'tool-card', sessionId: 's1', toolCallId: 'tc1', toolId: 't', status: 'running' },
    };
    const succeeded: SidePanelUiEvent = {
      kind: 'frame',
      frame: { type: 'tool-card', sessionId: 's1', toolCallId: 'tc1', toolId: 't', status: 'succeeded' },
    };
    expect(reducePanelHistory(reducePanelHistory([], running), succeeded)).toEqual([succeeded]);
  });

  it('HITL 裁决后从可重放历史移除', () => {
    const history: SidePanelUiEvent[] = [
      {
        kind: 'frame',
        frame: { type: 'hitl-request', sessionId: 's1', hitlId: 'h1', toolId: 't', params: {} },
      },
    ];
    expect(removeSettledHitl(history, 'h1')).toEqual([]);
  });
});
