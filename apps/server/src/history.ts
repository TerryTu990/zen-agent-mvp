/**
 * 会话历史瘦身（ADR-013 P0）：落 history 时全历史仅保留最近一次 page_snapshot 观测全文，
 * 更早的快照观测替换为一行存根——旧 ref 随重采集失效，留存只烧 token 并诱导误引用。
 * 快照观测的判别不靠观测内容字符串猜测，而靠结构：其 toolCallId 关联的 assistant 回声
 * toolCall.name 为快照工具（非快照工具观测如 page-operate 据此原样保留）。
 * 保留集的粒度由 keyOf 决定：缺省全历史一份（落盘边界口径，跨回合按页并存无意义且无界增长），
 * 传入 snapshotPageKey 则每个观察目标各留最近一份（回合内请求视图口径，adr-023 同回合读多页后比对）。
 */
import type { LlmMessage } from '@zen-agent/contracts';
import { PAGE_OBS_MARKER } from './compress.js';

export const SNAPSHOT_TOOL_NAME = 'page_snapshot';

const STALE_STUB_PREFIX = '[快照已过期：';

/**
 * 存根内容：N=该快照元素数（解析本模块自建的观测 JSON 得出，非启发式猜测）。
 * 定向快照观测首行是页标注（`[来自 …]`），存根保留该行——过期存根仍知来源页。
 * 已是存根的观测原样返回（幂等）：存根体非 JSON，重走解析会把元素计数冲成 0。
 */
function snapshotStub(content: string): string {
  let tag: string | null = null;
  let body = content;
  if (content.startsWith(PAGE_OBS_MARKER)) {
    const newlineIdx = content.indexOf('\n');
    tag = newlineIdx === -1 ? content : content.slice(0, newlineIdx);
    body = newlineIdx === -1 ? '' : content.slice(newlineIdx + 1);
  }
  if (body.startsWith(STALE_STUB_PREFIX)) return content;
  let count = 0;
  try {
    const parsed = JSON.parse(body) as { elements?: unknown };
    if (Array.isArray(parsed.elements)) count = parsed.elements.length;
  } catch {
    count = 0;
  }
  const stub = `[快照已过期：${count} 元素，refs 失效]`;
  return tag === null ? stub : `${tag}\n${stub}`;
}

/**
 * 快照观测的观察目标：定向观测首行是页标注（`[来自 …]`），该行即其目标标识；
 * 无标注＝缺省观察链（活跃页）。存根同样保留标注行，故对已瘦身观测仍给出同一目标。
 */
export function snapshotPageKey(content: string): string {
  if (!content.startsWith(PAGE_OBS_MARKER)) return '';
  const newlineIdx = content.indexOf('\n');
  return newlineIdx === -1 ? content : content.slice(0, newlineIdx);
}

/**
 * 返回瘦身后的新历史（不改动入参对象——回合内 messages 只追加不回改的护栏在调用侧，
 * 本函数只在回合落盘边界产出替换后的新数组）。无快照观测时原样返回入参引用。
 * keyOf 把快照观测分组，每组各留最近一份全文；缺省全部同组＝全历史只留最近一份。
 */
export function pruneStaleSnapshots(
  history: LlmMessage[],
  keyOf: (content: string) => string = () => '',
): LlmMessage[] {
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

  const lastIndexByKey = new Map<string, number>();
  history.forEach((message, index) => {
    if (isSnapshotObs(message)) lastIndexByKey.set(keyOf(message.content), index);
  });
  if (lastIndexByKey.size === 0) return history;
  const keep = new Set(lastIndexByKey.values());

  return history.map((message, index) =>
    !keep.has(index) && isSnapshotObs(message)
      ? { ...message, content: snapshotStub(message.content) }
      : message,
  );
}
