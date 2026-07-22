// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { mountSidePanel } from '../src/sidepanel.js';

describe('Side Panel shell', () => {
  it('leaves branding to Chrome and exposes the accessible combined composer controls', () => {
    const root = document.createElement('main');
    const elements = mountSidePanel(root);

    expect(root.querySelector('.za-topbar')).toBeNull();
    expect(root.textContent).not.toContain('电商智能体');
    expect(elements.action.getAttribute('aria-label')).toBe('发送消息');
    expect(elements.upload.getAttribute('aria-label')).toBe('上传知识文档');
  });
});
