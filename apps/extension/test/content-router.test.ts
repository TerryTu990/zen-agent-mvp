import { describe, expect, it, vi } from 'vitest';
import type { ExecInstructionFrame, ExecResultFrame, GuideActionFrame } from '../src/frames.js';
import type { ContentToBackgroundMessage } from '../src/messaging.js';
import {
  isPageDownstreamFrame,
  routeDownstreamFrame,
  type DownstreamRouterDeps,
} from '../src/content-router.js';

function makeDeps(overrides: Partial<DownstreamRouterDeps> = {}): {
  deps: DownstreamRouterDeps;
  sent: ContentToBackgroundMessage[];
} {
  const sent: ContentToBackgroundMessage[] = [];
  const deps: DownstreamRouterDeps = {
    pageAction: { run: vi.fn().mockReturnValue({ hit: true, status: '已定位' }) },
    snapshot: {
      collect: vi
        .fn()
        .mockReturnValue({ url: 'http://host/console', title: '控制台', elements: [], notices: [], evidence: {} }),
    },
    executor: {
      execute: vi.fn().mockResolvedValue({
        type: 'exec-result',
        sessionId: 's1',
        nonce: 'n1',
        ok: true,
        status: 200,
        body: { ok: true },
      } satisfies ExecResultFrame),
    },
    send: (message) => sent.push(message),
    pageInstanceId: 'page-instance-1',
    ...overrides,
  };
  return { deps, sent };
}

const guideAction: GuideActionFrame = { type: 'guide-action', sessionId: 's1', action: 'highlight', selector: '#x' };
const execInstruction: ExecInstructionFrame = {
  type: 'exec-instruction',
  sessionId: 's1',
  nonce: 'n1',
  ttl: 60000,
  signature: 'sig',
  toolCallId: 'tc1',
  request: { method: 'POST', url: 'http://host/api/orders/ORD-1001/cancel', body: {} },
};

describe('routeDownstreamFrame 下行帧分发', () => {
  it('guide-action → pageAction.run，结果状态回传 Side Panel', () => {
    const { deps, sent } = makeDeps();
    routeDownstreamFrame(guideAction, deps);
    expect(deps.pageAction.run).toHaveBeenCalledWith(guideAction);
    expect(sent).toContainEqual({ kind: 'page-status', message: '已定位' });
  });

  it('仅页面动作帧能进入 content 执行器', () => {
    expect(isPageDownstreamFrame(guideAction)).toBe(true);
    expect(isPageDownstreamFrame(execInstruction)).toBe(true);
    expect(isPageDownstreamFrame({ type: 'snapshot-request', sessionId: 's1', requestId: 'r1' })).toBe(true);
    expect(isPageDownstreamFrame({ type: 'text-delta', sessionId: 's1', delta: 'hi' })).toBe(false);
    expect(
      isPageDownstreamFrame({
        type: 'hitl-request',
        sessionId: 's1',
        hitlId: 'h1',
        toolId: 't',
        params: {},
      }),
    ).toBe(false);
  });

  it('exec-instruction → executor.execute，结果经 send 回传 exec-result', async () => {
    const { deps, sent } = makeDeps();
    routeDownstreamFrame(execInstruction, deps);
    expect(deps.executor.execute).toHaveBeenCalledWith(execInstruction);
    await vi.waitFor(() => {
      expect(sent).toContainEqual({
        kind: 'exec-result',
        result: { type: 'exec-result', sessionId: 's1', nonce: 'n1', ok: true, status: 200, body: { ok: true } },
      });
    });
  });

  it('snapshot-request → snapshot.collect，快照经 send 回传 snapshot-report（requestId 关联）', () => {
    const { deps, sent } = makeDeps();
    routeDownstreamFrame({ type: 'snapshot-request', sessionId: 's1', requestId: 'r1' }, deps);
    expect(deps.snapshot.collect).toHaveBeenCalledWith(undefined);
    expect(sent).toContainEqual({
      kind: 'snapshot-report',
      report: {
        type: 'snapshot-report',
        sessionId: 's1',
        requestId: 'r1',
        url: 'http://host/console',
        pageInstanceId: 'page-instance-1',
        title: '控制台',
        elements: [],
      },
    });
  });

  it('snapshot-request：快照带页面提示时 report 含 notices，空提示则省略该字段', () => {
    const { deps, sent } = makeDeps({
      snapshot: {
        collect: vi.fn().mockReturnValue({
          url: 'http://host/console',
          title: '控制台',
          elements: [],
          notices: ['请选择分组'],
          evidence: {},
        }),
      },
    });
    routeDownstreamFrame({ type: 'snapshot-request', sessionId: 's1', requestId: 'r2' }, deps);
    expect(sent).toContainEqual({
      kind: 'snapshot-report',
      report: {
        type: 'snapshot-report',
        sessionId: 's1',
        requestId: 'r2',
        url: 'http://host/console',
        pageInstanceId: 'page-instance-1',
        title: '控制台',
        elements: [],
        notices: ['请选择分组'],
      },
    });
  });

  it('snapshot-request：把 pack 证据配方交给采集器并回传结构化证据', () => {
    const rule = {
      id: 'message-receipts',
      itemSelector: '[class*="message-content"]',
      statusSelector: '[class*="read-status-text"]',
      statuses: ['未读', '已读'],
    };
    const { deps, sent } = makeDeps({
      snapshot: {
        collect: vi.fn().mockReturnValue({
          url: 'https://seller.goofish.com/',
          title: '聊天',
          elements: [],
          notices: [],
          evidence: { 'message-receipts': { count: 3, latest: '未读' } },
        }),
      },
    });
    routeDownstreamFrame(
      { type: 'snapshot-request', sessionId: 's1', requestId: 'r3', evidenceRules: [rule] },
      deps,
    );
    expect(deps.snapshot.collect).toHaveBeenCalledWith([rule]);
    expect(sent).toContainEqual({
      kind: 'snapshot-report',
      report: {
        type: 'snapshot-report',
        sessionId: 's1',
        requestId: 'r3',
        url: 'https://seller.goofish.com/',
        pageInstanceId: 'page-instance-1',
        title: '聊天',
        elements: [],
        evidence: { 'message-receipts': { count: 3, latest: '未读' } },
      },
    });
  });
});
