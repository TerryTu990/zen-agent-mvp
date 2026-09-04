// @vitest-environment jsdom
/**
 * content 侧停止闩：停止是**回合级**事实，不是单条批次的事实。
 * 每次 run 开头无条件复位时，停止之后 background 放行的第一条 exec-instruction
 * 会把已置位的停止状态抹掉并照常执行——用户按下停止后页面上仍会发生动作。
 * 复位只由显式的新回合信号驱动，故本组同时钉住「停止后不执行」与「新回合恢复执行」。
 *
 * 观察点取 navigate 步：它是唯一无需先采快照即可执行的闭集动作，
 * 一旦执行必向 background 发出 navigate-request——「一步都没跑」因此可被直接观察，
 * 不必靠错误串反推。半程中止那一例另需一个先于 navigate 的步骤停在高亮停顿里，
 * 故先采一轮快照换取可解引用的 ref。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecInstructionFrame } from '../src/frames.js';
import type { BackgroundToContentMessage, ContentToBackgroundMessage } from '../src/messaging.js';

const SESSION_ID = 'sess-1';

interface ContentHarness {
  /** background → content（会话端口）。 */
  deliver(message: BackgroundToContentMessage): void;
  /** content → background 的全部端口消息，按发生序。 */
  sent: ContentToBackgroundMessage[];
}

function domBatch(nonce: string): ExecInstructionFrame {
  const issuedAt = Date.now();
  return {
    type: 'exec-instruction',
    sessionId: SESSION_ID,
    nonce,
    issuedAt,
    expiresAt: issuedAt + 60_000,
    ttl: 60_000,
    toolCallId: 'call-1',
    signature: 'sig-not-verified-in-content',
    request: { kind: 'dom', steps: [{ action: 'navigate', url: 'https://shop.example/checkout' }] },
  } as ExecInstructionFrame;
}

/** 装载真实 content 脚本并完成激活握手；返回其会话端口的驱动面。 */
async function loadContent(): Promise<ContentHarness> {
  const runtimeListeners: Array<(raw: unknown) => void> = [];
  const portListeners: Array<(raw: unknown) => void> = [];
  const sent: ContentToBackgroundMessage[] = [];
  const chromeStub = {
    runtime: {
      onMessage: { addListener: (cb: (raw: unknown) => void): void => void runtimeListeners.push(cb) },
      sendMessage: async (): Promise<void> => undefined,
      connect: () => ({
        onMessage: { addListener: (cb: (raw: unknown) => void): void => void portListeners.push(cb) },
        onDisconnect: { addListener: (): void => undefined },
        postMessage: (message: ContentToBackgroundMessage): void => void sent.push(message),
        disconnect: (): void => undefined,
      }),
    },
    storage: { local: { get: async (): Promise<Record<string, unknown>> => ({}) } },
  };
  vi.stubGlobal('chrome', chromeStub);
  // 20s 保活心跳不参与本组断言，排期它只会在环境拆除后空转。
  vi.stubGlobal('setInterval', () => 0);

  vi.resetModules();
  await import('../src/content.js');
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
  for (const listener of runtimeListeners) listener({ kind: 'activate' });

  return {
    deliver: (message) => {
      for (const listener of portListeners) listener(message);
    },
    sent,
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
};

function navigateRequests(harness: ContentHarness): ContentToBackgroundMessage[] {
  return harness.sent.filter((message) => message.kind === 'navigate-request');
}

function execResults(harness: ContentHarness): Array<{ ok: boolean; error?: string }> {
  return harness.sent
    .filter((message): message is Extract<ContentToBackgroundMessage, { kind: 'exec-result' }> =>
      message.kind === 'exec-result')
    .map((message) => ({ ok: message.result.ok, ...(message.result.error !== undefined ? { error: message.result.error } : {}) }));
}

beforeEach(() => {
  document.body.innerHTML = '';
  // jsdom 无布局引擎、不实现 scrollIntoView；真浏览器原生支持，仅测试打桩。
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('content 侧停止闩', () => {
  it('停止之后到达的第一条 dom 批次：一步都不执行，如实回 user-stopped', async () => {
    const harness = await loadContent();
    harness.deliver({ kind: 'stop-operation' });
    harness.deliver({ kind: 'frame', frame: domBatch('n-after-stop') });
    await flush();

    expect(navigateRequests(harness)).toEqual([]);
    expect(execResults(harness)).toEqual([{ ok: false, error: 'user-stopped' }]);
  });

  it('未按停止的同一批次照常执行（对照：闩只由停止驱动）', async () => {
    const harness = await loadContent();
    harness.deliver({ kind: 'frame', frame: domBatch('n-plain') });
    await flush();

    expect(navigateRequests(harness)).toHaveLength(1);
  });

  it('停止之后立刻开新回合：上一批次不因复位而续跑余下步骤', async () => {
    document.body.innerHTML = '<button id="pay">付款</button>';
    const harness = await loadContent();
    // 快照采集一轮，让批次里的 ref 可解引用（dom 步只认快照发过的 ref）。
    harness.deliver({
      kind: 'frame',
      frame: { type: 'snapshot-request', sessionId: SESSION_ID, requestId: 'req-1' },
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const report = harness.sent.find(
      (message): message is Extract<ContentToBackgroundMessage, { kind: 'snapshot-report' }> =>
        message.kind === 'snapshot-report',
    );
    const ref = report?.report.elements[0]?.ref;
    expect(ref).toBeDefined();

    harness.deliver({
      kind: 'frame',
      frame: {
        ...domBatch('n-running'),
        request: { kind: 'dom', steps: [{ action: 'click', ref: ref! }, { action: 'navigate', url: 'https://shop.example/checkout' }] },
      } as ExecInstructionFrame,
    });
    // 首步的高亮停顿（350ms）里按下停止，随即开新回合：复位只该放行新批次，不该放行这一批。
    await new Promise((resolve) => setTimeout(resolve, 50));
    harness.deliver({ kind: 'stop-operation' });
    harness.deliver({ kind: 'resume-operation' });
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(navigateRequests(harness)).toEqual([]);
    expect(execResults(harness)).toEqual([{ ok: false, error: 'user-stopped' }]);
  });

  it('新回合开始即复位：停止不把本页永久停摆', async () => {
    const harness = await loadContent();
    harness.deliver({ kind: 'stop-operation' });
    harness.deliver({ kind: 'frame', frame: domBatch('n-after-stop') });
    await flush();
    harness.deliver({ kind: 'resume-operation' });
    harness.deliver({ kind: 'frame', frame: domBatch('n-next-turn') });
    await flush();

    expect(navigateRequests(harness)).toHaveLength(1);
  });
});
