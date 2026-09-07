/**
 * 不变量 SD 的验收：**一个 URL 命中用户站点黑名单的页面，对服务端完全惰性——
 * 不向服务端发出任何帧，不接受任何下行指令的执行，不被登记为活跃页。**
 *
 * 用例以「帧种类」为单位枚举而非以代码路径为单位：闭集用 `Record<UpstreamFrame['type'], …>` /
 * `Record<DownstreamFrame['type'], …>` 钉死，多一种帧而不在此登记 tsc 即报错，这组用例随之失败。
 * 按代码路径逐条补判定挡不住「又多出一条路径」，按帧种类枚举才对得上不变量本身的措辞。
 *
 * 全组共用的场景是最可能发生的那一种：页面先被正常激活并成为活跃执行页，**之后**用户才把本站
 * 加进名单。此形态下端口仍在、活跃标记仍在，闸门是唯一还能拦住的东西。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { pageHandlesKeyForGroup, sessionKeyForGroup, zenGroupKey } from '../src/activation.js';
import type { DownstreamFrame, ExecInstructionFrame, GroupPagesFrame, UpstreamFrame } from '../src/frames.js';
import { SITE_DENYLIST_KEY } from '../src/site-denylist.js';
import {
  disposeHarnesses,
  loadBackground,
  settle,
  SESSION_ID,
  type FakePort,
  type FakeTab,
  type Harness,
} from './support/background-harness.js';

const GROUP_ID = 7;
const WINDOW_ID = 1;
const DENIED_ENTRY = 'https://bank.example';
const DENIED_URL = 'https://bank.example/accounts';
const ALLOWED_URL = 'https://shop.example/orders';
/** 只有本页才拿得到的内容：任何一帧把它带出去即为不变量破裂的可读证据。 */
const PAGE_ONLY_CANARY = '账户余额 123456';

const deniedTab: FakeTab = { id: 11, url: DENIED_URL, title: PAGE_ONLY_CANARY, groupId: GROUP_ID, windowId: WINDOW_ID };
const allowedTab: FakeTab = { id: 12, url: ALLOWED_URL, title: '订单', groupId: GROUP_ID, windowId: WINDOW_ID };

const mappedGroup: Record<string, unknown> = {
  [sessionKeyForGroup(GROUP_ID)]: SESSION_ID,
  [zenGroupKey(GROUP_ID)]: true,
  // 句柄表预置：定向下行帧的落点反查依赖它，且早于首次组清单对齐（300ms 防抖）。
  [pageHandlesKeyForGroup(GROUP_ID)]: { nextSeq: 3, byTab: { '11': 'p1', '12': 'p2' } },
};

interface Scene {
  h: Harness;
  /** 命中站点的页：拉黑前已激活、已上报、已是活跃执行页。 */
  denied: FakePort;
  /** 同组未命中页：用于证明拦截只落在命中页上。 */
  allowed: FakePort;
  panel: FakePort;
}

/** 拉黑前照常运转，拉黑当刻起进入被测状态；返回后 h.upstream() 里的历史帧属拉黑前，不参与断言。 */
async function sceneAfterDenylisting(): Promise<Scene> {
  const h = await loadBackground({
    denylist: [],
    tabs: [deniedTab, allowedTab],
    storageSession: { ...mappedGroup },
  });
  const denied = h.connectContent(deniedTab);
  const allowed = h.connectContent(allowedTab);
  const panel = h.connectPanel(GROUP_ID);
  denied.emit({ kind: 'context-report', url: DENIED_URL, title: PAGE_ONLY_CANARY });
  await settle();
  h.local[SITE_DENYLIST_KEY] = [DENIED_ENTRY];
  return { h, denied, allowed, panel };
}

/** 自拉黑当刻之后真正到达服务端的上行帧。 */
function upstreamSince(h: Harness, mark: number): UpstreamFrame[] {
  return h.upstream().slice(mark);
}

function execInstruction(overrides: Partial<ExecInstructionFrame> = {}): Omit<ExecInstructionFrame, 'signature'> {
  const issuedAt = Date.now();
  return {
    type: 'exec-instruction',
    sessionId: SESSION_ID,
    nonce: `n-${Math.random().toString(36).slice(2)}`,
    issuedAt,
    expiresAt: issuedAt + 60_000,
    ttl: 60_000,
    toolCallId: 'call-1',
    request: { kind: 'dom', steps: [{ action: 'click', ref: 'r1' }] },
    ...overrides,
  } as Omit<ExecInstructionFrame, 'signature'>;
}

/** 端口收到的下行帧（background → content / 面板）。 */
function framesAt(port: FakePort): DownstreamFrame[] {
  return port.received
    .filter((message): message is { kind: 'frame'; frame: DownstreamFrame } =>
      (message as { kind?: string } | null)?.kind === 'frame')
    .map((message) => message.frame);
}

afterEach(disposeHarnesses);

// ─────────────────────────────────────────────────────────────────────────────
// 第一句：命中页不向服务端发出任何帧
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 每种上行帧的归属：
 * - `denied-page` 归属某个具体页面 → 命中页的那一份一帧都不得发出；
 * - `other-source` 由面板或 background 自身产生、不归属任何页面 → 不受本不变量约束，作对照；
 * - `group-scope` 组级清单 → 帧照发，但不得含命中页条目。
 */
type FrameOrigin = 'denied-page' | 'other-source' | 'group-scope';

interface UpstreamCase {
  name: string;
  origin: FrameOrigin;
  emit(scene: Scene): Promise<void>;
}

const UPSTREAM_CASES: Record<UpstreamFrame['type'], UpstreamCase[]> = {
  'context-report': [
    {
      name: 'content 端口在名单保存后继续上报',
      origin: 'denied-page',
      emit: async ({ denied }) => {
        denied.emit({ kind: 'context-report', url: DENIED_URL, title: PAGE_ONLY_CANARY });
        await settle();
      },
    },
  ],
  'snapshot-report': [
    {
      name: '页面快照上报（含元素 label 与正文全文）',
      origin: 'denied-page',
      emit: async ({ denied }) => {
        denied.emit({
          kind: 'snapshot-report',
          report: {
            type: 'snapshot-report',
            sessionId: SESSION_ID,
            requestId: 'req-1',
            url: DENIED_URL,
            elements: [{ ref: 'r1', role: 'button', label: PAGE_ONLY_CANARY }],
            text: PAGE_ONLY_CANARY,
          },
        });
        await settle();
      },
    },
  ],
  'exec-result': [
    {
      name: '页面代执行回执（body 可携带页面数据）',
      origin: 'denied-page',
      emit: async ({ denied }) => {
        denied.emit({
          kind: 'exec-result',
          result: {
            type: 'exec-result',
            sessionId: SESSION_ID,
            nonce: 'n-1',
            ok: true,
            body: { balance: PAGE_ONLY_CANARY },
          },
        });
        await settle();
      },
    },
  ],
  'user-message': [
    {
      name: '用户在面板里发言',
      origin: 'other-source',
      emit: async ({ panel }) => {
        panel.emit({ kind: 'user-message', messageId: 'm-1', text: '这个页面能做什么', executionPreference: 'auto' });
        await settle();
      },
    },
  ],
  'hitl-decision': [
    {
      name: '用户在面板里裁决确认卡',
      origin: 'other-source',
      emit: async ({ panel }) => {
        panel.emit({ kind: 'hitl-decision', hitlId: 'h-1', decision: 'reject' });
        await settle();
      },
    },
  ],
  'config-decision': [
    {
      name: '用户在面板里裁决配置草稿',
      origin: 'other-source',
      emit: async ({ panel }) => {
        panel.emit({ kind: 'config-decision', draftId: 'd-1', decision: 'reject' });
        await settle();
      },
    },
  ],
  'group-pages': [
    {
      name: '任务组页面清单（url/title 是模型可见面）',
      origin: 'group-scope',
      emit: async ({ h }) => {
        h.emitTabUpdated(allowedTab.id, { status: 'complete' }, allowedTab);
        await new Promise((resolve) => setTimeout(resolve, 350));
        await settle();
      },
    },
  ],
};

describe('不变量 SD·上行：命中页不向服务端发出任何帧', () => {
  for (const [type, cases] of Object.entries(UPSTREAM_CASES) as Array<[UpstreamFrame['type'], UpstreamCase[]]>) {
    for (const testCase of cases) {
      const label = `${type} — ${testCase.name}`;
      if (testCase.origin === 'denied-page') {
        it(`命中页的 ${label} 一帧都不出本机`, async () => {
          const scene = await sceneAfterDenylisting();
          const mark = scene.h.upstream().length;
          await testCase.emit(scene);
          const emitted = upstreamSince(scene.h, mark).filter((frame) => frame.type === type);
          expect(emitted).toEqual([]);
          expect(JSON.stringify(upstreamSince(scene.h, mark))).not.toContain(PAGE_ONLY_CANARY);
        });
        continue;
      }
      if (testCase.origin === 'group-scope') {
        it(`组级 ${label} 不含命中页条目`, async () => {
          const scene = await sceneAfterDenylisting();
          const mark = scene.h.upstream().length;
          await testCase.emit(scene);
          const pages = upstreamSince(scene.h, mark)
            .filter((frame): frame is GroupPagesFrame => frame.type === 'group-pages')
            .flatMap((frame) => frame.pages);
          expect(pages.length).toBeGreaterThan(0);
          expect(pages.map((page) => page.url)).not.toContain(DENIED_URL);
        });
        continue;
      }
      it(`不归属页面的 ${label} 不受本不变量约束（对照）`, async () => {
        const scene = await sceneAfterDenylisting();
        const mark = scene.h.upstream().length;
        await testCase.emit(scene);
        expect(upstreamSince(scene.h, mark).filter((frame) => frame.type === type).length).toBeGreaterThan(0);
      });
    }
  }

  it('同组未命中页照常上行（拦截按页判，不按组停摆）', async () => {
    const scene = await sceneAfterDenylisting();
    const mark = scene.h.upstream().length;
    scene.allowed.emit({ kind: 'context-report', url: ALLOWED_URL, title: '订单' });
    await settle();
    expect(
      upstreamSince(scene.h, mark)
        .filter((frame): frame is Extract<UpstreamFrame, { type: 'context-report' }> => frame.type === 'context-report')
        .map((frame) => frame.url),
    ).toEqual([ALLOWED_URL]);
  });

  it('命中页自称 site-denied 拒绝回执也不上行：闸门对来自页面的帧无例外形态', async () => {
    const scene = await sceneAfterDenylisting();
    const mark = scene.h.upstream().length;
    scene.denied.emit({
      kind: 'exec-result',
      result: {
        type: 'exec-result',
        sessionId: SESSION_ID,
        nonce: 'n-forged',
        ok: false,
        error: 'site-denied',
      },
    });
    await settle();
    expect(upstreamSince(scene.h, mark)).toEqual([]);
  });

  it('名单为空时同一序列全部上行（对照：拦截只由名单驱动）', async () => {
    const h = await loadBackground({ denylist: [], tabs: [deniedTab], storageSession: { ...mappedGroup } });
    const denied = h.connectContent(deniedTab);
    const mark = h.upstream().length;
    denied.emit({ kind: 'context-report', url: DENIED_URL, title: PAGE_ONLY_CANARY });
    await settle();
    expect(upstreamSince(h, mark).filter((frame) => frame.type === 'context-report').length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 第二句：命中页不接受任何下行指令的执行
// ─────────────────────────────────────────────────────────────────────────────

/** 下行帧的落点：`page` 落到具体页面执行，`panel` 只进面板叙事（不是页面指令，作对照）。 */
type FrameLanding = 'page' | 'panel';

interface DownstreamCase {
  landing: FrameLanding;
  make(scene: Scene): Promise<DownstreamFrame>;
}

const DOWNSTREAM_CASES: Record<DownstreamFrame['type'], DownstreamCase> = {
  'exec-instruction': {
    landing: 'page',
    make: async ({ h }) => h.signExec(execInstruction()),
  },
  'guide-action': {
    landing: 'page',
    make: async () => ({ type: 'guide-action', sessionId: SESSION_ID, action: 'highlight', selector: '#pay' }),
  },
  'snapshot-request': {
    landing: 'page',
    make: async () => ({ type: 'snapshot-request', sessionId: SESSION_ID, requestId: 'req-9', includeText: true }),
  },
  'text-delta': {
    landing: 'panel',
    make: async () => ({ type: 'text-delta', sessionId: SESSION_ID, delta: '好的' }),
  },
  'turn-complete': {
    landing: 'panel',
    make: async () => ({ type: 'turn-complete', sessionId: SESSION_ID, messageId: 'm-1', idle: true }),
  },
  'tool-card': {
    landing: 'panel',
    make: async () => ({
      type: 'tool-card', sessionId: SESSION_ID, toolCallId: 'c-1', toolId: 't-1', status: 'succeeded',
    }),
  },
  'hitl-request': {
    landing: 'panel',
    make: async () => ({ type: 'hitl-request', sessionId: SESSION_ID, hitlId: 'h-1', toolId: 't-1', params: {} }),
  },
  'config-draft': {
    landing: 'panel',
    make: async () => ({
      type: 'config-draft', sessionId: SESSION_ID, draftId: 'd-1',
      scope: { packId: '*' }, change: {}, summary: '把本站加进不辅助名单',
    }),
  },
};

describe('不变量 SD·下行：命中页不接受任何下行指令的执行', () => {
  for (const [type, testCase] of Object.entries(DOWNSTREAM_CASES) as Array<
    [DownstreamFrame['type'], DownstreamCase]
  >) {
    if (testCase.landing === 'page') {
      it(`命中页不执行 ${type}`, async () => {
        const scene = await sceneAfterDenylisting();
        scene.h.pushDownstream(await testCase.make(scene));
        await settle(20);
        expect(framesAt(scene.denied).map((frame) => frame.type)).not.toContain(type);
      });
      continue;
    }
    it(`${type} 只进面板叙事、不是页面指令（对照：照常送达）`, async () => {
      const scene = await sceneAfterDenylisting();
      scene.h.pushDownstream(await testCase.make(scene));
      await settle(20);
      expect(framesAt(scene.panel).map((frame) => frame.type)).toContain(type);
    });
  }

  it('命中页的 exec-instruction 回一条不含页面数据的 site-denied 拒绝回执（由 background 自产，不经页面）', async () => {
    const scene = await sceneAfterDenylisting();
    const mark = scene.h.upstream().length;
    scene.h.pushDownstream(await scene.h.signExec(execInstruction({ nonce: 'n-denied' })));
    await settle(20);
    const results = upstreamSince(scene.h, mark).filter(
      (frame): frame is Extract<UpstreamFrame, { type: 'exec-result' }> => frame.type === 'exec-result',
    );
    expect(results).toEqual([
      { type: 'exec-result', sessionId: SESSION_ID, nonce: 'n-denied', ok: false, error: 'site-denied' },
    ]);
    expect(framesAt(scene.denied)).toEqual([]);
  });

  it('定向到命中页的 exec-instruction 同样不执行：background 直执行通路也停住（该页地址不变）', async () => {
    const scene = await sceneAfterDenylisting();
    const mark = scene.h.upstream().length;
    scene.h.pushDownstream(
      await scene.h.signExec(
        execInstruction({
          nonce: 'n-targeted',
          page: 'p1',
          request: { kind: 'dom', steps: [{ action: 'navigate', url: 'https://bank.example/transfer' }] },
        }),
      ),
    );
    await settle(20);
    expect(scene.h.tabs.get(deniedTab.id)?.url).toBe(DENIED_URL);
    expect(
      upstreamSince(scene.h, mark).filter(
        (frame): frame is Extract<UpstreamFrame, { type: 'exec-result' }> => frame.type === 'exec-result',
      ),
    ).toEqual([
      { type: 'exec-result', sessionId: SESSION_ID, nonce: 'n-targeted', ok: false, error: 'site-denied' },
    ]);
  });

  it('同组未命中页照常执行下行指令（对照：拦截按页判）', async () => {
    const scene = await sceneAfterDenylisting();
    scene.allowed.emit({ kind: 'context-report', url: ALLOWED_URL, title: '订单' });
    await settle();
    scene.h.pushDownstream({
      type: 'guide-action', sessionId: SESSION_ID, action: 'highlight', selector: '#pay',
    });
    await settle(20);
    expect(framesAt(scene.allowed).map((frame) => frame.type)).toContain('guide-action');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 第三句：命中页不被登记为活跃页
// ─────────────────────────────────────────────────────────────────────────────

describe('不变量 SD·活跃页：命中页不被登记为活跃执行页', () => {
  it('命中页在名单保存后重报上下文也抢不走活跃页，下行指令仍落在未命中页上', async () => {
    const scene = await sceneAfterDenylisting();
    scene.allowed.emit({ kind: 'context-report', url: ALLOWED_URL, title: '订单' });
    await settle();
    scene.denied.emit({ kind: 'context-report', url: DENIED_URL, title: PAGE_ONLY_CANARY });
    await settle();
    scene.h.pushDownstream({
      type: 'guide-action', sessionId: SESSION_ID, action: 'highlight', selector: '#pay',
    });
    await settle(20);
    expect(framesAt(scene.allowed).map((frame) => frame.type)).toContain('guide-action');
    expect(framesAt(scene.denied).map((frame) => frame.type)).not.toContain('guide-action');
  });

  it('navigate 复用到命中页也抢不走活跃页（该路径没有上行帧可搭闸门，登记本身即闸门）', async () => {
    const scene = await sceneAfterDenylisting();
    scene.allowed.emit({ kind: 'context-report', url: ALLOWED_URL, title: '订单' });
    await settle();
    // 组内已有一页正停在目标地址：navigate 判为「就地激活复用」，会直接把该成员标为活跃执行页。
    scene.allowed.emit({ kind: 'navigate-request', requestId: 'nav-1', url: DENIED_URL });
    await settle();
    scene.h.pushDownstream({
      type: 'guide-action', sessionId: SESSION_ID, action: 'highlight', selector: '#pay',
    });
    await settle(20);
    expect(framesAt(scene.allowed).map((frame) => frame.type)).toContain('guide-action');
  });

  it('命中页不进面板的「任务页面已连接」抬头（活跃登记与抬头同在闸门之后）', async () => {
    const scene = await sceneAfterDenylisting();
    const before = scene.panel.received.length;
    scene.denied.emit({ kind: 'context-report', url: DENIED_URL, title: PAGE_ONLY_CANARY });
    await settle();
    const contexts = scene.panel.received
      .slice(before)
      .filter((message): message is { kind: 'task-context'; url?: string } =>
        (message as { kind?: string } | null)?.kind === 'task-context');
    expect(contexts.map((message) => message.url)).not.toContain(DENIED_URL);
  });
});
