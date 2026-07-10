import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAssemblyPort } from '../src/index.js';

const repoRoot = new URL('../../../', import.meta.url).pathname;
const acceptanceRoot = join(repoRoot, 'examples/acceptance');
const systemPromptPath = join(repoRoot, 'assets/system-prompt.md');

function acceptancePort() {
  return createAssemblyPort({ snapshotRoot: acceptanceRoot, systemPromptPath });
}

describe('generic-web pack 装配（examples/acceptance registry，通用站点兜底）', () => {
  const port = acceptancePort();

  it('未装 pack 的 origin → 回落 generic-web/browse（generic:true）', async () => {
    const result = await port.resolveFeature({ url: 'http://127.0.0.1:4173/order-list.html' });
    expect(result.packId).toBe('generic-web');
    expect(result.featureId).toBe('browse');
    expect(result.generic).toBe(true);
  });

  it('zhipin URL 命中不受 generic 影响（站点 pack 永远优先）', async () => {
    const result = await port.resolveFeature({ url: 'https://www.zhipin.com/web/geek/job?query=x' });
    expect(result.packId).toBe('zhipin');
    expect(result.featureId).toBe('job-search');
    expect(result).not.toHaveProperty('generic');
  });

  it('listSites 不含 generic-web（不进站点索引与导航目标）', async () => {
    const sites = await port.listSites();
    expect(sites.map((s) => s.packId)).not.toContain('generic-web');
  });

  it('browse 工具面 = 仅 browse.page-operate（client/dom + hitl every-call）', async () => {
    const composed = await port.compose({ sessionId: 's1', packId: 'generic-web', featureId: 'browse' });
    expect(composed.tools.map((t) => t.id)).toEqual(['browse.page-operate']);
    const op = composed.tools[0]!;
    expect(op.riskTier).toBe('hitl');
    expect(op.hitlMode).toBe('every-call');
    expect(op.execution).toBe('client');
    expect(op.adapter).toMatchObject({ kind: 'dom', pathPrefixes: ['/'] });
  });
});
