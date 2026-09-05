/**
 * 组页面清单上报的宿主健壮性：300ms 尾沿防抖到期时，宿主对象可能已经不在——
 * SW 被回收后定时器仍会到期，而它捕获的 chrome/fetch 早已失效。
 * 采集失败必须止于本帧：不产生未处理拒绝，也不影响下一次触发。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionKeyForGroup, zenGroupKey } from '../src/activation.js';
import { disposeHarnesses, loadBackground, SESSION_ID, settle, type FakeTab } from './support/background-harness.js';

const GROUP_ID = 7;
const memberTab: FakeTab = { id: 12, url: 'https://shop.example/orders', title: '订单', groupId: GROUP_ID, windowId: 1 };
const mappedGroup: Record<string, unknown> = {
  [sessionKeyForGroup(GROUP_ID)]: SESSION_ID,
  [zenGroupKey(GROUP_ID)]: true,
};

afterEach(disposeHarnesses);

describe('组页面清单上报', () => {
  it('防抖到期时宿主已失效：采集失败止于本帧，不产生未处理拒绝', async () => {
    const h = await loadBackground({ tabs: [memberTab], storageSession: mappedGroup });
    h.connectContent(memberTab);
    await settle();

    const rejections: unknown[] = [];
    const record = (reason: unknown): void => void rejections.push(reason);
    process.on('unhandledRejection', record);
    try {
      // 撤掉宿主替身而不取消已排期的防抖：到期回调将撞上不存在的 chrome，与 SW 回收后同形态。
      vi.unstubAllGlobals();
      await new Promise((resolve) => setTimeout(resolve, 400));
    } finally {
      process.off('unhandledRejection', record);
    }

    expect(rejections).toEqual([]);
  });
});
