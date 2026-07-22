import { describe, expect, it, vi } from 'vitest';
import { runToolbarSidePanelAction } from '../src/side-panel-action.js';

describe('runToolbarSidePanelAction', () => {
  it('在任何异步激活前同步请求打开 Side Panel', async () => {
    const calls: string[] = [];
    const result = runToolbarSidePanelAction({
      openPanel: vi.fn(() => {
        calls.push('open');
        return Promise.resolve();
      }),
      activatePage: vi.fn(() => {
        calls.push('activate');
        return Promise.resolve();
      }),
    });

    expect(calls).toEqual(['open', 'activate']);
    await expect(result).resolves.toBeUndefined();
  });

  it('打开或激活失败时拒绝，由调用方统一报告', async () => {
    const result = runToolbarSidePanelAction({
      openPanel: () => Promise.reject(new Error('open failed')),
      activatePage: () => Promise.resolve(),
    });

    await expect(result).rejects.toThrow('open failed');
  });
});
