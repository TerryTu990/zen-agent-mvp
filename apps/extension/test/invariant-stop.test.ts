/**
 * 不变量 ST 的验收：**一个回合被停止后，在明确的新回合开始之前，该组内不再发生任何由该回合
 * 驱动的页面副作用——无论副作用由 content 执行、还是由 background 自己执行。**
 *
 * 用例按「会产生页面副作用的执行路径」枚举，两个闭集由 tsc 钉死：
 * content 端口投递的下行帧 `PageDownstreamFrame['type']`，background 自执行的导航
 * `keyof NavigateExecutor`。多一种落页帧、多一个自执行导航入口而不在此登记，编译即失败。
 * 按「谁记得加判定」逐条打补丁挡不住下一条新通路，按副作用出口枚举才对得上不变量本身的措辞。
 *
 * 副作用以 background 侧可观察的两件事为准：把活交到某个成员页端口（页面据此动手），
 * 以及 background 自己改宿主 tab 的地址/开新页。
 * 每条路径三判：停止后不发生（不变量本体）、未停止时确实发生（否则用例空转）、
 * 新回合开始后恢复（停止不把本组永久停摆）。副作用被异步前置步骤推迟的路径（轨一注入等端口接入）
 * 多一判：闸门之后、副作用之前停止，副作用仍不得发生——闸门查过就放行等于把判定停在了错误的时刻。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { pageHandlesKeyForGroup, sessionKeyForGroup, zenGroupKey } from '../src/activation.js';
import type { PageDownstreamFrame } from '../src/content-router.js';
import type { DownstreamFrame, ExecInstructionFrame } from '../src/frames.js';
import type { NavigateExecutor } from '../src/navigate-execution.js';
import { tabUrlOf } from '../src/site-denylist.js';
import {
  disposeHarnesses,
  loadBackground,
  SESSION_ID,
  settle,
  type FakePort,
  type FakeTab,
  type Harness,
} from './support/background-harness.js';

const GROUP_ID = 7;
const WINDOW_ID = 1;
/** 用户视线所在页：缺省路由（无句柄的帧）的落点。 */
const activeTab: FakeTab = { id: 12, url: 'https://shop.example/orders', title: '订单', groupId: GROUP_ID, windowId: WINDOW_ID };
/** 同组另一成员页：从不上报上下文，故永不成为活跃页；定向帧按句柄照样落得到它。 */
const sideTab: FakeTab = { id: 13, url: 'https://shop.example/checkout', title: '结账', groupId: GROUP_ID, windowId: WINDOW_ID };
const SIDE_HANDLE = 'p2';
const NAVIGATE_URL = 'https://shop.example/receipt';

const mappedGroup: Record<string, unknown> = {
  [sessionKeyForGroup(GROUP_ID)]: SESSION_ID,
  [zenGroupKey(GROUP_ID)]: true,
  // 句柄表预置：定向下行帧的落点反查依赖它，且早于首次组清单对齐（300ms 防抖）。
  [pageHandlesKeyForGroup(GROUP_ID)]: { nextSeq: 3, byTab: { '12': 'p1', '13': SIDE_HANDLE } },
};

interface Scene {
  h: Harness;
  panel: FakePort;
  /** 组内成员页端口，按登记序；冷启动形态为空。 */
  pages: FakePort[];
  /** 至此刻为止本组发生过的页面副作用全量快照（相等即无新增）。 */
  effects(): string[];
}

function framesAt(port: FakePort): DownstreamFrame[] {
  return port.received
    .filter((message): message is { kind: 'frame'; frame: DownstreamFrame } =>
      (message as { kind?: string } | null)?.kind === 'frame')
    .map((message) => message.frame);
}

function effectsOf(h: Harness, pages: FakePort[]): string[] {
  return [
    ...pages.flatMap((port, index) => framesAt(port).map((frame) => `交给第${index + 1}页执行:${frame.type}`)),
    ...[...h.tabs.values()].map((tab) => `tab${tab.id}=${tabUrlOf(tab) ?? ''}`),
  ];
}

/** 两个成员页 + 面板；活跃页已上报上下文，会话与下行订阅已就绪。 */
async function groupWithPages(): Promise<Scene> {
  const h = await loadBackground({ tabs: [activeTab, sideTab], storageSession: { ...mappedGroup } });
  const active = h.connectContent(activeTab);
  const side = h.connectContent(sideTab);
  const panel = h.connectPanel(GROUP_ID);
  active.emit({ kind: 'context-report', url: activeTab.url, title: activeTab.title });
  await settle();
  const pages = [active, side];
  return { h, panel, pages, effects: () => effectsOf(h, pages) };
}

/**
 * 定向目标页在组内、有句柄、但当刻没有 content 端口：按需注入模型下这是组内成员的常态。
 * 该形态的帧要先注入目标页、等端口接入，投递因此发生在推送之后的某个异步时刻。
 */
async function groupWithDetachedTargetPage(): Promise<Scene> {
  const h = await loadBackground({ tabs: [activeTab, sideTab], storageSession: { ...mappedGroup } });
  const active = h.connectContent(activeTab);
  const panel = h.connectPanel(GROUP_ID);
  active.emit({ kind: 'context-report', url: activeTab.url, title: activeTab.title });
  await settle();
  const pages = [active];
  return { h, panel, pages, effects: () => effectsOf(h, pages) };
}

/** 注入落地、目标页端口接入：等在那里的定向帧在这一刻才真正交到页面手上。 */
async function attachTargetPage(scene: Scene): Promise<void> {
  scene.pages.push(scene.h.connectContent(sideTab));
  await settle(20);
}

/** 组内无任何 content 成员的冷启动形态：会话由面板的第一条消息建立。 */
async function groupWithoutPages(): Promise<Scene> {
  const h = await loadBackground({ tabs: [], storageSession: { ...mappedGroup } });
  const panel = h.connectPanel(GROUP_ID);
  panel.emit({ kind: 'user-message', messageId: 'm-open', text: '打开收据页', executionPreference: 'auto' });
  await settle(20);
  return { h, panel, pages: [], effects: () => effectsOf(h, []) };
}

async function stopOperation(scene: Scene): Promise<void> {
  scene.panel.emit({ kind: 'stop-operation' });
  await settle(20);
}

async function beginNewTurn(scene: Scene): Promise<void> {
  scene.panel.emit({ kind: 'user-message', messageId: `m-${Math.random().toString(36).slice(2)}`, text: '继续', executionPreference: 'auto' });
  await settle(20);
}

function domBatch(overrides: Partial<ExecInstructionFrame> = {}): Omit<ExecInstructionFrame, 'signature'> {
  const issuedAt = Date.now();
  return {
    type: 'exec-instruction',
    sessionId: SESSION_ID,
    nonce: `n-${Math.random().toString(36).slice(2)}`,
    issuedAt,
    expiresAt: issuedAt + 60_000,
    ttl: 60_000,
    toolCallId: 'call-1',
    request: { kind: 'dom', steps: [{ action: 'click', ref: 'za-1' }] },
    ...overrides,
  } as Omit<ExecInstructionFrame, 'signature'>;
}

async function pushExec(scene: Scene, overrides: Partial<ExecInstructionFrame> = {}): Promise<void> {
  scene.h.pushDownstream(await scene.h.signExec(domBatch(overrides)));
  await settle(20);
}

interface PathCase {
  /** 路径编号，只用于枚举定位；断言的措辞恒是不变量本身。 */
  id: string;
  scene(): Promise<Scene>;
  fire(scene: Scene): Promise<void>;
  /**
   * 副作用的落地被异步前置步骤推迟时，兑现那一步（如轨一注入后目标页端口接入）。
   * 声明它的路径多一判：fire 与本步之间发生的停止同样必须挡住副作用。
   */
  settleArrival?(scene: Scene): Promise<void>;
}

/**
 * content 端口投递的下行帧：页面据此动手，闭集随 PageDownstreamFrame 收敛。
 * 每种帧的缺省路由（活跃页）与定向路由（帧上句柄单播非活跃成员页）各算一条路径——
 * 两条在 background 里是两个分支，只守住一条不成立。
 */
const DELIVERED_PATHS: Record<PageDownstreamFrame['type'], PathCase[]> = {
  'exec-instruction': [
    {
      id: 'dom 批次 → 活跃页',
      scene: groupWithPages,
      fire: (scene) => pushExec(scene),
    },
    {
      id: 'dom 批次 → 定向非活跃成员页',
      scene: groupWithPages,
      fire: (scene) => pushExec(scene, { page: SIDE_HANDLE }),
    },
    {
      id: 'dom 批次 → 定向成员页无 content 端口（注入后投递）',
      scene: groupWithDetachedTargetPage,
      fire: (scene) => pushExec(scene, { page: SIDE_HANDLE }),
      settleArrival: attachTargetPage,
    },
    {
      id: 'http 代执行 → 活跃页（content 侧的闩本就不覆盖这一形态）',
      scene: groupWithPages,
      fire: (scene) => pushExec(scene, { request: { method: 'POST', url: 'https://shop.example/api/pay' } }),
    },
  ],
  'guide-action': [
    {
      id: '引导高亮 → 活跃页',
      scene: groupWithPages,
      fire: async (scene) => {
        scene.h.pushDownstream({ type: 'guide-action', sessionId: SESSION_ID, action: 'highlight', selector: '#pay' });
        await settle(20);
      },
    },
    {
      id: '引导高亮 → 定向非活跃成员页',
      scene: groupWithPages,
      fire: async (scene) => {
        scene.h.pushDownstream({
          type: 'guide-action', sessionId: SESSION_ID, action: 'scroll-to', selector: '#pay', page: SIDE_HANDLE,
        });
        await settle(20);
      },
    },
    {
      id: '引导高亮 → 定向成员页无 content 端口（注入后投递）',
      scene: groupWithDetachedTargetPage,
      fire: async (scene) => {
        scene.h.pushDownstream({
          type: 'guide-action', sessionId: SESSION_ID, action: 'highlight', selector: '#pay', page: SIDE_HANDLE,
        });
        await settle(20);
      },
      settleArrival: attachTargetPage,
    },
  ],
  'snapshot-request': [
    {
      id: '页面快照 → 活跃页',
      scene: groupWithPages,
      fire: async (scene) => {
        scene.h.pushDownstream({ type: 'snapshot-request', sessionId: SESSION_ID, requestId: 'req-1' });
        await settle(20);
      },
    },
    {
      id: '页面快照 → 定向非活跃成员页',
      scene: groupWithPages,
      fire: async (scene) => {
        scene.h.pushDownstream({ type: 'snapshot-request', sessionId: SESSION_ID, requestId: 'req-2', page: SIDE_HANDLE });
        await settle(20);
      },
    },
    {
      id: '页面快照 → 定向成员页无 content 端口（注入后投递）',
      scene: groupWithDetachedTargetPage,
      fire: async (scene) => {
        scene.h.pushDownstream({ type: 'snapshot-request', sessionId: SESSION_ID, requestId: 'req-3', page: SIDE_HANDLE });
        await settle(20);
      },
      settleArrival: attachTargetPage,
    },
  ],
};

/**
 * background 自己执行的页面副作用：不经 content 端口，页面侧的闩按构造管不到。
 * 闭集随 NavigateExecutor 的方法面收敛——新增一个自执行入口而不在此登记即编译失败。
 */
const BACKGROUND_PATHS: Record<keyof NavigateExecutor, PathCase> = {
  executeNavigateToTab: {
    id: '定向单步 navigate：background 直接对句柄页换地址',
    scene: groupWithPages,
    fire: (scene) => pushExec(scene, {
      page: SIDE_HANDLE,
      request: { kind: 'dom', steps: [{ action: 'navigate', url: NAVIGATE_URL }] },
    }),
  },
  executeNavigateWithoutPage: {
    id: '冷启动 open_url：组内无 content 成员时 background 开页',
    scene: groupWithoutPages,
    fire: (scene) => pushExec(scene, {
      request: { kind: 'dom', steps: [{ action: 'navigate', url: NAVIGATE_URL }] },
    }),
  },
  performNavigate: {
    id: 'dom 批次的 navigate 步：页面委托 background 开页',
    scene: groupWithPages,
    fire: async (scene) => {
      scene.pages[0]?.emit({ kind: 'navigate-request', requestId: 'nav-1', url: 'https://other.example/landing' });
      await settle(20);
    },
  },
};

const ALL_PATHS: PathCase[] = [
  ...Object.values(DELIVERED_PATHS).flat(),
  ...Object.values(BACKGROUND_PATHS),
];

afterEach(disposeHarnesses);

describe('不变量 ST：停止之后、新回合之前不再发生页面副作用', () => {
  for (const path of ALL_PATHS) {
    it(`停止之后不再发生页面副作用 — ${path.id}`, async () => {
      const scene = await path.scene();
      await stopOperation(scene);
      const before = scene.effects();
      await path.fire(scene);
      await path.settleArrival?.(scene);
      expect(scene.effects()).toEqual(before);
    });

    it(`未停止时该路径确实产生页面副作用（对照：上一条不是空转） — ${path.id}`, async () => {
      const scene = await path.scene();
      const before = scene.effects();
      await path.fire(scene);
      await path.settleArrival?.(scene);
      expect(scene.effects()).not.toEqual(before);
    });

    it(`新回合开始后重新发生页面副作用（停止不把本组永久停摆） — ${path.id}`, async () => {
      const scene = await path.scene();
      await stopOperation(scene);
      await beginNewTurn(scene);
      const before = scene.effects();
      await path.fire(scene);
      await path.settleArrival?.(scene);
      expect(scene.effects()).not.toEqual(before);
    });

    const settleArrival = path.settleArrival;
    if (settleArrival === undefined) continue;
    it(`副作用落地前的一刻停止，副作用仍不发生 — ${path.id}`, async () => {
      const scene = await path.scene();
      const before = scene.effects();
      await path.fire(scene);
      await stopOperation(scene);
      await settleArrival(scene);
      expect(scene.effects()).toEqual(before);
    });
  }
});

describe('不变量 ST：端口接入时取当前停止态，不依赖曾经广播过什么', () => {
  it('停止之后才接入的成员页，接入即处于停止态', async () => {
    const scene = await groupWithPages();
    await stopOperation(scene);
    const late = scene.h.connectContent(sideTab);
    await settle();
    expect(late.received).toContainEqual({ kind: 'stop-operation' });
  });

  it('新回合开始之后接入的成员页，接入即解除停止态', async () => {
    const scene = await groupWithPages();
    await stopOperation(scene);
    await beginNewTurn(scene);
    const late = scene.h.connectContent(sideTab);
    await settle();
    expect(late.received).toContainEqual({ kind: 'resume-operation' });
  });
});
