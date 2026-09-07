import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAssemblyPort } from '../src/index.js';

const repoRoot = new URL('../../../', import.meta.url).pathname;
const snapshotRoot = join(repoRoot, 'assets');
const systemPromptPath = join(snapshotRoot, 'system-prompt.md');

describe('生产快照（仅通用包）', () => {
  const port = createAssemblyPort({ snapshotRoot, systemPromptPath });

  it('registry 只登记 generic-web：任意 http 页面解析为兜底包，站点索引为空', async () => {
    const resolved = await port.resolveFeature({ url: 'https://example.com/orders' });
    expect(resolved).toMatchObject({
      snapshotVersion: '2.4.0',
      packId: 'generic-web',
      featureId: 'browse',
      generic: true,
    });

    // 站点索引 = registry 中带 site 围栏的 pack；generic-web 无围栏，故生产快照无任何可索引站点。
    expect(await port.listSites()).toEqual([]);

    // 装配引擎只负责解析出兜底包；准入是网关 gateGeneric 的职责（U7 服务端 fail-closed），
    // 名单未命中时网关把三元组打回 null——故此处不能断言"任意站点即得工具面"。
    const composed = await port.compose({
      sessionId: 'production-generic',
      packId: resolved.packId,
      featureId: resolved.featureId,
    });
    expect(composed.tools.map((tool) => tool.id)).toEqual(['browse.page-operate']);
    expect(composed.tools.every((tool) => tool.riskTier === 'hitl')).toBe(true);
  });

  it('已下线站点的页面不再命中站点包（回落兜底）', async () => {
    for (const url of [
      'https://seller.goofish.com/?site=COMMONPRO#/seller-trade/order-manage',
      'https://app.yinxiang.com/',
    ]) {
      const resolved = await port.resolveFeature({ url });
      expect(resolved).toMatchObject({ packId: 'generic-web', generic: true });
    }
  });

  it('准入被网关打回时（packId=null）仍只装配稳定基座、零工具面', async () => {
    const composed = await port.compose({
      sessionId: 'production-unknown',
      packId: null,
      featureId: null,
    });
    expect(composed.tools).toEqual([]);
  });
});
