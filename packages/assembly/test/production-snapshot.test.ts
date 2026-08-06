import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAssemblyPort } from '../src/index.js';

const repoRoot = new URL('../../../', import.meta.url).pathname;
const snapshotRoot = join(repoRoot, 'assets');
const systemPromptPath = join(snapshotRoot, 'system-prompt.md');

describe('Zen Commerce Agent 生产快照', () => {
  const port = createAssemblyPort({ snapshotRoot, systemPromptPath });

  it('只安装闲鱼站点包并真实装配订单页工具', async () => {
    const resolved = await port.resolveFeature({
      url: 'https://seller.goofish.com/?site=COMMONPRO#/seller-trade/order-manage',
    });
    expect(resolved).toMatchObject({
      snapshotVersion: '1.4.0',
      packId: 'xianyu-seller',
      featureId: 'xianyu-orders',
    });
    // 站点包恒优先于 generic 兜底：闲鱼页面不得被兜底包截胡。
    expect(resolved.generic).not.toBe(true);

    // generic-web 无 site 围栏，不进站点索引——站点索引仍只有闲鱼一家。
    const sites = await port.listSites();
    expect(sites.map((site) => site.packId)).toEqual(['xianyu-seller']);

    const composed = await port.compose({
      sessionId: 'production-xianyu-orders',
      packId: resolved.packId,
      featureId: resolved.featureId,
    });
    expect(composed.tools.map((tool) => tool.id)).toEqual([
      'xianyu-orders.page-operate', 'xianyu-shipping.execute-intent',
    ]);
  });

  it('非闲鱼页面回落 generic 兜底包（服务端仍按准入名单裁决是否真激活）', async () => {
    const resolved = await port.resolveFeature({ url: 'https://example.com/orders' });
    expect(resolved).toMatchObject({
      packId: 'generic-web',
      featureId: 'browse',
      generic: true,
    });

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

  it('准入被网关打回时（packId=null）仍只装配稳定基座、零工具面', async () => {
    const composed = await port.compose({
      sessionId: 'production-unknown',
      packId: null,
      featureId: null,
    });
    expect(composed.tools).toEqual([]);
  });
});
