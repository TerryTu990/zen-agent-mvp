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
  it('启用先于打开，且两者同步发出：中间若 await，用户手势失效、面板彻底打不开', () => {
    const { calls, step } = recorder();

    // 不 await：调用返回时两条请求必须都已发出（手势仍在）。
    void runToolbarSidePanelAction({
      enablePanel: step('enable'),
      openPanel: step('open'),
      activatePage: step('activate'),
    });

    expect(calls).toEqual(['enable', 'open', 'activate']);
  });

  it('建组不挡在打开前面：open() 不等 activatePage 完成', async () => {
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

    expect(calls).toContain('open');
    expect(calls).not.toContain('activate-done');

    releaseActivate();
    await expect(result).resolves.toBeUndefined();
  });

  it('启用失败仍照常发出打开：短路需要 await，而 await 会让手势失效', async () => {
    const calls: string[] = [];
    const result = runToolbarSidePanelAction({
      enablePanel: () => Promise.reject(new Error('enable failed')),
      openPanel: () => {
        calls.push('open');
        return Promise.resolve();
      },
      activatePage: () => Promise.resolve(),
    });

    // 有意取舍：宁可在已启用的标签页上多发一次 open，也不能为省这一次而牺牲手势。
    expect(calls).toContain('open');
    await expect(result).rejects.toThrow('enable failed');
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
