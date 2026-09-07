/**
 * 停止手势与落页帧的顺序。
 * 落页帧走一条异步串行链（每帧至少一次 storage 读才取得判定所需事实），停止手势则同步投递：
 * 两者不共用顺序语义时，用户按下停止之后，链上尚未落页的帧仍会送到页面上执行。
 * 本组用例钉的是「停止置位当刻还在链上的帧不再落页」，以及它不把本组永久停摆。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { sessionKeyForGroup, zenGroupKey } from '../src/activation.js';
import type { DownstreamFrame } from '../src/frames.js';
import { SITE_DENYLIST_KEY } from '../src/site-denylist.js';
import {
  disposeHarnesses,
  loadBackground,
  SESSION_ID,
  settle,
  type FakePort,
  type FakeTab,
} from './support/background-harness.js';

const GROUP_ID = 7;
const workTab: FakeTab = { id: 12, url: 'https://shop.example/orders', title: '订单', groupId: GROUP_ID, windowId: 1 };
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

function kindsAt(port: FakePort): string[] {
  return port.received.map((message) => (message as { kind?: string } | null)?.kind ?? '');
}

function landedFrameTypes(port: FakePort): string[] {
  return port.received
    .filter((message): message is { kind: 'frame'; frame: DownstreamFrame } =>
      (message as { kind?: string } | null)?.kind === 'frame')
    .map((message) => message.frame.type);
}

interface Scene {
  content: FakePort;
  panel: FakePort;
  /** 下一帧落页判定取事实的当刻执行一次（帧已进串行链、尚未落页的那个窗口）。 */
  armDuringLanding(action: () => void): void;
  push(frame: DownstreamFrame): void;
}

async function activeGroup(): Promise<Scene> {
  let armed: (() => void) | null = null;
  const h = await loadBackground({
    tabs: [workTab],
    storageSession: mappedGroup,
    onLocalRead: (keys) => {
      if (keys !== SITE_DENYLIST_KEY) return;
      const action = armed;
      armed = null;
      action?.();
    },
  });
  const content = h.connectContent(workTab);
  const panel = h.connectPanel(GROUP_ID);
  content.emit({ kind: 'context-report', url: workTab.url, title: workTab.title });
  await settle();
  return {
    content,
    panel,
    armDuringLanding: (action) => {
      armed = action;
    },
    push: (frame) => h.pushDownstream(frame),
  };
}

afterEach(disposeHarnesses);

describe('停止手势与落页帧的顺序', () => {
  it('停止置位当刻仍在串行链上的帧不再落页', async () => {
    const scene = await activeGroup();
    scene.armDuringLanding(() => scene.panel.emit({ kind: 'stop-operation' }));
    scene.push(guideAction);
    await settle(20);

    expect(kindsAt(scene.content)).toContain('stop-operation');
    expect(landedFrameTypes(scene.content)).not.toContain('guide-action');
  });

  it('新回合开始之后的帧照常落页（对照：停止不使本组永久停摆）', async () => {
    const scene = await activeGroup();
    scene.panel.emit({ kind: 'stop-operation' });
    await settle(20);
    scene.panel.emit({ kind: 'user-message', messageId: 'm-1', text: '继续' });
    await settle(20);
    scene.push(guideAction);
    await settle(20);

    expect(landedFrameTypes(scene.content)).toContain('guide-action');
  });
});
