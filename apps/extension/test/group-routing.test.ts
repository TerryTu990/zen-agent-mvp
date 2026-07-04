import { describe, expect, it } from 'vitest';
import type { DownstreamFrame } from '../src/frames.js';
import { createGroupMembers, routeForFrame } from '../src/group-routing.js';

const frame = (type: DownstreamFrame['type']): DownstreamFrame => ({ type }) as DownstreamFrame;

describe('routeForFrame：帧类型 → 路由目标', () => {
  it('交互/副作用帧只到活跃页：hitl-request / exec-instruction / guide-action', () => {
    expect(routeForFrame(frame('hitl-request'))).toBe('active');
    expect(routeForFrame(frame('exec-instruction'))).toBe('active');
    expect(routeForFrame(frame('guide-action'))).toBe('active');
  });

  it('会话叙事帧全员镜像：text-delta / tool-card', () => {
    expect(routeForFrame(frame('text-delta'))).toBe('all');
    expect(routeForFrame(frame('tool-card'))).toBe('all');
  });
});

describe('createGroupMembers：成员表与活跃页', () => {
  it('active 路由给显式标记的活跃成员；all 给全员', () => {
    const members = createGroupMembers<string>();
    members.add('a');
    members.add('b');
    members.markActive('a');
    expect(members.targets('active')).toEqual(['a']);
    expect(members.targets('all')).toEqual(['a', 'b']);
  });

  it('无显式活跃者回退最近加入者；组空返回空数组', () => {
    const members = createGroupMembers<string>();
    expect(members.targets('active')).toEqual([]);
    members.add('a');
    members.add('b');
    expect(members.targets('active')).toEqual(['b']);
  });

  it('活跃成员被移除后回退最近加入者（活跃页关闭的兜底）', () => {
    const members = createGroupMembers<string>();
    members.add('a');
    members.add('b');
    members.markActive('b');
    members.remove('b');
    expect(members.targets('active')).toEqual(['a']);
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
    expect(members.targets('active')).toEqual(['b']);
  });
});
