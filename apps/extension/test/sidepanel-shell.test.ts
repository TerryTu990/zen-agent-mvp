// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { mountSidePanel } from '../src/sidepanel.js';

describe('Side Panel shell', () => {
  it('uses one brand title and exposes the accessible combined composer controls', () => {
    const root = document.createElement('main');
    const elements = mountSidePanel(root);

    expect(root.querySelector('.za-brand h1')?.textContent).toBe('Zen Commerce Agent');
    expect(root.querySelector('.za-brand p')?.textContent).toBe('电商智能体');
    expect(root.textContent).not.toContain('闲鱼电商智能体');
    expect(elements.action.getAttribute('aria-label')).toBe('发送消息');
    expect(elements.upload.getAttribute('aria-label')).toBe('上传知识文档');
  });
});
