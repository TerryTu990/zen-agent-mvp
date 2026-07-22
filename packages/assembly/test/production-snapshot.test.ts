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
      snapshotVersion: '1.1.0',
      packId: 'xianyu-seller',
      featureId: 'xianyu-orders',
    });

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

  it('非闲鱼页面只装配稳定基座', async () => {
    const resolved = await port.resolveFeature({ url: 'https://example.com/orders' });
    expect(resolved).toMatchObject({ packId: null, featureId: null });

    const composed = await port.compose({
      sessionId: 'production-unknown',
      packId: null,
      featureId: null,
    });
    expect(composed.tools).toEqual([]);
  });
});
