import { describe, expect, it, vi } from 'vitest';
import type {
  ExecInstructionFrame,
  ExecResultFrame,
  GuideActionFrame,
  HitlRequestFrame,
  TextDeltaFrame,
  ToolCardFrame,
} from '../src/frames.js';
import type { ContentToBackgroundMessage } from '../src/messaging.js';
import { routeDownstreamFrame, type DownstreamRouterDeps } from '../src/content-router.js';

function makeDeps(overrides: Partial<DownstreamRouterDeps> = {}): {
  deps: DownstreamRouterDeps;
  sent: ContentToBackgroundMessage[];
} {
  const sent: ContentToBackgroundMessage[] = [];
  const deps: DownstreamRouterDeps = {
    ui: {
      appendTextDelta: vi.fn(),
      showStatus: vi.fn(),
      renderToolCard: vi.fn(),
      promptHitl: vi.fn().mockResolvedValue('approve'),
    },
    pageAction: { run: vi.fn().mockReturnValue({ hit: true, status: '已定位' }) },
    snapshot: {
      collect: vi
        .fn()
        .mockReturnValue({ url: 'http://host/console', title: '控制台', elements: [], notices: [] }),
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
    ...overrides,
  };
  return { deps, sent };
}

const textDelta: TextDeltaFrame = { type: 'text-delta', sessionId: 's1', delta: 'hi' };
const guideAction: GuideActionFrame = { type: 'guide-action', sessionId: 's1', action: 'highlight', selector: '#x' };
const toolCard: ToolCardFrame = { type: 'tool-card', sessionId: 's1', toolCallId: 'tc1', toolId: 't', status: 'running' };
const hitlRequest: HitlRequestFrame = {
  type: 'hitl-request',
  sessionId: 's1',
  hitlId: 'h1',
  toolCallId: 'tc1',
  toolId: 'order-list.cancel-order',
  params: { orderId: 'ORD-1001' },
};
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
  it('text-delta → appendTextDelta', () => {
    const { deps } = makeDeps();
    routeDownstreamFrame(textDelta, deps);
    expect(deps.ui.appendTextDelta).toHaveBeenCalledWith(textDelta);
  });

  it('guide-action → pageAction.run 并 showStatus 其结果', () => {
    const { deps } = makeDeps();
    routeDownstreamFrame(guideAction, deps);
    expect(deps.pageAction.run).toHaveBeenCalledWith(guideAction);
    expect(deps.ui.showStatus).toHaveBeenCalledWith('已定位');
  });

  it('tool-card → renderToolCard', () => {
    const { deps } = makeDeps();
    routeDownstreamFrame(toolCard, deps);
    expect(deps.ui.renderToolCard).toHaveBeenCalledWith(toolCard);
  });

  it('hitl-request → promptHitl，裁决结果经 send 回传 hitl-decision', async () => {
    const { deps, sent } = makeDeps();
    routeDownstreamFrame(hitlRequest, deps);
    expect(deps.ui.promptHitl).toHaveBeenCalledWith(hitlRequest);
    await vi.waitFor(() => {
      expect(sent).toContainEqual({ kind: 'hitl-decision', hitlId: 'h1', decision: 'approve' });
    });
  });

  it('hitl-request reject：回传 reject 决定', async () => {
    const { deps, sent } = makeDeps({
      ui: {
        appendTextDelta: vi.fn(),
        showStatus: vi.fn(),
        renderToolCard: vi.fn(),
        promptHitl: vi.fn().mockResolvedValue('reject'),
      },
    });
    routeDownstreamFrame(hitlRequest, deps);
    await vi.waitFor(() => {
      expect(sent).toContainEqual({ kind: 'hitl-decision', hitlId: 'h1', decision: 'reject' });
    });
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
    expect(deps.snapshot.collect).toHaveBeenCalled();
    expect(sent).toContainEqual({
      kind: 'snapshot-report',
      report: {
        type: 'snapshot-report',
        sessionId: 's1',
        requestId: 'r1',
        url: 'http://host/console',
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
        title: '控制台',
        elements: [],
        notices: ['请选择分组'],
      },
    });
  });
});
