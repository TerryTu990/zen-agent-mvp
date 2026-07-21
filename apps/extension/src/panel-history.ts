import type { SidePanelUiEvent } from './messaging.js';

export function reducePanelHistory(
  history: readonly SidePanelUiEvent[],
  event: SidePanelUiEvent,
): SidePanelUiEvent[] {
  if (event.kind === 'frame' && event.frame.type === 'text-delta') {
    const last = history[history.length - 1];
    if (last?.kind === 'frame' && last.frame.type === 'text-delta') {
      return [
        ...history.slice(0, -1),
        { kind: 'frame', frame: { ...event.frame, delta: last.frame.delta + event.frame.delta } },
      ];
    }
  }
  if (event.kind === 'frame' && event.frame.type === 'tool-card') {
    const toolCallId = event.frame.toolCallId;
    const index = history.findIndex(
      (item) =>
        item.kind === 'frame' &&
        item.frame.type === 'tool-card' &&
        item.frame.toolCallId === toolCallId,
    );
    if (index !== -1) {
      return history.map((item, itemIndex) => (itemIndex === index ? event : item));
    }
  }
  return [...history, event];
}

export function removeSettledHitl(
  history: readonly SidePanelUiEvent[],
  hitlId: string,
): SidePanelUiEvent[] {
  return history.filter(
    (item) => !(item.kind === 'frame' && item.frame.type === 'hitl-request' && item.frame.hitlId === hitlId),
  );
}
