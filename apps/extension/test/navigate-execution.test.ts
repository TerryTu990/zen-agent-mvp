import { describe, expect, it } from 'vitest';
import type { ExecInstructionFrame, ExecResultFrame } from '../src/frames.js';
import {
  createNavigateExecutor,
  type NavigateExecutorDeps,
  type NavigateTabs,
} from '../src/navigate-execution.js';
import type { NavigateCandidateTab } from '../src/navigate-target.js';

interface Harness {
  executor: ReturnType<typeof createNavigateExecutor>;
  calls: Array<{ fn: string; args: unknown[] }>;
  forwarded: ExecResultFrame[];
}

function createHarness(options?: {
  groupTabs?: NavigateCandidateTab[];
  createdTabId?: number;
  createRejects?: boolean;
  updateRejects?: boolean;
  targetGroupId?: number;
  getRejects?: boolean;
  now?: number;
}): Harness {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const forwarded: ExecResultFrame[] = [];
  const tabs: NavigateTabs = {
    query: async (queryInfo) => {
      calls.push({ fn: 'tabs.query', args: [queryInfo] });
      return options?.groupTabs ?? [];
    },
    get: async (tabId) => {
      calls.push({ fn: 'tabs.get', args: [tabId] });
      if (options?.getRejects === true) throw new Error('no tab with id');
      return { groupId: options?.targetGroupId ?? 42 };
    },
    update: async (tabId, updateProperties) => {
      calls.push({ fn: 'tabs.update', args: [tabId, updateProperties] });
      if (options?.updateRejects === true) throw new Error('tab gone');
      return {};
    },
    create: async (createProperties) => {
      calls.push({ fn: 'tabs.create', args: [createProperties] });
      if (options?.createRejects === true) throw new Error('window gone');
      return { id: options?.createdTabId ?? 11 };
    },
    group: async (groupOptions) => {
      calls.push({ fn: 'tabs.group', args: [groupOptions] });
      return 42;
    },
  };
  const deps: NavigateExecutorDeps = {
    groupId: 42,
    tabs,
    markMemberActive: (tabId) => calls.push({ fn: 'markMemberActive', args: [tabId] }),
    noteExpectedActiveTab: (tabId) => calls.push({ fn: 'noteExpectedActiveTab', args: [tabId] }),
    sendActivate: async (tabId) => {
      calls.push({ fn: 'sendActivate', args: [tabId] });
    },
    forwardExecResult: (result) => {
      calls.push({ fn: 'forwardExecResult', args: [result] });
      forwarded.push(result);
    },
    now: () => options?.now ?? 1_000,
  };
  return { executor: createNavigateExecutor(deps), calls, forwarded };
}

function instruction(expiresAt: number): ExecInstructionFrame {
  return {
    type: 'exec-instruction',
    sessionId: 's1',
    nonce: 'n1',
    issuedAt: 0,
    expiresAt,
    ttl: 60_000,
    signature: 'sig-not-verified-client-side',
    toolCallId: 'tc1',
    request: { kind: 'dom', steps: [{ action: 'navigate', url: 'https://example.com/a' }] },
  };
}

describe('performNavigate：chrome 调用序列', () => {
  it('组内已有同 URL 页：仅激活并就地标活跃，不新开不换 URL', async () => {
    const { executor, calls } = createHarness({
      groupTabs: [
        { id: 1, url: 'https://other.example/' },
        { id: 2, url: 'https://example.com/a' },
      ],
    });
    const outcome = await executor.performNavigate('https://example.com/a');
    expect(outcome).toEqual({ ok: true, url: 'https://example.com/a' });
    expect(calls).toEqual([
      { fn: 'tabs.query', args: [{ groupId: 42 }] },
      { fn: 'tabs.update', args: [2, { active: true }] },
      { fn: 'markMemberActive', args: [2] },
      { fn: 'noteExpectedActiveTab', args: [2] },
      { fn: 'sendActivate', args: [2] },
    ]);
  });

  it('组内已有同源异 URL 页：原地换 URL，不标活跃（重连时接管）', async () => {
    const { executor, calls } = createHarness({
      groupTabs: [{ id: 3, url: 'https://example.com/list' }],
    });
    const outcome = await executor.performNavigate('https://example.com/detail/9');
    expect(outcome).toEqual({ ok: true, url: 'https://example.com/detail/9' });
    expect(calls).toEqual([
      { fn: 'tabs.query', args: [{ groupId: 42 }] },
      { fn: 'tabs.update', args: [3, { url: 'https://example.com/detail/9', active: true }] },
      { fn: 'noteExpectedActiveTab', args: [3] },
      { fn: 'sendActivate', args: [3] },
    ]);
  });

  it('发起页被排除出换 URL 候选：仅剩发起页同源时走新建', async () => {
    const { executor, calls } = createHarness({
      groupTabs: [{ id: 5, url: 'https://example.com/list' }],
      createdTabId: 11,
    });
    await executor.performNavigate('https://example.com/detail/9', undefined, 5);
    expect(calls.map((call) => call.fn)).toEqual([
      'tabs.query',
      'tabs.create',
      'tabs.group',
      'tabs.update',
      'noteExpectedActiveTab',
      'sendActivate',
    ]);
  });

  it('组内无同源页：create(inactive) → group → update(active)，激活晚于入组', async () => {
    const { executor, calls } = createHarness({ groupTabs: [], createdTabId: 11 });
    const outcome = await executor.performNavigate('https://example.com/a', 7);
    expect(outcome).toEqual({ ok: true, url: 'https://example.com/a' });
    expect(calls).toEqual([
      { fn: 'tabs.query', args: [{ groupId: 42 }] },
      { fn: 'tabs.create', args: [{ url: 'https://example.com/a', windowId: 7, active: false }] },
      { fn: 'tabs.group', args: [{ tabIds: 11, groupId: 42 }] },
      { fn: 'tabs.update', args: [11, { active: true }] },
      { fn: 'noteExpectedActiveTab', args: [11] },
      { fn: 'sendActivate', args: [11] },
    ]);
  });

  it('开页失败：回 navigate-open-failed，不入组不激活', async () => {
    const { executor, calls } = createHarness({ groupTabs: [], createRejects: true });
    const outcome = await executor.performNavigate('https://example.com/a');
    expect(outcome).toEqual({ ok: false, error: 'navigate-open-failed' });
    expect(calls.map((call) => call.fn)).toEqual(['tabs.query', 'tabs.create']);
  });
});

describe('executeNavigateWithoutPage：background 直执行的 exec-result 契约', () => {
  it('过期指令：回 instruction-expired，不触发任何开页调用', async () => {
    const { executor, calls, forwarded } = createHarness({ now: 2_000 });
    await executor.executeNavigateWithoutPage(instruction(1_999), 'https://example.com/a');
    expect(forwarded).toEqual([
      { type: 'exec-result', sessionId: 's1', nonce: 'n1', ok: false, error: 'instruction-expired' },
    ]);
    expect(calls.map((call) => call.fn)).toEqual(['forwardExecResult']);
  });

  it('开页失败：错误串带 step-1-navigate 前缀（与 dom-steps 口径一致）', async () => {
    const { executor, forwarded } = createHarness({ now: 1_000, createRejects: true });
    await executor.executeNavigateWithoutPage(instruction(60_000), 'https://example.com/a');
    expect(forwarded).toEqual([
      {
        type: 'exec-result',
        sessionId: 's1',
        nonce: 'n1',
        ok: false,
        error: 'step-1-navigate:navigate-open-failed',
      },
    ]);
  });

  it('成功：body 带 url，结果以完整 exec-result 形状进入上行管线', async () => {
    const { executor, calls, forwarded } = createHarness({ now: 1_000, createdTabId: 11 });
    await executor.executeNavigateWithoutPage(instruction(60_000), 'https://example.com/a');
    expect(forwarded).toEqual([
      {
        type: 'exec-result',
        sessionId: 's1',
        nonce: 'n1',
        ok: true,
        body: { url: 'https://example.com/a' },
      },
    ]);
    expect(calls.at(-1)).toEqual({ fn: 'forwardExecResult', args: [forwarded[0]] });
  });
});

describe('executeNavigateToTab：silent 页定向 navigate 的直执行（adr-023 D3）', () => {
  it('成功：目标仍在组内，只对句柄钉死的 tab 换 URL——不新建不激活不夺焦，禁改投', async () => {
    const { executor, calls, forwarded } = createHarness({ now: 1_000 });
    await executor.executeNavigateToTab(instruction(60_000), 'https://example.com/a', 102);
    expect(calls).toEqual([
      { fn: 'tabs.get', args: [102] },
      { fn: 'tabs.update', args: [102, { url: 'https://example.com/a' }] },
      { fn: 'forwardExecResult', args: [forwarded[0]] },
    ]);
    expect(forwarded).toEqual([
      {
        type: 'exec-result',
        sessionId: 's1',
        nonce: 'n1',
        ok: true,
        body: { url: 'https://example.com/a' },
      },
    ]);
  });

  it('过期指令：回 instruction-expired，不触发 tabs 调用', async () => {
    const { executor, calls, forwarded } = createHarness({ now: 2_000 });
    await executor.executeNavigateToTab(instruction(1_999), 'https://example.com/a', 102);
    expect(forwarded).toEqual([
      { type: 'exec-result', sessionId: 's1', nonce: 'n1', ok: false, error: 'instruction-expired' },
    ]);
    expect(calls.map((call) => call.fn)).toEqual(['forwardExecResult']);
  });

  it('目标 tab 已关闭（update 失败）：如实回错误，不回退其他 tab', async () => {
    const { executor, calls, forwarded } = createHarness({ now: 1_000, updateRejects: true });
    await executor.executeNavigateToTab(instruction(60_000), 'https://example.com/a', 102);
    expect(forwarded).toEqual([
      {
        type: 'exec-result',
        sessionId: 's1',
        nonce: 'n1',
        ok: false,
        error: 'step-1-navigate:navigate-target-gone',
      },
    ]);
    expect(calls.map((call) => call.fn)).toEqual(['tabs.get', 'tabs.update', 'forwardExecResult']);
  });

  it('目标已离组（句柄表滞后）：不导航，如实回目标失效', async () => {
    const { executor, calls, forwarded } = createHarness({ now: 1_000, targetGroupId: 43 });
    await executor.executeNavigateToTab(instruction(60_000), 'https://example.com/a', 102);
    expect(forwarded).toEqual([
      {
        type: 'exec-result',
        sessionId: 's1',
        nonce: 'n1',
        ok: false,
        error: 'step-1-navigate:navigate-target-gone',
      },
    ]);
    expect(calls.map((call) => call.fn)).toEqual(['tabs.get', 'forwardExecResult']);
  });

  it('目标 tab 已不存在（get 失败）：不导航，如实回目标失效', async () => {
    const { executor, calls, forwarded } = createHarness({ now: 1_000, getRejects: true });
    await executor.executeNavigateToTab(instruction(60_000), 'https://example.com/a', 102);
    expect(forwarded).toEqual([
      {
        type: 'exec-result',
        sessionId: 's1',
        nonce: 'n1',
        ok: false,
        error: 'step-1-navigate:navigate-target-gone',
      },
    ]);
    expect(calls.map((call) => call.fn)).toEqual(['tabs.get', 'forwardExecResult']);
  });
});
