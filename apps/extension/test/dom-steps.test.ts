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

    // waitFor 仍属服务端保留、客户端未实现动作：如实失败不硬来。
    const unsupported = await runnerFor({ 'za-1': div }).run([{ action: 'waitFor', ref: 'za-1' }]);
    expect(unsupported).toEqual({ ok: false, error: 'step-1-waitFor:action-not-supported' });
  });

  it('fill 到 contenteditable 编辑区：按换行拆段写入并派发 input（126 正文场景）', async () => {
    document.body.innerHTML = '<div contenteditable="true">旧内容</div>';
    const editor = document.querySelector('div')!;
    const inputEvents: string[] = [];
    editor.addEventListener('input', () => inputEvents.push('input'));

    const outcome = await runnerFor({ 'za-1': editor }).run([
      { action: 'fill', ref: 'za-1', value: '第一行\n\n第三行' },
    ]);

    expect(outcome).toEqual({ ok: true, body: { reads: {}, completedSteps: 1 } });
    expect(inputEvents).toEqual(['input']);
    expect(editor.querySelectorAll('div').length).toBe(3);
    expect(editor.textContent).toBe('第一行第三行');
    // 空行以 <br> 占位保持段落结构。
    expect(editor.querySelectorAll('br').length).toBe(1);
  });

  it('navigate 步：免 ref、委托 navigate 回调、body 回目标 url（ADR-013 批次④）', async () => {
    const navigated: string[] = [];
    const navigate = async (url: string) => {
      navigated.push(url);
      return { ok: true, url };
    };
    const runner = createDomStepRunner(() => null, instantPace, () => false, navigate);
    const outcome = await runner.run([{ action: 'navigate', url: 'https://mail.126.com/' }]);
    expect(navigated).toEqual(['https://mail.126.com/']);
    expect(outcome).toEqual({ ok: true, body: { url: 'https://mail.126.com/' } });
  });

  it('navigate 步：navigate 回调失败如实回报；未注入回调时 navigate-unavailable', async () => {
    const failing = async () => ({ ok: false, error: 'fence-violation' });
    const failed = await createDomStepRunner(() => null, instantPace, () => false, failing).run([
      { action: 'navigate', url: 'https://evil.example/' },
    ]);
    expect(failed).toEqual({ ok: false, error: 'step-1-navigate:fence-violation' });

    const noRunner = await createDomStepRunner(() => null, instantPace).run([
      { action: 'navigate', url: 'https://mail.126.com/' },
    ]);
    expect(noRunner).toEqual({ ok: false, error: 'step-1-navigate:navigate-unavailable' });
  });

  it('同源 iframe 元素：realm 感知使 fill/read 正确作用于子文档控件（iframe 下钻步进）', async () => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const childDoc = frame.contentDocument!;
    // 子 iframe 属独立 realm，其 Element.prototype 与顶层不同——jsdom 无布局引擎，同样打桩 scrollIntoView。
    (childDoc.defaultView as unknown as { Element: typeof Element }).Element.prototype.scrollIntoView = vi.fn();
    childDoc.body.innerHTML = '<input type="text" /><div contenteditable="true">正文占位</div>';
    const childInput = childDoc.querySelector('input')!;
    const childEditor = childDoc.querySelector('[contenteditable]')!;
    const inputEvents: string[] = [];
    childInput.addEventListener('input', () => inputEvents.push('input'));

    const outcome = await runnerFor({ 'f1:za-1': childInput, 'f1:za-2': childEditor }).run([
      { action: 'fill', ref: 'f1:za-1', value: '子文档值' },
      { action: 'read', ref: 'f1:za-2', name: 'body' },
    ]);

    expect(childInput.value).toBe('子文档值');
    expect(inputEvents).toEqual(['input']);
    expect(outcome).toEqual({ ok: true, body: { reads: { body: '正文占位' }, completedSteps: 2 } });
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
