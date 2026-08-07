import { describe, expect, it } from 'vitest';
import { runToolbarSidePanelAction } from '../src/side-panel-action.js';

function recorder() {
  const calls: string[] = [];
  const step = (name: string) => () => {
    calls.push(name);
    return Promise.resolve();
  };
  return { calls, step };
}

describe('runToolbarSidePanelAction', () => {
  it('启用先于打开：面板默认禁用，未启用时 open() 点不开（这是"要点两次"的成因）', async () => {
    const { calls, step } = recorder();

    await runToolbarSidePanelAction({
      enablePanel: step('enable'),
      openPanel: step('open'),
      activatePage: step('activate'),
    });

    expect(calls.indexOf('enable')).toBeLessThan(calls.indexOf('open'));
  });

  it('建组不挡在打开前面：activatePage 先发起，open() 不等它完成', async () => {
    const calls: string[] = [];
    let releaseActivate = (): void => {};
    const activating = new Promise<void>((resolve) => {
      releaseActivate = () => {
        calls.push('activate-done');
        resolve();
      };
    });

    const result = runToolbarSidePanelAction({
      enablePanel: () => {
        calls.push('enable');
        return Promise.resolve();
      },
      openPanel: () => {
        calls.push('open');
        return Promise.resolve();
      },
      activatePage: () => {
        calls.push('activate-start');
        return activating;
      },
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toContain('open');
    expect(calls).not.toContain('activate-done');

    releaseActivate();
    await expect(result).resolves.toBeUndefined();
  });

  it('启用失败即不再打开（不在禁用的标签页上空点）', async () => {
    const calls: string[] = [];
    const result = runToolbarSidePanelAction({
      enablePanel: () => Promise.reject(new Error('enable failed')),
      openPanel: () => {
        calls.push('open');
        return Promise.resolve();
      },
      activatePage: () => Promise.resolve(),
    });

    await expect(result).rejects.toThrow('enable failed');
    expect(calls).not.toContain('open');
  });

  it('打开失败时拒绝，由调用方统一报告', async () => {
    const result = runToolbarSidePanelAction({
      enablePanel: () => Promise.resolve(),
      openPanel: () => Promise.reject(new Error('open failed')),
      activatePage: () => Promise.resolve(),
    });

    await expect(result).rejects.toThrow('open failed');
  });
});
