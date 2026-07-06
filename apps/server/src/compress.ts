/**
 * 会话历史压缩（ADR-013 P1）：回合落盘边界执行——较早回合压为一条滚动摘要消息，
 * 最近 K 个用户回合保留原文。治理注入（system 每轮整段重建）结构上不进历史、不经本模块；
 * 压缩器只接 history。触发靠估算（usage 实数优先、缺省字符近似），达阈值才调用。
 */
import type { LlmMessage, LlmPort } from '@zen-agent/contracts';

/** 滚动摘要消息前缀：既作注入给模型的可读标识，也是再压缩时识别既有摘要（折叠而非当回合）的判据。 */
export const SUMMARY_MARKER = '【对话摘要】';
/** 站点边界标记前缀（批次④注入 role:user/system 侧）：入摘要须整句保留，本模块预留识别。 */
export const BOUNDARY_MARKER = '【站点边界】';

const DEFAULT_KEEP_ROUNDS = 4;

const SUMMARY_SYSTEM_PROMPT =
  '你是对话历史压缩器。把给定的较早对话回合压缩为一段滚动摘要，' +
  '必须涵盖：用户的业务目标、已完成的关键步骤、关键结论与当前进展。' +
  '只输出摘要正文，不要额外解释或前后缀。';

const SUMMARY_USER_PREFIX = '以下是需要压缩的较早对话回合：\n\n';

export interface UsageTokens {
  inputTokens: number;
  outputTokens: number;
}

export interface EstimateInput {
  history: LlmMessage[];
  /** 上一/本轮 usage 实数；提供即优先，缺省回退字符近似。 */
  usage?: UsageTokens;
}

/** 单条消息的字符量（含工具调用回声的 name + 序列化实参），字符近似估算的输入。 */
function charsOf(message: LlmMessage): number {
  let chars = message.content.length;
  if (message.toolCalls !== undefined) {
    for (const call of message.toolCalls) {
      chars += call.name.length + JSON.stringify(call.params).length;
    }
  }
  return chars;
}

/**
 * 估算历史 token 数：有 usage 实数即取 input+output 之和；否则按 ≈chars/3 近似
 * （中英混排的粗略下界，只用于跨阈值触发判定，不追求精确）。
 */
export function estimateHistoryTokens(input: EstimateInput): number {
  if (input.usage !== undefined) {
    return input.usage.inputTokens + input.usage.outputTokens;
  }
  const chars = input.history.reduce((sum, message) => sum + charsOf(message), 0);
  return Math.ceil(chars / 3);
}

/** 估算值达 上下文窗口 × 阈值 即触发压缩。 */
export function shouldCompress(estimate: number, contextWindow: number, threshold: number): boolean {
  return estimate >= contextWindow * threshold;
}

function isSummaryMessage(message: LlmMessage): boolean {
  return message.role === 'user' && message.content.startsWith(SUMMARY_MARKER);
}

function isBoundaryMarker(message: LlmMessage): boolean {
  return (
    (message.role === 'user' || message.role === 'system') &&
    message.content.startsWith(BOUNDARY_MARKER)
  );
}

/** 用户回合起点：真实用户消息，排除既有摘要与站点边界标记（二者是注入的结构消息，不计回合）。 */
function isTurnStart(message: LlmMessage): boolean {
  return message.role === 'user' && !isSummaryMessage(message) && !isBoundaryMarker(message);
}

/**
 * 任务级授权计划文本（dom 工具 hitl 授权的 task/summary）：入摘要须整句保留，
 * 授权语义不得被 LLM 摘要糊掉。按出现顺序去重。
 */
function extractTaskPlans(messages: LlmMessage[]): string[] {
  const plans: string[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'assistant' || message.toolCalls === undefined) continue;
    for (const call of message.toolCalls) {
      for (const key of ['task', 'summary'] as const) {
        const value = call.params[key];
        if (typeof value === 'string' && value !== '' && !seen.has(value)) {
          seen.add(value);
          plans.push(value);
        }
      }
    }
  }
  return plans;
}

function serializeHead(messages: LlmMessage[]): string {
  return messages
    .map((message) => {
      const calls =
        message.toolCalls !== undefined
          ? ` [调用:${message.toolCalls.map((call) => call.name).join(',')}]`
          : '';
      return `${message.role}${calls}: ${message.content}`;
    })
    .join('\n');
}

/** 单次 LLM 调用生成摘要正文；错误/异常/空文本 → null（由调用方 fail-open 放弃本回合压缩）。 */
async function summarize(llm: LlmPort, head: LlmMessage[]): Promise<string | null> {
  let text = '';
  let errored = false;
  try {
    for await (const event of llm.chat({
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
        { role: 'user', content: SUMMARY_USER_PREFIX + serializeHead(head) },
      ],
    })) {
      if (event.kind === 'text-delta') text += event.delta;
      else if (event.kind === 'done' && event.stopReason === 'error') errored = true;
    }
  } catch {
    return null;
  }
  if (errored) return null;
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
}

export interface CompressOptions {
  llm: LlmPort;
  /** 保留原文的最近用户回合数，默认 4。 */
  keepRounds?: number;
}

/**
 * 压缩历史：把最近 K 个用户回合之前的较早回合压为一条滚动摘要消息（头部），最近 K 回合原文保留。
 * 既有摘要（前缀识别）落在待压缩头部、随新摘要一并折叠；站点边界标记与任务授权计划整句保留进摘要。
 * 回合数不足 K、无可压缩头部、或摘要生成失败 → 原样返回入参引用（fail-open，下回合再试）。
 */
export async function compressHistory(
  history: LlmMessage[],
  options: CompressOptions,
): Promise<LlmMessage[]> {
  const keepRounds = options.keepRounds ?? DEFAULT_KEEP_ROUNDS;
  const turnStarts: number[] = [];
  history.forEach((message, index) => {
    if (isTurnStart(message)) turnStarts.push(index);
  });
  if (turnStarts.length <= keepRounds) return history;

  const splitIdx = turnStarts[turnStarts.length - keepRounds]!;
  const head = history.slice(0, splitIdx);
  const tail = history.slice(splitIdx);
  if (head.length === 0) return history;

  const preservedBoundaries = head.filter(isBoundaryMarker).map((message) => message.content);
  const preservedTasks = extractTaskPlans(head);

  const summaryText = await summarize(options.llm, head);
  if (summaryText === null) return history;

  const parts = [SUMMARY_MARKER, summaryText];
  if (preservedBoundaries.length > 0) parts.push('保留的站点边界标记：', ...preservedBoundaries);
  if (preservedTasks.length > 0) parts.push('保留的任务授权计划：', ...preservedTasks);
  const summaryMessage: LlmMessage = { role: 'user', content: parts.join('\n') };
  return [summaryMessage, ...tail];
}
