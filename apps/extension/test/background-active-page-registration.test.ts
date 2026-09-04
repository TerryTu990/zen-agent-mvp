/**
 * 活跃执行页登记的时机：判定必须先于登记（命中站点的页不得成为下行落点），
 * 但登记不必等上行 POST 往返完成。
 * 等往返则留下一个窗口：context-report 已到、POST 尚未回，其间到达的 active-page
 * 下行帧全部落到**上一个**活跃页——用户已经切了页，动作却发生在他刚离开的那一页上。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { sessionKeyForGroup, zenGroupKey } from '../src/activation.js';
import type { DownstreamFrame } from '../src/frames.js';
import {
  BASE_URL,
  disposeHarnesses,
  loadBackground,
  SESSION_ID,
  settle,
  type FakePort,
  type FakeTab,
  type Served,
  type ServedRequest,
} from './support/background-harness.js';

const GROUP_ID = 7;
const firstTab: FakeTab = { id: 12, url: 'https://shop.example/orders', title: '订单', groupId: GROUP_ID, windowId: 1 };
const secondTab: FakeTab = { id: 13, url: 'https://shop.example/checkout', title: '结账', groupId: GROUP_ID, windowId: 1 };
const mappedGroup: Record<string, unknown> = {
  [sessionKeyForGroup(GROUP_ID)]: SESSION_ID,
  [zenGroupKey(GROUP_ID)]: true,
};

const guideAction: DownstreamFrame = {
  type: 'guide-action',
  sessionId: SESSION_ID,
  action: 'highlight',
  selector: '#pay',
};

function isContextReportFor(request: ServedRequest, url: string): boolean {
  const body = request.body as { type?: string; url?: string } | null;
  return (
    request.url === `${BASE_URL}/v1/sessions/${SESSION_ID}/frames` &&
    body?.type === 'context-report' &&
    body.url === url
  );
}

function landedFrameTypes(port: FakePort): string[] {
  return port.received
    .filter((message): message is { kind: 'frame'; frame: DownstreamFrame } =>
      (message as { kind?: string } | null)?.kind === 'frame')
    .map((message) => message.frame.type);
}

afterEach(disposeHarnesses);

describe('活跃执行页登记与上行往返', () => {
  it('切页的 context-report 其 POST 仍在途时，active-page 下行帧已落到新页', async () => {
    let releaseSecondReport = (): void => {};
    const inflight = new Promise<Served>((resolve) => {
      releaseSecondReport = (): void => resolve({ status: 200, body: { messageState: 'complete' } });
    });
    const h = await loadBackground({
      tabs: [firstTab, secondTab],
      storageSession: { ...mappedGroup },
      serve: (request) => (isContextReportFor(request, secondTab.url) ? inflight : undefined),
    });
    const first = h.connectContent(firstTab);
    const second = h.connectContent(secondTab);
    h.connectPanel(GROUP_ID);
    first.emit({ kind: 'context-report', url: firstTab.url, title: firstTab.title });
    await settle();

    second.emit({ kind: 'context-report', url: secondTab.url, title: secondTab.title });
    await settle();
    // 此刻第二页的 context-report 仍停在 POST 往返里：登记不得等它。
    h.pushDownstream(guideAction);
    await settle(20);

    expect(landedFrameTypes(second)).toContain('guide-action');
    expect(landedFrameTypes(first)).not.toContain('guide-action');
    releaseSecondReport();
    await settle();
  });

  it('命中站点的页仍不得成为落点：判定先于登记的不变量不因此松动', async () => {
    const h = await loadBackground({
      denylist: ['https://bank.example'],
      tabs: [firstTab, { ...secondTab, url: 'https://bank.example/accounts' }],
      storageSession: { ...mappedGroup },
    });
    const first = h.connectContent(firstTab);
    const denied = h.connectContent({ ...secondTab, url: 'https://bank.example/accounts' });
    h.connectPanel(GROUP_ID);
    first.emit({ kind: 'context-report', url: firstTab.url, title: firstTab.title });
    await settle();

    denied.emit({ kind: 'context-report', url: 'https://bank.example/accounts', title: '账户' });
    await settle(20);
    h.pushDownstream(guideAction);
    await settle(20);

    expect(landedFrameTypes(denied)).toEqual([]);
    expect(landedFrameTypes(first)).toContain('guide-action');
  });
});
