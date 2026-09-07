// @vitest-environment jsdom
/**
 * 配置中心「个人定制」页的快捷提问（R-5）：站点包预置的只可停用（只收紧，改不了别人的模板），
 * 自建条目可增删并整条写回 L2。就地校验与契约同口径：占位符闭集、selection 必含 {{selection}}。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  mountConfigCenter,
  type ConfigCenterDeps,
  type PackView,
  type UserOverlayView,
} from '../src/config-center.js';

const SUBJECT = { tenant: 'anon', hostUserId: 'anon-u1' };

const PACKS: PackView[] = [
  {
    packId: 'shop',
    version: '0.1.0',
    source: 'official',
    origin: 'https://shop.example',
    features: [{ featureId: 'orders' }],
    tools: [],
    quickActions: [
      { id: 'explain-selection', label: '解释选中内容', context: 'selection' },
      { id: 'summarize-page', label: '总结本页', context: 'page' },
    ],
  },
];

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

interface Harness {
  root: HTMLElement;
  deps: ConfigCenterDeps;
  puts: UserOverlayView[];
}

function createHarness(overlay: UserOverlayView | null): Harness {
  const root = document.createElement('main');
  document.body.replaceChildren(root);
  const puts: UserOverlayView[] = [];
  const deps: ConfigCenterDeps = {
    fetch: async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/v1/packs')) return jsonResponse(200, { packs: PACKS });
      if (url.includes('/v1/user-config') && method === 'GET') {
        return jsonResponse(200, { overlay, revision: 'rev-1', subject: SUBJECT });
      }
      if (url.includes('/v1/user-config') && method === 'PUT') {
        puts.push(JSON.parse(String(init?.body)) as UserOverlayView);
        return jsonResponse(200, { revision: 'rev-2' });
      }
      return jsonResponse(404, { error: '未知路由' });
    },
    baseUrl: 'http://127.0.0.1:8787',
    authToken: 'fake-token',
    serverBaseUrl: 'http://127.0.0.1:8787',
    executionPreference: 'auto',
    saveSettings: async () => undefined,
  };
  return { root, deps, puts };
}

function scopeNode(root: HTMLElement, scopeKey: string): HTMLElement {
  const node = root.querySelector<HTMLElement>(`.za-cc-panel[data-za-panel="overlay"] [data-za-scope="${scopeKey}"]`);
  expect(node, `缺少作用域 ${scopeKey}`).not.toBeNull();
  return node!;
}

function formOf(root: HTMLElement, scopeKey: string) {
  const form = scopeNode(root, scopeKey).querySelector<HTMLElement>(`[data-za-quick-action-form="${scopeKey}"]`);
  expect(form).not.toBeNull();
  return {
    label: form!.querySelector<HTMLInputElement>('input[type="text"]')!,
    template: form!.querySelector<HTMLTextAreaElement>('textarea')!,
    context: form!.querySelector<HTMLSelectElement>('select')!,
    add: form!.querySelector<HTMLButtonElement>('[data-za-quick-action-add]')!,
    issue: form!.querySelector<HTMLElement>('.za-cc-quick-action-issue')!,
  };
}

const emptyOverlay: UserOverlayView = { schemaVersion: 1, subject: SUBJECT, packs: {} };

describe('配置中心的快捷提问', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('站点包预置条目逐条列出并标来源；面板不展示其模板（不持第二份副本）', async () => {
    const harness = createHarness(emptyOverlay);
    const handle = mountConfigCenter(harness.root, harness.deps);
    await handle.ready;
    const rows = scopeNode(harness.root, 'shop').querySelectorAll('[data-za-quick-action-id]');
    expect([...rows].map((row) => row.getAttribute('data-za-quick-action-id'))).toEqual([
      'explain-selection',
      'summarize-page',
    ]);
    expect(scopeNode(harness.root, 'shop').textContent).toContain('站点包预置');
    expect(scopeNode(harness.root, 'shop').querySelector('.za-cc-quick-action-template')).toBeNull();
  });

  it('取消勾选即停用：写入该作用域 disabledQuickActions（只收紧，不改模板）', async () => {
    const harness = createHarness(emptyOverlay);
    const handle = mountConfigCenter(harness.root, harness.deps);
    await handle.ready;
    const row = scopeNode(harness.root, 'shop').querySelector<HTMLElement>('[data-za-quick-action-id="summarize-page"]')!;
    const toggle = row.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(toggle.checked).toBe(true);
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    await handle.save();
    expect(harness.puts.at(-1)?.packs['shop']).toMatchObject({ disabledQuickActions: ['summarize-page'] });
  });

  it('重新勾选把两个作用域的停用清单都摘干净（键删空，契约 minItems=1）', async () => {
    const harness = createHarness({
      schemaVersion: 1,
      subject: SUBJECT,
      packs: { '*': { disabledQuickActions: ['summarize-page'] } },
    });
    const handle = mountConfigCenter(harness.root, harness.deps);
    await handle.ready;
    const row = scopeNode(harness.root, 'shop').querySelector<HTMLElement>('[data-za-quick-action-id="summarize-page"]')!;
    const toggle = row.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(toggle.checked).toBe(false);
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    await handle.save();
    expect(harness.puts.at(-1)?.packs['*']?.disabledQuickActions).toBeUndefined();
  });

  it('添加自建条目：整条写进该作用域的 quickActions', async () => {
    const harness = createHarness(emptyOverlay);
    const handle = mountConfigCenter(harness.root, harness.deps);
    await handle.ready;
    const form = formOf(harness.root, '*');
    form.label.value = '挑重点讲';
    form.template.value = '请只讲这页最要紧的三件事。';
    form.context.value = 'page';
    form.add.click();
    await handle.save();
    const written = harness.puts.at(-1)?.packs['*']?.quickActions;
    expect(written).toHaveLength(1);
    expect(written?.[0]).toMatchObject({
      label: '挑重点讲',
      template: '请只讲这页最要紧的三件事。',
      context: 'page',
    });
    expect(written?.[0]?.id).toMatch(/^[a-z][a-z0-9-]{0,63}$/);
  });

  it('闭集外占位符就地拒收，不入草稿', async () => {
    const harness = createHarness(emptyOverlay);
    const handle = mountConfigCenter(harness.root, harness.deps);
    await handle.ready;
    const form = formOf(harness.root, '*');
    form.label.value = '整页搬运';
    form.template.value = '总结：{{page}}';
    form.add.click();
    expect(form.issue.textContent).toContain('{{page}}');
    await handle.save();
    expect(harness.puts.at(-1)?.packs['*']?.quickActions).toBeUndefined();
  });

  it('「用在选中内容上」缺 {{selection}} 就地拒收', async () => {
    const harness = createHarness(emptyOverlay);
    const handle = mountConfigCenter(harness.root, harness.deps);
    await handle.ready;
    const form = formOf(harness.root, '*');
    form.label.value = '讲讲这段';
    form.template.value = '讲讲这段。';
    form.context.value = 'selection';
    form.add.click();
    expect(form.issue.textContent).toContain('{{selection}}');
    await handle.save();
    expect(harness.puts.at(-1)?.packs['*']?.quickActions).toBeUndefined();
  });

  it('删除自建条目：删空即省略该键', async () => {
    const harness = createHarness({
      schemaVersion: 1,
      subject: SUBJECT,
      packs: {
        '*': {
          quickActions: [{ id: 'qa-mine', label: '记一笔', template: '记一笔', context: 'none' }],
        },
      },
    });
    const handle = mountConfigCenter(harness.root, harness.deps);
    await handle.ready;
    scopeNode(harness.root, '*')
      .querySelector<HTMLButtonElement>('[data-za-quick-action-id="qa-mine"] .za-cc-quick-action-delete')!
      .click();
    await handle.save();
    expect(harness.puts.at(-1)?.packs['*']?.quickActions).toBeUndefined();
  });
});
