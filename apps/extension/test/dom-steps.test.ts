// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDomStepRunner } from '../src/dom-steps.js';

// pace 置零：测试不等节奏动画。
const instantPace = () => Promise.resolve();

function runnerFor(refs: Record<string, Element | null>) {
  return createDomStepRunner((ref) => refs[ref] ?? null, instantPace);
}

beforeEach(() => {
  document.body.innerHTML = '';
  // jsdom 无布局引擎、不实现 scrollIntoView；真浏览器原生支持，仅测试打桩。
  Element.prototype.scrollIntoView = vi.fn();
});

describe('createDomStepRunner：闭集步骤解释执行', () => {
  it('click + fill + read 全链路：填值触发 input/change，read 按 name 键采集', async () => {
    document.body.innerHTML = '<button>建</button><input type="text" /><span class="key">tok-9f</span>';
    const button = document.querySelector('button')!;
    const input = document.querySelector('input')!;
    const clicked = vi.fn();
    const inputEvents: string[] = [];
    button.addEventListener('click', clicked);
    input.addEventListener('input', () => inputEvents.push('input'));
    input.addEventListener('change', () => inputEvents.push('change'));

    const outcome = await runnerFor({
      'za-1': button,
      'za-2': input,
      'za-3': document.querySelector('.key'),
    }).run([
      { action: 'fill', ref: 'za-2', value: 'my-key' },
      { action: 'click', ref: 'za-1' },
      { action: 'read', ref: 'za-3', name: 'tokenKey' },
    ]);

    expect(clicked).toHaveBeenCalledOnce();
    expect(input.value).toBe('my-key');
    expect(inputEvents).toEqual(['input', 'change']);
    expect(outcome).toEqual({ ok: true, body: { reads: { tokenKey: 'tok-9f' }, completedSteps: 3 } });
  });

  it('ref 未命中：立即中止、如实失败、后续步骤不执行（HOW-05）', async () => {
    document.body.innerHTML = '<button>后续</button>';
    const later = document.querySelector('button')!;
    const clicked = vi.fn();
    later.addEventListener('click', clicked);

    const outcome = await runnerFor({ 'za-9': later }).run([
      { action: 'click', ref: 'za-1' },
      { action: 'click', ref: 'za-9' },
    ]);

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe('step-1-click:ref-not-found');
    expect(clicked).not.toHaveBeenCalled();
  });

  it('fill 到不可填元素 / 服务端闭集外动作：如实失败不硬来', async () => {
    document.body.innerHTML = '<div>纯文本</div>';
    const div = document.querySelector('div')!;

    const notFillable = await runnerFor({ 'za-1': div }).run([
      { action: 'fill', ref: 'za-1', value: 'x' },
    ]);
    expect(notFillable).toEqual({ ok: false, error: 'step-1-fill:not-fillable' });

    const unsupported = await runnerFor({ 'za-1': div }).run([{ action: 'navigate', ref: 'za-1' }]);
    expect(unsupported).toEqual({ ok: false, error: 'step-1-navigate:action-not-supported' });
  });

  it('select 设值并派发 change；read 无 name 时回退 ref 作键', async () => {
    document.body.innerHTML = `
      <select><option value="a">A</option><option value="b">B</option></select>
    `;
    const select = document.querySelector('select')!;
    const changed = vi.fn();
    select.addEventListener('change', changed);

    const outcome = await runnerFor({ 'za-1': select }).run([
      { action: 'select', ref: 'za-1', value: 'b' },
      { action: 'read', ref: 'za-1' },
    ]);

    expect(select.value).toBe('b');
    expect(changed).toHaveBeenCalledOnce();
    expect(outcome.body).toEqual({ reads: { 'za-1': 'b' }, completedSteps: 2 });
  });
});
