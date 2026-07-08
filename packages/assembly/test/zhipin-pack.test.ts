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

  it('resume 工具面 = 只读采集(auto) + 改简历红线(forbidden)', async () => {
    expect(await toolIds(port, 'resume')).toEqual(['resume.modify-resume', 'resume.page-operate']);
  });

  it('job-search 工具面 = page-operate + greet + query-jobs(http)', async () => {
    expect(await toolIds(port, 'job-search')).toEqual([
      'job-search.greet',
      'job-search.page-operate',
      'job-search.query-jobs',
    ]);
  });

  it('job-detail 工具面 = 五工具（含 server 薪资/every-call 投递/forbidden 接offer）', async () => {
    expect(await toolIds(port, 'job-detail')).toEqual([
      'job-detail.auto-accept-offer',
      'job-detail.formal-apply',
      'job-detail.greet',
      'job-detail.page-operate',
      'job-detail.salary-benchmark',
    ]);
  });

  it('resume.page-operate = auto 分级（只读采集免授权）', async () => {
    const composed = await port.compose({ sessionId: 's1', packId: 'zhipin', featureId: 'resume' });
    const t = composed.tools.find((x) => x.id === 'resume.page-operate');
    expect(t?.riskTier).toBe('auto');
  });

  it('forbidden 工具确实注入工具面（agent 看得到但服务端永拒）', async () => {
    const resume = await port.compose({ sessionId: 's1', packId: 'zhipin', featureId: 'resume' });
    expect(resume.tools.find((x) => x.id === 'resume.modify-resume')?.riskTier).toBe('forbidden');
    const detail = await port.compose({ sessionId: 's1', packId: 'zhipin', featureId: 'job-detail' });
    expect(detail.tools.find((x) => x.id === 'job-detail.auto-accept-offer')?.riskTier).toBe('forbidden');
  });

  it('greet = client/dom + hitl + per-task（首批授权后自动放行）', async () => {
    const composed = await port.compose({ sessionId: 's1', packId: 'zhipin', featureId: 'job-search' });
    const greet = composed.tools.find((tool) => tool.id === 'job-search.greet');
    expect(greet?.execution).toBe('client');
    expect(greet?.riskTier).toBe('hitl');
    expect(greet?.hitlMode).toBe('per-task');
    expect(greet?.adapter).toMatchObject({ kind: 'dom' });
  });

  it('formal-apply = every-call（正式投递逐次单独确认，区别于 greet）', async () => {
    const composed = await port.compose({ sessionId: 's1', packId: 'zhipin', featureId: 'job-detail' });
    const apply = composed.tools.find((x) => x.id === 'job-detail.formal-apply');
    expect(apply?.riskTier).toBe('hitl');
    expect(apply?.hitlMode).toBe('every-call');
  });

  it('salary-benchmark = server 通道 + credentialRef（凭证运行时注入）', async () => {
    const composed = await port.compose({ sessionId: 's1', packId: 'zhipin', featureId: 'job-detail' });
    const sb = composed.tools.find((x) => x.id === 'job-detail.salary-benchmark');
    expect(sb?.execution).toBe('server');
    expect(sb?.adapter).toMatchObject({ credentialRef: 'zhipinSalaryKey' });
  });

  it('query-jobs = client-http 通道（无 kind，只读 auto）', async () => {
    const composed = await port.compose({ sessionId: 's1', packId: 'zhipin', featureId: 'job-search' });
    const q = composed.tools.find((x) => x.id === 'job-search.query-jobs');
    expect(q?.execution).toBe('client');
    expect(q?.riskTier).toBe('auto');
    expect(q?.adapter).not.toHaveProperty('kind');
    expect(q?.adapter).toMatchObject({ method: 'GET' });
  });

  it('skills 注入：jd-match / greeting / application-log 三个 skill（pack 级常驻）', async () => {
    const composed = await port.compose({ sessionId: 's1', packId: 'zhipin', featureId: 'job-search' });
    const ids = composed.skills.map((s) => s.id).sort();
    expect(ids).toEqual(['application-log', 'greeting', 'jd-match']);
    expect(composed.skills.find((s) => s.id === 'jd-match')?.content.length).toBeGreaterThan(0);
  });

  it('docs 注入：profile / job-hunting-faq 进 docsIndex（渐进披露，pack_doc 按需读）', async () => {
    const composed = await port.compose({ sessionId: 's1', packId: 'zhipin', featureId: 'resume' });
    expect(composed.docsIndex).not.toBeNull();
    expect(composed.docsIndex).toContain('profile.md');
    expect(composed.docsIndex).toContain('job-hunting-faq.md');
  });

  it('pack_doc 可读 profile.md 正文（围栏内、路径安全）', async () => {
    const doc = await port.readPackDoc({ packId: 'zhipin', docPath: 'profile.md' });
    expect(doc.ok).toBe(true);
    expect((doc.content ?? '').length).toBeGreaterThan(0);
    const escape = await port.readPackDoc({ packId: 'zhipin', docPath: '../../pack.json' });
    expect(escape.ok).toBe(false);
  });

  it('site_navigate 注入前提成立：sitesIndex 非空（≥2 个 site pack），打招呼后可回列表续作', async () => {
    for (const featureId of ['job-search', 'job-detail']) {
      const composed = await port.compose({ sessionId: 's1', packId: 'zhipin', featureId });
      expect(composed.sitesIndex).not.toBeNull();
    }
  });
});
