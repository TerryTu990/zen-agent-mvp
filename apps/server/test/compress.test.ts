import { describe, expect, it } from 'vitest';
import type { LlmMessage, LlmPort, LlmStreamEvent } from '@zen-agent/contracts';
import {
  BOUNDARY_MARKER,
  SUMMARY_MARKER,
  compressHistory,
  estimateHistoryTokens,
  shouldCompress,
} from '../src/compress.js';

/** 产出固定摘要文本的替身；error=true 时以 done error 收尾（驱动 fail-open 路径）。 */
function fakeLlm(reply: string, opts: { error?: boolean } = {}): LlmPort {
  return {
    cancel() {},
    async *chat(): AsyncGenerator<LlmStreamEvent> {
      if (opts.error === true) {
        yield { kind: 'done', stopReason: 'error', error: 'boom' };
        return;
      }
      yield { kind: 'text-delta', delta: reply };
      yield { kind: 'done', stopReason: 'end' };
    },
  };
}

/** N 个用户回合，每回合 user + assistant 一对；内容带序号便于断言原文保留。 */
function turns(count: number): LlmMessage[] {
  const out: LlmMessage[] = [];
  for (let i = 1; i <= count; i += 1) {
    out.push({ role: 'user', content: `问题${i}` });
    out.push({ role: 'assistant', content: `回答${i}` });
  }
  return out;
}

describe('estimateHistoryTokens（触发估算）', () => {
  it('usage 实数优先：取 input+output 之和，忽略字符数', () => {
    const history: LlmMessage[] = [{ role: 'user', content: 'x'.repeat(300) }];
    expect(
      estimateHistoryTokens({ history, usage: { inputTokens: 1000, outputTokens: 234 } }),
    ).toBe(1234);
  });

  it('usage 缺省：按 ≈chars/3 字符近似', () => {
    const history: LlmMessage[] = [{ role: 'user', content: 'x'.repeat(300) }];
    expect(estimateHistoryTokens({ history })).toBe(100);
  });

  it('字符近似计入工具调用回声（name + 序列化实参）', () => {
    const history: LlmMessage[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'ab', params: { k: 'v' } }] },
    ];
    // '' + 'ab'(2) + '{"k":"v"}'(9) = 11 → ceil(11/3) = 4
    expect(estimateHistoryTokens({ history })).toBe(4);
  });
});

describe('shouldCompress（阈值判定）', () => {
  it('估算达 窗口×阈值 触发', () => {
    expect(shouldCompress(120_000, 200_000, 0.6)).toBe(true);
    expect(shouldCompress(120_001, 200_000, 0.6)).toBe(true);
  });
  it('未达阈值不触发', () => {
    expect(shouldCompress(119_999, 200_000, 0.6)).toBe(false);
  });
});

describe('compressHistory（回合边界压缩）', () => {
  it('阈值触发后：较早回合压为一条摘要，最近 K 轮原文保留', async () => {
    const history = turns(6);
    const result = await compressHistory(history, { llm: fakeLlm('这是摘要'), keepRounds: 2 });
    // 头部一条摘要消息
    expect(result[0]!.role).toBe('user');
    expect(result[0]!.content.startsWith(SUMMARY_MARKER)).toBe(true);
    expect(result[0]!.content).toContain('这是摘要');
    // 最近 2 轮（问题5/6 及其回答）原文保留在尾部
    expect(result.slice(1)).toEqual([
      { role: 'user', content: '问题5' },
      { role: 'assistant', content: '回答5' },
      { role: 'user', content: '问题6' },
      { role: 'assistant', content: '回答6' },
    ]);
    // 更早回合原文不再出现
    expect(result.some((m) => m.content === '问题1')).toBe(false);
  });

  it('回合数不足 K：原样返回（不压缩、不调用 LLM）', async () => {
    const history = turns(3);
    let called = false;
    const spy: LlmPort = {
      cancel() {},
      async *chat(): AsyncGenerator<LlmStreamEvent> {
        called = true;
        yield { kind: 'done', stopReason: 'end' };
      },
    };
    const result = await compressHistory(history, { llm: spy, keepRounds: 4 });
    expect(result).toBe(history);
    expect(called).toBe(false);
  });

  it('摘要调用透传所属回合 requestId，供停止接口取消', async () => {
    let observedRequestId: string | undefined;
    const spy: LlmPort = {
      cancel() {},
      async *chat(request): AsyncGenerator<LlmStreamEvent> {
        observedRequestId = request.requestId;
        yield { kind: 'text-delta', delta: '摘要' };
        yield { kind: 'done', stopReason: 'end' };
      },
    };

    await compressHistory(turns(6), { llm: spy, keepRounds: 2, requestId: 'session:message' });

    expect(observedRequestId).toBe('session:message');
  });

  it('任务级授权计划（dom task/summary）整句保留进摘要', async () => {
    const task = '给订单 ORD-1 添加备注并保存';
    const summary = '在页面上填写备注并点击保存';
    const history: LlmMessage[] = [
      ...turns(1),
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'order-list.page-operate', params: { task, summary } }],
      },
      { role: 'tool', toolCallId: 'c1', content: '{"ok":true}' },
      ...turns(4),
    ];
    const result = await compressHistory(history, { llm: fakeLlm('摘要正文'), keepRounds: 2 });
    const summaryMsg = result[0]!.content;
    expect(summaryMsg).toContain(task);
    expect(summaryMsg).toContain(summary);
  });

  it('站点边界标记整句保留进摘要', async () => {
    const marker = `${BOUNDARY_MARKER}以下对话发生在 https://mail.126.com`;
    const history: LlmMessage[] = [
      ...turns(1),
      { role: 'user', content: marker },
      ...turns(4),
    ];
    const result = await compressHistory(history, { llm: fakeLlm('摘要正文'), keepRounds: 2 });
    expect(result[0]!.content).toContain(marker);
    // 边界标记不算用户回合：最近 2 轮仍是 turns 的后两轮
    expect(result.some((m) => m.content === '问题1')).toBe(false);
  });

  it('摘要生成失败：fail-open，历史原样返回（同引用）', async () => {
    const history = turns(6);
    const result = await compressHistory(history, {
      llm: fakeLlm('', { error: true }),
      keepRounds: 2,
    });
    expect(result).toBe(history);
  });

  it('既有摘要落待压缩头部：随新摘要折叠、不当作用户回合', async () => {
    const history: LlmMessage[] = [
      { role: 'user', content: `${SUMMARY_MARKER}\n旧摘要` },
      ...turns(6),
    ];
    const result = await compressHistory(history, { llm: fakeLlm('新摘要'), keepRounds: 2 });
    // 仍只有一条摘要在头部，最近 2 轮原文保留
    expect(result[0]!.content.startsWith(SUMMARY_MARKER)).toBe(true);
    expect(result[0]!.content).toContain('新摘要');
    expect(result.filter((m) => m.content.startsWith(SUMMARY_MARKER))).toHaveLength(1);
    expect(result.slice(1)).toEqual([
      { role: 'user', content: '问题5' },
      { role: 'assistant', content: '回答5' },
      { role: 'user', content: '问题6' },
      { role: 'assistant', content: '回答6' },
    ]);
  });
});
