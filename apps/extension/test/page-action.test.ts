import { describe, expect, it } from 'vitest';
import type { GuideActionFrame, GuideActionKind } from '../src/frames.js';
import { createPageActionRunner, type GuidePage, type GuideTarget } from '../src/page-action.js';

interface TargetSpy extends GuideTarget {
  highlightCount: number;
  unhighlightCount: number;
  scrollCount: number;
}

function makeTarget(): TargetSpy {
  const spy: TargetSpy = {
    highlightCount: 0,
    unhighlightCount: 0,
    scrollCount: 0,
    highlight() {
      spy.highlightCount += 1;
    },
    unhighlight() {
      spy.unhighlightCount += 1;
    },
    scrollIntoView() {
      spy.scrollCount += 1;
    },
  };
  return spy;
}

function makePage(targets: Record<string, TargetSpy>, refs: Record<string, TargetSpy> = {}): GuidePage {
  return {
    querySelector(selector) {
      return targets[selector] ?? null;
    },
    resolveRef(ref) {
      return refs[ref] ?? null;
    },
  };
}

function frame(action: GuideActionKind, selector: string, message?: string): GuideActionFrame {
  return message === undefined
    ? { type: 'guide-action', sessionId: 's1', action, selector }
    : { type: 'guide-action', sessionId: 's1', action, selector, message };
}

describe('page-action 引导执行', () => {
  it('命中 highlight：加高亮、不滚动、回报成功状态', () => {
    const el = makeTarget();
    const runner = createPageActionRunner(makePage({ '#btn-export': el }));

    const result = runner.run(frame('highlight', '#btn-export', '导出按钮在操作区'));

    expect(result.hit).toBe(true);
    expect(el.highlightCount).toBe(1);
    expect(el.scrollCount).toBe(0);
    expect(result.status).toBe('已为你定位：导出按钮在操作区');
  });

  it('命中 scroll-to：加高亮并滚动到元素', () => {
    const el = makeTarget();
    const runner = createPageActionRunner(makePage({ '#btn-export': el }));

    const result = runner.run(frame('scroll-to', '#btn-export'));

    expect(result.hit).toBe(true);
    expect(el.highlightCount).toBe(1);
    expect(el.scrollCount).toBe(1);
    expect(result.status).toBe('已为你定位到该元素');
  });

  it('失配降级：不改任何高亮，如实回报降级文案（有 message 用 message）', () => {
    const el = makeTarget();
    const runner = createPageActionRunner(makePage({ '#btn-export': el }));

    const result = runner.run(frame('highlight', '#btn-print', '打印在这里'));

    expect(result.hit).toBe(false);
    expect(el.highlightCount).toBe(0);
    expect(el.unhighlightCount).toBe(0);
    expect(el.scrollCount).toBe(0);
    expect(result.status).toBe('打印在这里');
  });

  it('失配无 message：回报默认降级文案，不假装成功', () => {
    const runner = createPageActionRunner(makePage({}));

    const result = runner.run(frame('highlight', '#missing'));

    expect(result.hit).toBe(false);
    expect(result.status).toBe('未能在当前页面定位到该元素');
  });

  it('重复引导：命中新元素前清除上一次高亮，避免累积', () => {
    const first = makeTarget();
    const second = makeTarget();
    const runner = createPageActionRunner(makePage({ '#a': first, '#b': second }));

    runner.run(frame('highlight', '#a'));
    runner.run(frame('highlight', '#b'));

    expect(first.highlightCount).toBe(1);
    expect(first.unhighlightCount).toBe(1);
    expect(second.highlightCount).toBe(1);
    expect(second.unhighlightCount).toBe(0);
  });

  it('失配不清除已有高亮（上一次定位保持可见）', () => {
    const el = makeTarget();
    const runner = createPageActionRunner(makePage({ '#a': el }));

    runner.run(frame('highlight', '#a'));
    runner.run(frame('highlight', '#missing'));

    expect(el.unhighlightCount).toBe(0);
  });

  it('快照 ref 定位：走 resolveRef 而非选择器，命中即高亮', () => {
    const byRef = makeTarget();
    const runner = createPageActionRunner(createPageActionRunnerPage(byRef));

    const result = runner.run({ type: 'guide-action', sessionId: 's1', action: 'highlight', ref: 'za-7' });

    expect(result.hit).toBe(true);
    expect(byRef.highlightCount).toBe(1);
  });

  it('ref 已作废（快照重建后解引用不到）→ 与选择器未命中同一条降级，不指错元素', () => {
    const other = makeTarget();
    const runner = createPageActionRunner(makePage({ '#a': other }, {}));

    const result = runner.run({ type: 'guide-action', sessionId: 's1', action: 'scroll-to', ref: 'za-9' });

    expect(result.hit).toBe(false);
    expect(result.status).toBe('未能在当前页面定位到该元素');
    expect(other.highlightCount).toBe(0);
    expect(other.scrollCount).toBe(0);
  });

  it('ref 与 selector 同时给出：以 ref 为准（快照实测优先于模型自拟选择器）', () => {
    const byRef = makeTarget();
    const bySelector = makeTarget();
    const runner = createPageActionRunner(makePage({ '#a': bySelector }, { 'za-3': byRef }));

    runner.run({
      type: 'guide-action',
      sessionId: 's1',
      action: 'highlight',
      ref: 'za-3',
      selector: '#a',
    });

    expect(byRef.highlightCount).toBe(1);
    expect(bySelector.highlightCount).toBe(0);
  });
});

function createPageActionRunnerPage(target: TargetSpy): GuidePage {
  return makePage({}, { 'za-7': target });
}
