/**
 * `storage.onChanged` 的分支互不排斥：background 的 L2 刷新（`refreshAutomationDescriptors`）以**一次**
 * `storage.local.set` 同写授权集与站点黑名单两个镜像键，两键因此会同批到达。任一键的处置若吞掉同批的另一键，
 * 保存后的对齐就只做了一半——注册面对上了，服务端手里的旧组页面清单却仍留着已拉黑站点的 url/title。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { sessionKeyForGroup, zenGroupKey } from '../src/activation.js';
import { contentScriptIdForOrigin, GRANTED_ORIGINS_KEY, originMatchPattern } from '../src/injection.js';
import { SITE_DENYLIST_KEY } from '../src/site-denylist.js';
import {
  BASE_URL,
  disposeHarnesses,
  loadBackground,
  SESSION_ID,
  settle,
  type FakeTab,
  type Served,
  type ServedRequest,
} from './support/background-harness.js';

const GROUP_ID = 7;
const WORK_ORIGIN = 'https://shop.example';
const BANK_ORIGIN = 'https://bank.example';
const memberTab: FakeTab = { id: 12, url: `${WORK_ORIGIN}/orders`, title: '订单', groupId: GROUP_ID, windowId: 1 };
const mappedGroup: Record<string, unknown> = {
  [sessionKeyForGroup(GROUP_ID)]: SESSION_ID,
  [zenGroupKey(GROUP_ID)]: true,
};

/** 冷启动拉取一律回空：两个镜像键的初值因此为空，用例自己写入后再宣告变更。 */
function serve(request: ServedRequest): Served | null {
  if (request.url === `${BASE_URL}/v1/user-config`) {
    return { status: 200, body: { overlay: { schemaVersion: 1, packs: {} }, revision: 'rev-1' } };
  }
  if (request.url === `${BASE_URL}/v1/automation-descriptors`) return { status: 200, body: { descriptors: [] } };
  return null;
}

/** 组页面清单上报走 300ms 尾沿防抖：跨过它才能判「这一批变更有没有引出重报」。 */
const afterDebounce = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 400));

afterEach(disposeHarnesses);

describe('两个镜像键同批变更', () => {
  it('授权集与黑名单一起变：注册面对齐之外，组页面清单照样重报', async () => {
    const h = await loadBackground({
      tabs: [memberTab],
      storageSession: { ...mappedGroup },
      grantedOrigins: [originMatchPattern(WORK_ORIGIN)],
      serve,
    });
    h.connectContent(memberTab);
    await afterDebounce();
    await settle();
    const mark = h.upstream().length;

    h.local[GRANTED_ORIGINS_KEY] = [WORK_ORIGIN];
    h.local[SITE_DENYLIST_KEY] = [BANK_ORIGIN];
    h.emitStorageChanged({
      [GRANTED_ORIGINS_KEY]: { oldValue: [], newValue: [WORK_ORIGIN] },
      [SITE_DENYLIST_KEY]: { oldValue: [], newValue: [BANK_ORIGIN] },
    });
    await afterDebounce();
    await settle();

    expect(h.registrations.map((item) => item.id)).toEqual([contentScriptIdForOrigin(WORK_ORIGIN)]);
    expect(
      h.upstream().slice(mark).filter((frame) => frame.type === 'group-pages'),
      '黑名单变更的重报不得被同批的授权集变更吞掉',
    ).not.toEqual([]);
  });
});
