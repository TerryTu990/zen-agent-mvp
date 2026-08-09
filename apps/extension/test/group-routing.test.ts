import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type {
  DownstreamFrame,
  ExecInstructionFrame,
  GuideActionFrame,
  SnapshotRequestFrame,
} from '../src/frames.js';
import {
  createGroupMembers,
  resolveTargetPageMembers,
  routeForFrame,
  targetPageMembers,
} from '../src/group-routing.js';
import type { PageHandleTable } from '../src/page-handles.js';

const frame = (type: DownstreamFrame['type']): DownstreamFrame => ({ type }) as DownstreamFrame;

const snapshotRequest = (page?: string): SnapshotRequestFrame => ({
  type: 'snapshot-request',
  sessionId: 's1',
  requestId: 'r1',
  ...(page !== undefined ? { page } : {}),
});

const execInstruction = (page?: string): ExecInstructionFrame => ({
  type: 'exec-instruction',
  sessionId: 's1',
  nonce: 'n1',
  issuedAt: 0,
  expiresAt: 60_000,
  ttl: 60_000,
  signature: 'sig',
  toolCallId: 'tc1',
  ...(page !== undefined ? { page } : {}),
  request: { kind: 'dom', steps: [{ action: 'click', ref: 'za-1' }] },
});

const guideAction = (page?: string): GuideActionFrame => ({
  type: 'guide-action',
  sessionId: 's1',
  action: 'highlight',
  selector: '#a',
  ...(page !== undefined ? { page } : {}),
});

describe('routeForFrame：帧类型 → 路由目标', () => {
  it('对话与 HITL 只到 Side Panel，页面帧只到权威执行页', () => {
    expect(routeForFrame(frame('hitl-request'))).toBe('panel');
    expect(routeForFrame(frame('exec-instruction'))).toBe('active-page');
    expect(routeForFrame(frame('guide-action'))).toBe('active-page');
    expect(routeForFrame(frame('snapshot-request'))).toBe('active-page');
  });

  it('会话叙事帧进入 Side Panel：text-delta / tool-card', () => {
    expect(routeForFrame(frame('text-delta'))).toBe('panel');
    expect(routeForFrame(frame('tool-card'))).toBe('panel');
  });

  it('snapshot-request 无 page 维持活跃页路由；带 page 走目标页单播（adr-023 D2）', () => {
    expect(routeForFrame(snapshotRequest())).toBe('active-page');
    expect(routeForFrame(snapshotRequest('p3'))).toBe('target-page');
    expect(routeForFrame(snapshotRequest('workspace-view-00c3'))).toBe('target-page');
  });

  it('exec-instruction / guide-action 无 page 维持活跃页路由；带 page 走目标页单播（adr-023 D3）', () => {
    expect(routeForFrame(execInstruction())).toBe('active-page');
    expect(routeForFrame(guideAction())).toBe('active-page');
    expect(routeForFrame(execInstruction('p2'))).toBe('target-page');
    expect(routeForFrame(guideAction('p2'))).toBe('target-page');
    expect(routeForFrame(execInstruction('workspace-view-00c3'))).toBe('target-page');
  });
});

describe('targetPageMembers：目标页单播解析', () => {
  interface FakePort {
    name: string;
    tabId?: number;
  }
  const tabIdOf = (member: FakePort): number | undefined => member.tabId;
  const active: FakePort = { name: 'active', tabId: 101 };
  const target: FakePort = { name: 'target', tabId: 102 };

  it('句柄命中：只投目标成员，活跃成员不被投递，且至多一个成员', () => {
    const delivered = targetPageMembers([active, target], tabIdOf, 102);
    expect(delivered).toEqual([target]);
    expect(delivered).toHaveLength(1);
    expect(delivered).not.toContain(active);
  });

  it('目标成员端口不在：零投递且禁回退活跃页（负锚）', () => {
    expect(targetPageMembers([active], tabIdOf, 102)).toEqual([]);
  });

  it('句柄已退役（tabId=null）：零投递且禁回退活跃页（负锚）', () => {
    expect(targetPageMembers([active, target], tabIdOf, null)).toEqual([]);
  });

  it('成员无 sender tab（tabId undefined）不被误命中', () => {
    const detached: FakePort = { name: 'detached' };
    expect(targetPageMembers([detached, target], tabIdOf, 102)).toEqual([target]);
  });
});

describe('resolveTargetPageMembers：postFrame target-page 粘合（句柄提取 → 反查 → 端口匹配）', () => {
  // 桩端口按真实接线取 sender.tab.id（background 的 tabIdOf 惯例）。
  interface StubPort {
    name: string;
    sender?: { tab?: { id?: number } };
  }
  const tabIdOf = (member: StubPort): number | undefined => member.sender?.tab?.id;
  const activePort: StubPort = { name: 'active', sender: { tab: { id: 101 } } };
  const targetPort: StubPort = { name: 'target', sender: { tab: { id: 102 } } };
  const table: PageHandleTable = { nextSeq: 3, byTab: { '101': 'p1', '102': 'p2' } };

  it('带 page 的 snapshot-request：经句柄表反查 tabId，只单播目标端口成员', () => {
    const delivered = resolveTargetPageMembers(
      snapshotRequest('p2'),
      table,
      [activePort, targetPort],
      tabIdOf,
    );
    expect(delivered).toEqual([targetPort]);
    expect(delivered).toHaveLength(1);
    expect(delivered).not.toContain(activePort);
  });

  it('句柄未命中（退役/从未存在）：零投递且活跃端口未被投递（禁回退负锚）', () => {
    expect(
      resolveTargetPageMembers(snapshotRequest('p9'), table, [activePort, targetPort], tabIdOf),
    ).toEqual([]);
  });

  it('句柄命中 tabId 但目标端口不在（silent/刚断连竞态）：零投递不改投', () => {
    expect(resolveTargetPageMembers(snapshotRequest('p2'), table, [activePort], tabIdOf)).toEqual(
      [],
    );
  });

  it('句柄表为空（SW 重启读回前形态）：零投递不误投活跃页', () => {
    expect(
      resolveTargetPageMembers(
        snapshotRequest('p2'),
        { nextSeq: 1, byTab: {} },
        [activePort, targetPort],
        tabIdOf,
      ),
    ).toEqual([]);
  });

  it('exec-instruction / guide-action 带 page：同一粘合层解析，只单播目标端口成员（adr-023 D3）', () => {
    expect(
      resolveTargetPageMembers(execInstruction('p2'), table, [activePort, targetPort], tabIdOf),
    ).toEqual([targetPort]);
    expect(
      resolveTargetPageMembers(guideAction('p2'), table, [activePort, targetPort], tabIdOf),
    ).toEqual([targetPort]);
  });

  it('不载句柄的帧（无 page 的 snapshot-request/exec/guide、其他帧型）：不提取、零投递', () => {
    expect(
      resolveTargetPageMembers(snapshotRequest(), table, [activePort, targetPort], tabIdOf),
    ).toEqual([]);
    expect(
      resolveTargetPageMembers(execInstruction(), table, [activePort, targetPort], tabIdOf),
    ).toEqual([]);
    expect(
      resolveTargetPageMembers(guideAction(), table, [activePort, targetPort], tabIdOf),
    ).toEqual([]);
    expect(
      resolveTargetPageMembers(frame('text-delta'), table, [activePort, targetPort], tabIdOf),
    ).toEqual([]);
  });
});

describe('background target-page 分发（接线回归）', () => {
  it('SW 重启窗口：target-page 分发前等句柄表读回（比照 nonceHistoryReady），投递走粘合层解析', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/background.ts', import.meta.url)), 'utf8');
    expect(source).toContain("if (route === 'target-page') await pageHandlesReady;");
    expect(source).toContain('resolveTargetPageMembers(');
  });

  it('silent 定向直执行接线：无端口成员时经 decideTargetedNavigate 判定、executeNavigateToTab 落点执行', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/background.ts', import.meta.url)), 'utf8');
    expect(source).toContain('decideTargetedNavigate(frame, pageHandles)');
    expect(source).toContain('executeNavigateToTab(direct.frame, direct.url, direct.tabId)');
  });
});

describe('createGroupMembers：成员表与活跃页', () => {
  it('active-page 路由给显式标记的活跃成员；panel 给全员', () => {
    const members = createGroupMembers<string>();
    members.add('a');
    members.add('b');
    members.markActive('a');
    expect(members.targets('active-page')).toEqual(['a']);
    expect(members.targets('panel')).toEqual(['a', 'b']);
  });

  it('active=null 但存在曾活跃成员：回退到该曾活跃成员', () => {
    const members = createGroupMembers<string>();
    members.add('a');
    members.markActive('a');
    members.add('b');
    members.markActive('b');
    // 移除当前 active b → active 清空，但 a 仍在成员表且曾活跃
    members.remove('b');
    expect(members.targets('active-page')).toEqual(['a']);
  });

  it('active=null 且成员从未活跃（后台页）：不投静默页，返回空数组', () => {
    const members = createGroupMembers<string>();
    expect(members.targets('active-page')).toEqual([]);
    members.add('a');
    members.add('b');
    // a、b 均为端口入组但从未 markActive 的后台页 → 宁可不投也不投静默页
    expect(members.targets('active-page')).toEqual([]);
  });

  it('曾活跃成员被移除后不再作为 fallback：无其他曾活跃者则返回空数组', () => {
    const members = createGroupMembers<string>();
    members.add('a');
    members.add('b');
    members.markActive('b');
    members.remove('b');
    // a 从未活跃，b 已移除 → 无任何曾活跃成员可回退
    expect(members.targets('active-page')).toEqual([]);
    expect(members.size()).toBe(1);
  });

  it('曾活跃成员与从未活跃成员并存时，fallback 只落在曾活跃者', () => {
    const members = createGroupMembers<string>();
    members.add('a');
    members.markActive('a');
    members.add('b');
    members.add('c');
    // a 曾活跃并仍是 active；b、c 是从未活跃的后台页
    members.remove('a');
    // a 移除后 active 清空且从曾活跃集中剔除 → 只剩从未活跃的 b、c → 不投递
    expect(members.targets('active-page')).toEqual([]);
  });

  it('重复 add 幂等；others 排除自身；markActive 不接受非成员', () => {
    const members = createGroupMembers<string>();
    members.add('a');
    members.add('a');
    members.add('b');
    expect(members.size()).toBe(2);
    expect(members.others('a')).toEqual(['b']);
    members.markActive('ghost');
    expect(members.targets('active-page')).toEqual([]);
  });

  it('members 返回独立快照，供调度按候选 tab 精确绑定 content port', () => {
    const members = createGroupMembers<string>();
    members.add('tab-orders');
    members.add('tab-chat');
    const snapshot = members.members();
    expect(snapshot.find((member) => member === 'tab-chat')).toBe('tab-chat');
    snapshot.pop();
    expect(members.members()).toEqual(['tab-orders', 'tab-chat']);
  });
});
