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
