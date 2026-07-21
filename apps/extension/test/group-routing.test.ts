import { describe, expect, it } from 'vitest';
import type { DownstreamFrame } from '../src/frames.js';
import { createGroupMembers, routeForFrame } from '../src/group-routing.js';

const frame = (type: DownstreamFrame['type']): DownstreamFrame => ({ type }) as DownstreamFrame;

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

  it('无显式活跃者回退最近加入者；组空返回空数组', () => {
    const members = createGroupMembers<string>();
    expect(members.targets('active-page')).toEqual([]);
    members.add('a');
    members.add('b');
    expect(members.targets('active-page')).toEqual(['b']);
  });

  it('活跃成员被移除后回退最近加入者（活跃页关闭的兜底）', () => {
    const members = createGroupMembers<string>();
    members.add('a');
    members.add('b');
    members.markActive('b');
    members.remove('b');
    expect(members.targets('active-page')).toEqual(['a']);
    expect(members.size()).toBe(1);
  });

  it('重复 add 幂等；others 排除自身；markActive 不接受非成员', () => {
    const members = createGroupMembers<string>();
    members.add('a');
    members.add('a');
    members.add('b');
    expect(members.size()).toBe(2);
    expect(members.others('a')).toEqual(['b']);
    members.markActive('ghost');
    expect(members.targets('active-page')).toEqual(['b']);
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
