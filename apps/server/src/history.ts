/**
 * 会话历史瘦身（ADR-013 P0）：落 history 时全历史仅保留最近一次 page_snapshot 观测全文，
 * 更早的快照观测替换为一行存根——旧 ref 随重采集失效，留存只烧 token 并诱导误引用。
 * 快照观测的判别不靠观测内容字符串猜测，而靠结构：其 toolCallId 关联的 assistant 回声
 * toolCall.name 为快照工具（非快照工具观测如 page-operate 据此原样保留）。
 */
import type { LlmMessage } from '@zen-agent/contracts';

export const SNAPSHOT_TOOL_NAME = 'page_snapshot';

/** 存根内容：N=该快照元素数（解析本模块自建的观测 JSON 得出，非启发式猜测）。 */
function snapshotStub(content: string): string {
  let count = 0;
  try {
    const parsed = JSON.parse(content) as { elements?: unknown };
    if (Array.isArray(parsed.elements)) count = parsed.elements.length;
  } catch {
    count = 0;
  }
  return `[快照已过期：${count} 元素，refs 失效]`;
}

/**
 * 返回瘦身后的新历史（不改动入参对象——回合内 messages 只追加不回改的护栏在调用侧，
 * 本函数只在回合落盘边界产出替换后的新数组）。无快照观测时原样返回入参引用。
 */
export function pruneStaleSnapshots(history: LlmMessage[]): LlmMessage[] {
  const snapshotCallIds = new Set<string>();
  for (const message of history) {
    if (message.role !== 'assistant' || message.toolCalls === undefined) continue;
    for (const call of message.toolCalls) {
      if (call.name === SNAPSHOT_TOOL_NAME) snapshotCallIds.add(call.id);
    }
  }
  const isSnapshotObs = (message: LlmMessage): boolean =>
    message.role === 'tool' &&
    message.toolCallId !== undefined &&
    snapshotCallIds.has(message.toolCallId);

  let lastSnapshotIndex = -1;
  history.forEach((message, index) => {
    if (isSnapshotObs(message)) lastSnapshotIndex = index;
  });
  if (lastSnapshotIndex === -1) return history;

  return history.map((message, index) =>
    index !== lastSnapshotIndex && isSnapshotObs(message)
      ? { ...message, content: snapshotStub(message.content) }
      : message,
  );
}
