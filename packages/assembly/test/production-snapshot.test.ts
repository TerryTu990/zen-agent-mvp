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
      snapshotVersion: '1.5.0',
      packId: 'xianyu-seller',
      featureId: 'xianyu-orders',
    });
    // 站点包恒优先于 generic 兜底：闲鱼页面不得被兜底包截胡。
    expect(resolved.generic).not.toBe(true);

    // 站点索引 = registry 中带 site 围栏的 pack；generic-web 无围栏故不入索引。
    // 索引是 site_navigate 的唯一目标闭集——漏登记 pack 在此处即失去跨站可达性。
    const sites = await port.listSites();
    expect(sites.map((site) => site.packId)).toEqual(['xianyu-seller', 'yinxiang']);

    const composed = await port.compose({
      sessionId: 'production-xianyu-orders',
      packId: resolved.packId,
      featureId: resolved.featureId,
    });
    expect(composed.tools.map((tool) => tool.id)).toEqual([
      'xianyu-orders.page-operate', 'xianyu-shipping.execute-intent',
    ]);
  });

  it('印象笔记站点已安装并装配写笔记工具（未登记进 registry 时本例即红）', async () => {
    const resolved = await port.resolveFeature({ url: 'https://app.yinxiang.com/' });
    expect(resolved).toMatchObject({
      snapshotVersion: '1.5.0',
      packId: 'yinxiang',
      featureId: 'yinxiang-note',
    });
    expect(resolved.generic).not.toBe(true);

    const composed = await port.compose({
      sessionId: 'production-yinxiang-note',
      packId: resolved.packId,
      featureId: resolved.featureId,
    });
    expect(composed.tools.map((tool) => tool.id)).toEqual(['yinxiang-note.write-note']);
    expect(composed.tools[0]).toMatchObject({ riskTier: 'hitl', hitlMode: 'per-task' });
  });

  it('印象笔记 origin 围栏不吃同前缀异域名（app.yinxiang.com.* 回落兜底）', async () => {
    const resolved = await port.resolveFeature({ url: 'https://app.yinxiang.com.evil.example/' });
    expect(resolved).toMatchObject({ packId: 'generic-web', generic: true });
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
