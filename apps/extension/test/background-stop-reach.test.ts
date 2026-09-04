/**
 * 停止手势的送达面：停止必须到得了组内**每一个**成员页，不是只有活跃页。
 * 定向下行帧按帧上句柄反查 tabId 投递，与谁是活跃页无关——只广播给活跃页时，
 * 已落在非活跃成员页上的批次在用户按下停止之后仍会跑完剩余步骤。
 * 复位方向同一口径：新回合的解除也须到得了每一个成员页，否则非活跃成员页会就此永久停摆。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { pageHandlesKeyForGroup, sessionKeyForGroup, zenGroupKey } from '../src/activation.js';
import type { DownstreamFrame, ExecInstructionFrame } from '../src/frames.js';
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
/** 用户视线所在页：唯一会被登记为活跃页的成员。 */
const activeTab: FakeTab = { id: 12, url: 'https://shop.example/orders', title: '订单', groupId: GROUP_ID, windowId: 1 };
/** 同组另一成员页：从不上报上下文，故永不成为活跃页，但定向批次照样落得到它。 */
const sideTab: FakeTab = { id: 13, url: 'https://shop.example/checkout', title: '结账', groupId: GROUP_ID, windowId: 1 };

const mappedGroup: Record<string, unknown> = {
  [sessionKeyForGroup(GROUP_ID)]: SESSION_ID,
  [zenGroupKey(GROUP_ID)]: true,
  // 句柄表预置：定向下行帧的落点反查依赖它，且早于首次组清单对齐（300ms 防抖）。
  [pageHandlesKeyForGroup(GROUP_ID)]: { nextSeq: 3, byTab: { '12': 'p1', '13': 'p2' } },
};

interface Scene {
  h: Harness;
  active: FakePort;
  side: FakePort;
  panel: FakePort;
}

async function twoMemberGroup(): Promise<Scene> {
  const h = await loadBackground({ tabs: [activeTab, sideTab], storageSession: { ...mappedGroup } });
  const active = h.connectContent(activeTab);
  const side = h.connectContent(sideTab);
  const panel = h.connectPanel(GROUP_ID);
  active.emit({ kind: 'context-report', url: activeTab.url, title: activeTab.title });
  await settle();
  return { h, active, side, panel };
}

function kindsAt(port: FakePort): string[] {
  return port.received.map((message) => (message as { kind?: string } | null)?.kind ?? '');
}

function directedDomBatch(): Omit<ExecInstructionFrame, 'signature'> {
  const issuedAt = Date.now();
  return {
    type: 'exec-instruction',
    sessionId: SESSION_ID,
    nonce: 'n-side',
    issuedAt,
    expiresAt: issuedAt + 60_000,
    ttl: 60_000,
    toolCallId: 'call-1',
    page: 'p2',
    request: { kind: 'dom', steps: [{ action: 'click', ref: 'za-1' }] },
  } as Omit<ExecInstructionFrame, 'signature'>;
}

afterEach(disposeHarnesses);

describe('停止手势的送达面', () => {
  it('停止广播到组内全部成员端口，不只活跃页', async () => {
    const scene = await twoMemberGroup();
    scene.panel.emit({ kind: 'stop-operation' });
    await settle(20);

    expect(kindsAt(scene.active)).toContain('stop-operation');
    expect(kindsAt(scene.side)).toContain('stop-operation');
  });

  it('新回合的复位同样广播到全部成员端口：定向批次此后照常落到非活跃成员页', async () => {
    const scene = await twoMemberGroup();
    scene.panel.emit({ kind: 'stop-operation' });
    await settle(20);
    scene.panel.emit({ kind: 'user-message', messageId: 'm-1', text: '继续', executionPreference: 'auto' });
    await settle(20);
    scene.h.pushDownstream(await scene.h.signExec(directedDomBatch()));
    await settle(20);

    const kinds = kindsAt(scene.side);
    const landed = scene.side.received.findIndex(
      (message) => (message as { kind?: string; frame?: DownstreamFrame } | null)?.kind === 'frame',
    );
    expect(landed).toBeGreaterThanOrEqual(0);
    expect(kinds.lastIndexOf('resume-operation')).toBeGreaterThan(kinds.indexOf('stop-operation'));
    expect(kinds.lastIndexOf('resume-operation')).toBeLessThan(landed);
  });
});
