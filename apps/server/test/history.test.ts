import { describe, expect, it } from 'vitest';
import type { LlmMessage } from '@zen-agent/contracts';
import { pruneStaleSnapshots, SNAPSHOT_TOOL_NAME } from '../src/history.js';

/** 构造一对快照轮（assistant 回声 + role:tool 观测），elements 长度即存根 N。 */
function snapshotTurn(id: string, elementCount: number): LlmMessage[] {
  const elements = Array.from({ length: elementCount }, (_, i) => ({
    ref: `za-${i}`,
    role: 'button',
    label: `el-${i}`,
  }));
  return [
    { role: 'assistant', content: '', toolCalls: [{ id, name: SNAPSHOT_TOOL_NAME, params: {} }] },
    { role: 'tool', toolCallId: id, content: JSON.stringify({ url: 'u', title: 't', elements }) },
  ];
}

/** 非快照工具轮（如 page-operate）：不得被瘦身触碰。 */
function operateTurn(id: string): LlmMessage[] {
  return [
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id, name: 'order-list.page-operate', params: {} }],
    },
    { role: 'tool', toolCallId: id, content: JSON.stringify({ ok: true, reads: { x: '1' } }) },
  ];
}

describe('pruneStaleSnapshots（P0 旧观测瘦身）', () => {
  it('多快照：仅最近一次留全文，更早的替换为带元素数的存根', () => {
    const history: LlmMessage[] = [
      { role: 'user', content: '开始' },
      ...snapshotTurn('call_snap_1', 3),
      { role: 'user', content: '继续' },
      ...snapshotTurn('call_snap_2', 5),
      { role: 'assistant', content: '完成' },
    ];
    const pruned = pruneStaleSnapshots(history);
    const firstObs = pruned.find((m) => m.role === 'tool' && m.toolCallId === 'call_snap_1')!;
    const lastObs = pruned.find((m) => m.role === 'tool' && m.toolCallId === 'call_snap_2')!;
    expect(firstObs.content).toBe('[快照已过期：3 元素，refs 失效]');
    expect(JSON.parse(lastObs.content)).toMatchObject({ elements: expect.any(Array) });
    expect((JSON.parse(lastObs.content) as { elements: unknown[] }).elements).toHaveLength(5);
  });

  it('单快照：原样保留全文，不产存根', () => {
    const history: LlmMessage[] = [{ role: 'user', content: 'x' }, ...snapshotTurn('only', 4)];
    const pruned = pruneStaleSnapshots(history);
    const obs = pruned.find((m) => m.role === 'tool')!;
    expect((JSON.parse(obs.content) as { elements: unknown[] }).elements).toHaveLength(4);
  });

  it('非快照工具观测（page-operate）不被瘦身，即使在更早的快照之后', () => {
    const history: LlmMessage[] = [
      ...snapshotTurn('call_snap_1', 2),
      ...operateTurn('call_op_1'),
      ...snapshotTurn('call_snap_2', 6),
    ];
    const pruned = pruneStaleSnapshots(history);
    const opObs = pruned.find((m) => m.role === 'tool' && m.toolCallId === 'call_op_1')!;
    const snap1 = pruned.find((m) => m.role === 'tool' && m.toolCallId === 'call_snap_1')!;
    expect(JSON.parse(opObs.content)).toMatchObject({ ok: true });
    expect(snap1.content).toBe('[快照已过期：2 元素，refs 失效]');
  });

  it('定向快照观测（首行页标注）：存根保留标注行且元素计数正确', () => {
    const tag = '[来自 workspace-view-00c3 · https://mail.126.com]';
    const elements = Array.from({ length: 3 }, (_, i) => ({ ref: `za-${i}`, role: 'button', label: `el-${i}` }));
    const history: LlmMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_directed', name: SNAPSHOT_TOOL_NAME, params: { targetPage: 'workspace-view-00c3' } }],
      },
      {
        role: 'tool',
        toolCallId: 'call_directed',
        content: `${tag}\n${JSON.stringify({ url: 'u', title: 't', elements })}`,
      },
      ...snapshotTurn('call_snap_latest', 1),
    ];
    const pruned = pruneStaleSnapshots(history);
    const stale = pruned.find((m) => m.role === 'tool' && m.toolCallId === 'call_directed')!;
    expect(stale.content).toBe(`${tag}\n[快照已过期：3 元素，refs 失效]`);
  });

  it('逐回合重复瘦身幂等：已存根观测原样保留，元素计数不被冲成 0（含页标注存根）', () => {
    const tag = '[来自 workspace-view-00c3 · https://mail.126.com]';
    const directedElements = Array.from({ length: 4 }, (_, i) => ({
      ref: `za-${i}`,
      role: 'link',
      label: `el-${i}`,
    }));
    const directed: LlmMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'call_directed', name: SNAPSHOT_TOOL_NAME, params: { targetPage: 'workspace-view-00c3' } },
        ],
      },
      {
        role: 'tool',
        toolCallId: 'call_directed',
        content: `${tag}\n${JSON.stringify({ url: 'u', title: 't', elements: directedElements })}`,
      },
    ];
    const first = pruneStaleSnapshots([
      ...snapshotTurn('call_snap_1', 3),
      ...directed,
      ...snapshotTurn('call_snap_2', 5),
    ]);
    // 落盘边界每回合都执行：新回合追加快照后再瘦身，前轮存根须原样通过
    const second = pruneStaleSnapshots([...first, ...snapshotTurn('call_snap_3', 7)]);
    const contentOf = (id: string): string =>
      second.find((m) => m.role === 'tool' && m.toolCallId === id)!.content;
    expect(contentOf('call_snap_1')).toBe('[快照已过期：3 元素，refs 失效]');
    expect(contentOf('call_directed')).toBe(`${tag}\n[快照已过期：4 元素，refs 失效]`);
    expect(contentOf('call_snap_2')).toBe('[快照已过期：5 元素，refs 失效]');
    expect(
      (JSON.parse(contentOf('call_snap_3')) as { elements: unknown[] }).elements,
    ).toHaveLength(7);
  });

  it('回合内不回改：不 mutate 入参，只在返回的新数组里替换', () => {
    const turn1 = snapshotTurn('call_snap_1', 3);
    const history: LlmMessage[] = [...turn1, ...snapshotTurn('call_snap_2', 1)];
    const beforeContent = turn1[1]!.content;
    const pruned = pruneStaleSnapshots(history);
    // 入参对象未被改写（护 prompt 缓存前缀语义）
    expect(turn1[1]!.content).toBe(beforeContent);
    expect(pruned).not.toBe(history);
    // 返回数组里旧快照才被替换为存根
    const prunedFirst = pruned.find((m) => m.role === 'tool' && m.toolCallId === 'call_snap_1')!;
    expect(prunedFirst.content).toBe('[快照已过期：3 元素，refs 失效]');
    expect(prunedFirst).not.toBe(turn1[1]);
  });

  it('无快照观测：原样返回（同引用）', () => {
    const history: LlmMessage[] = [
      { role: 'user', content: 'x' },
      { role: 'assistant', content: 'y' },
      ...operateTurn('call_op_1'),
    ];
    expect(pruneStaleSnapshots(history)).toBe(history);
  });
});
