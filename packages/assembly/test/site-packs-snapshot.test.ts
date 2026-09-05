import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAssemblyPort } from '../src/index.js';

const repoRoot = new URL('../../../', import.meta.url).pathname;
const snapshotRoot = join(repoRoot, 'examples/site-packs');
const systemPromptPath = join(repoRoot, 'assets/system-prompt.md');

describe('站点包根 examples/site-packs（已下线站点包保持可装配）', () => {
  const port = createAssemblyPort({ snapshotRoot, systemPromptPath });

  it('闲鱼站点包真实装配订单页工具', async () => {
    const resolved = await port.resolveFeature({
      url: 'https://seller.goofish.com/?site=COMMONPRO#/seller-trade/order-manage',
    });
    expect(resolved).toMatchObject({
      snapshotVersion: '1.0.0',
      packId: 'xianyu-seller',
      featureId: 'xianyu-orders',
    });
    expect(resolved.generic).not.toBe(true);

    // 站点索引 = registry 中带 site 围栏的 pack，是 site_navigate 的唯一目标闭集。
    const sites = await port.listSites();
    expect(sites.map((site) => site.packId)).toEqual(['xianyu-seller', 'yinxiang']);

    const composed = await port.compose({
      sessionId: 'site-packs-xianyu-orders',
      packId: resolved.packId,
      featureId: resolved.featureId,
    });
    expect(composed.tools.map((tool) => tool.id)).toEqual(['xianyu-orders.page-operate']);
  });

  it('印象笔记站点包装配写笔记工具（未登记进 registry 时本例即红）', async () => {
    const resolved = await port.resolveFeature({ url: 'https://app.yinxiang.com/' });
    expect(resolved).toMatchObject({
      snapshotVersion: '1.0.0',
      packId: 'yinxiang',
      featureId: 'yinxiang-note',
    });
    expect(resolved.generic).not.toBe(true);

    const composed = await port.compose({
      sessionId: 'site-packs-yinxiang-note',
      packId: resolved.packId,
      featureId: resolved.featureId,
    });
    expect(composed.tools.map((tool) => tool.id)).toEqual(['yinxiang-note.write-note']);
    expect(composed.tools[0]).toMatchObject({ riskTier: 'hitl', hitlMode: 'per-task' });
  });

  it('印象笔记 origin 围栏不吃同前缀异域名（app.yinxiang.com.* 回落）', async () => {
    const resolved = await port.resolveFeature({ url: 'https://app.yinxiang.com.evil.example/' });
    expect(resolved).not.toMatchObject({ packId: 'yinxiang' });
  });
});
