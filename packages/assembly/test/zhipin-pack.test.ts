import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAssemblyPort } from '../src/index.js';

const repoRoot = new URL('../../../', import.meta.url).pathname;
const acceptanceRoot = join(repoRoot, 'examples/acceptance');
const systemPromptPath = join(repoRoot, 'assets/system-prompt.md');

function zhipinPort() {
  return createAssemblyPort({ snapshotRoot: acceptanceRoot, systemPromptPath });
}

async function toolIds(port: ReturnType<typeof zhipinPort>, featureId: string): Promise<string[]> {
  const composed = await port.compose({ sessionId: 's1', packId: 'zhipin', featureId });
  return composed.tools.map((tool) => tool.id).sort();
}

describe('zhipin pack 装配（examples/acceptance registry，阶段A 找工作）', () => {
  const port = zhipinPort();

  it.each([
    ['https://www.zhipin.com/web/geek/resume', 'resume'],
    ['https://www.zhipin.com/web/geek/job?query=x', 'job-search'],
    ['https://www.zhipin.com/job_detail/a1b2c3d4.html', 'job-detail'],
  ])('%s 命中 zhipin pack 与对应 featureId', async (url, featureId) => {
    const result = await port.resolveFeature({ url });
    expect(result.packId).toBe('zhipin');
    expect(result.featureId).toBe(featureId);
  });

  it('沟通页 /web/geek/chat 在围栏内但无 featureIdRule → pack 激活、featureId null（阶段B 不接管）', async () => {
    const result = await port.resolveFeature({ url: 'https://www.zhipin.com/web/geek/chat' });
    expect(result.packId).toBe('zhipin');
    expect(result.featureId).toBeNull();
  });

  it('围栏外路径 /web/user → pack 不激活（fail-safe 仅装配基座）', async () => {
    const result = await port.resolveFeature({ url: 'https://www.zhipin.com/web/user/index' });
    expect(result.packId).toBeNull();
    expect(result.featureId).toBeNull();
  });

  it('resume 工具面 = 仅只读采集画像', async () => {
    expect(await toolIds(port, 'resume')).toEqual(['resume.page-operate']);
  });

  it('job-search 工具面 = page-operate + greet（列表打招呼）', async () => {
    expect(await toolIds(port, 'job-search')).toEqual([
      'job-search.greet',
      'job-search.page-operate',
    ]);
  });

  it('job-detail 工具面 = page-operate + greet（详情打招呼）', async () => {
    expect(await toolIds(port, 'job-detail')).toEqual([
      'job-detail.greet',
      'job-detail.page-operate',
    ]);
  });

  it('greet 是对外动作：client/dom 通道 + hitl + per-task 授权（首批授权后自动放行）', async () => {
    const composed = await port.compose({ sessionId: 's1', packId: 'zhipin', featureId: 'job-search' });
    const greet = composed.tools.find((tool) => tool.id === 'job-search.greet');
    expect(greet).toBeDefined();
    expect(greet?.execution).toBe('client');
    expect(greet?.riskTier).toBe('hitl');
    expect(greet?.hitlMode).toBe('per-task');
    expect(greet?.adapter).toMatchObject({ kind: 'dom' });
  });

  it('site_navigate 注入前提成立：sitesIndex 非空（≥2 个 site pack），打招呼后可回列表续作', async () => {
    for (const featureId of ['job-search', 'job-detail']) {
      const composed = await port.compose({ sessionId: 's1', packId: 'zhipin', featureId });
      expect(composed.sitesIndex).not.toBeNull();
    }
  });
});
