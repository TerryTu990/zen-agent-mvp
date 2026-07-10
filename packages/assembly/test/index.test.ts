import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createAssemblyPort } from '../src/index.js';

const fixturesDir = new URL('./fixtures/', import.meta.url).pathname;
const repoRoot = new URL('../../../', import.meta.url).pathname;
const demoSnapshotRoot = join(repoRoot, 'examples/host-demo/config');
const demoFeaturesDir = join(demoSnapshotRoot, 'packs/host-demo/features');
const baseSystemPromptPath = join(repoRoot, 'assets/system-prompt.md');
const fixturePromptPath = join(fixturesDir, 'base-prompt.md');

function demoPort() {
  return createAssemblyPort({
    snapshotRoot: demoSnapshotRoot,
    systemPromptPath: baseSystemPromptPath,
  });
}

function fixturePort(name: string) {
  return createAssemblyPort({
    snapshotRoot: join(fixturesDir, name),
    systemPromptPath: fixturePromptPath,
  });
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

describe('resolveFeature（examples/host-demo registry 快照）', () => {
  const port = demoPort();

  it('order-list.html 命中 host-demo pack + order-list，回写 pack 与快照版本', async () => {
    await expect(
      port.resolveFeature({ url: 'http://127.0.0.1:4173/order-list.html' }),
    ).resolves.toEqual({
      packId: 'host-demo',
      packVersion: '0.2.0',
      featureId: 'order-list',
      snapshotVersion: '0.2.0',
    });
  });

  it('order-detail.html?orderId=... 命中 order-detail', async () => {
    const result = await port.resolveFeature({
      url: 'http://127.0.0.1:4173/order-detail.html?orderId=ORD-1001',
    });
    expect(result.packId).toBe('host-demo');
    expect(result.featureId).toBe('order-detail');
  });

  it('pack 命中但无规则命中 → featureId=null（fail-safe），pack 仍激活', async () => {
    const result = await port.resolveFeature({ url: 'http://127.0.0.1:4173/index.html' });
    expect(result.packId).toBe('host-demo');
    expect(result.featureId).toBeNull();
    expect(result.snapshotVersion).toBe('0.2.0');
  });

  it('origin 不匹配任何 pack → packId=null 仅基座', async () => {
    const result = await port.resolveFeature({ url: 'http://other.example:9999/order-list.html' });
    expect(result.packId).toBeNull();
    expect(result.packVersion).toBeNull();
    expect(result.featureId).toBeNull();
    expect(result.snapshotVersion).toBe('0.2.0');
  });
});

describe('resolveFeature（fixture：规则有序首中）', () => {
  it('更具体的前置规则先命中', async () => {
    const port = fixturePort('valid');
    const special = await port.resolveFeature({ url: 'http://host/alpha/special/page' });
    expect(special.featureId).toBe('beta');
    const plain = await port.resolveFeature({ url: 'http://host/alpha/list' });
    expect(plain.featureId).toBe('alpha');
  });
});

describe('compose（examples/host-demo 真实快照）', () => {
  const port = demoPort();

  it('order-list：基座逐字一致 + 功能块 + 工具白名单', async () => {
    const result = await port.compose({ sessionId: 's1', packId: 'host-demo', featureId: 'order-list' });
    expect(result.snapshotVersion).toBe('0.2.0');
    expect(result.packId).toBe('host-demo');
    expect(result.packVersion).toBe('0.2.0');
    expect(result.docsIndex).toBeNull();
    // 单 site pack（host-demo 仅一个带 site 的 pack）→ 无跨站发现意义，不注入站点索引。
    expect(result.sitesIndex).toBeNull();
    expect(result.systemPrompt).toBe(readFileSync(baseSystemPromptPath, 'utf8'));
    expect(result.featureRules).toBe(
      readFileSync(join(demoFeaturesDir, 'order-list/feature.md'), 'utf8'),
    );
    expect(result.facts).toBe(
      readFileSync(join(demoFeaturesDir, 'order-list/facts.md'), 'utf8'),
    );
    expect(result.tools.map((t) => t.id)).toEqual([
      'order-list.cancel-order',
      'order-list.refresh-orders',
      'order-list.purge-orders',
      'order-list.page-operate',
    ]);
    expect(result.skills).toEqual([]);
  });

  it('order-detail：换出块随功能切换，工具面为空', async () => {
    const result = await port.compose({ sessionId: 's1', packId: 'host-demo', featureId: 'order-detail' });
    expect(result.featureRules).toContain('订单详情');
    expect(result.facts).toContain('#order-id');
    expect(result.facts).not.toContain('#order-table');
    expect(result.tools).toEqual([]);
  });

  it('featureId=null：pack 激活但无功能块，工具为空', async () => {
    const result = await port.compose({ sessionId: 's1', packId: 'host-demo', featureId: null });
    expect(result.systemPrompt).toBe(readFileSync(baseSystemPromptPath, 'utf8'));
    expect(result.featureRules).toBeNull();
    expect(result.facts).toBeNull();
    expect(result.tools).toEqual([]);
  });

  it('packId=null：仅稳定基座', async () => {
    const result = await port.compose({ sessionId: 's1', packId: null, featureId: null });
    expect(result.systemPrompt).toBe(readFileSync(baseSystemPromptPath, 'utf8'));
    expect(result.featureRules).toBeNull();
    expect(result.skills).toEqual([]);
    expect(result.tools).toEqual([]);
    expect(result.docsIndex).toBeNull();
  });

  it('pack 内不存在的 featureId → fail-closed 拒绝', async () => {
    await expect(
      port.compose({ sessionId: 's1', packId: 'host-demo', featureId: 'ghost' }),
    ).rejects.toThrow(/ghost/);
  });
});

describe('compose（fixture：skills 与工具过滤）', () => {
  it('skills/*/SKILL.md 全量载入并按 id 排序', async () => {
    const port = fixturePort('valid');
    const result = await port.compose({ sessionId: 's1', packId: 'default', featureId: 'alpha' });
    expect(result.skills).toEqual([
      { id: 'aid', content: 'AID-SKILL 内容\n' },
      { id: 'greet', content: 'GREET-SKILL 内容\n' },
    ]);
  });

  it('工具按 featureIds 挂载过滤（未挂载当前功能的不可见）', async () => {
    const port = fixturePort('valid');
    const result = await port.compose({ sessionId: 's1', packId: 'default', featureId: 'alpha' });
    expect(result.tools.map((t) => t.id)).toEqual(['alpha.do']);
  });

  it('legacy 快照（无 site 围栏）→ 不注入站点索引', async () => {
    const port = fixturePort('valid');
    const result = await port.compose({ sessionId: 's1', packId: 'default', featureId: 'alpha' });
    expect(result.sitesIndex).toBeNull();
  });

  it('返回值可被调用方安全变更，缓存快照不受影响（U4）', async () => {
    const port = fixturePort('valid');
    const first = await port.compose({ sessionId: 's1', packId: 'default', featureId: 'alpha' });
    first.tools.pop();
    first.skills[0]!.content = 'MUTATED';
    const second = await port.compose({ sessionId: 's2', packId: 'default', featureId: 'alpha' });
    expect(second.tools.map((t) => t.id)).toEqual(['alpha.do']);
    expect(second.skills[0]!.content).toBe('AID-SKILL 内容\n');
  });
});

describe('describeInjection（与 compose 同源投影）', () => {
  it('demo order-list：blocks 字节数与 toolIds 正确', async () => {
    const port = demoPort();
    const description = await port.describeInjection({
      sessionId: 's1',
      packId: 'host-demo',
      featureId: 'order-list',
    });
    expect(description.snapshotVersion).toBe('0.2.0');
    expect(description.packId).toBe('host-demo');
    expect(description.featureId).toBe('order-list');
    expect(description.blocks).toEqual([
      { kind: 'system-prompt', bytes: utf8Bytes(readFileSync(baseSystemPromptPath, 'utf8')) },
      {
        kind: 'feature-rules',
        bytes: utf8Bytes(
          readFileSync(join(demoFeaturesDir, 'order-list/feature.md'), 'utf8'),
        ),
      },
      {
        kind: 'facts',
        bytes: utf8Bytes(
          readFileSync(join(demoFeaturesDir, 'order-list/facts.md'), 'utf8'),
        ),
      },
    ]);
    expect(description.toolIds).toEqual([
      'order-list.cancel-order',
      'order-list.refresh-orders',
      'order-list.purge-orders',
      'order-list.page-operate',
    ]);
  });

  it('featureId=null：仅 system-prompt 块，toolIds 为空', async () => {
    const port = demoPort();
    const description = await port.describeInjection({
      sessionId: 's1',
      packId: 'host-demo',
      featureId: null,
    });
    expect(description.featureId).toBeNull();
    expect(description.blocks.map((b) => b.kind)).toEqual(['system-prompt']);
    expect(description.toolIds).toEqual([]);
  });

  it('fixture：skill 块带 id 与字节数，且与 compose 内容同源', async () => {
    const port = fixturePort('valid');
    const composed = await port.compose({ sessionId: 's1', packId: 'default', featureId: 'alpha' });
    const description = await port.describeInjection({
      sessionId: 's1',
      packId: 'default',
      featureId: 'alpha',
    });
    expect(description.blocks).toEqual([
      { kind: 'system-prompt', bytes: utf8Bytes(composed.systemPrompt) },
      { kind: 'feature-rules', bytes: utf8Bytes(composed.featureRules!) },
      { kind: 'facts', bytes: utf8Bytes(composed.facts!) },
      { kind: 'skill', id: 'aid', bytes: utf8Bytes('AID-SKILL 内容\n') },
      { kind: 'skill', id: 'greet', bytes: utf8Bytes('GREET-SKILL 内容\n') },
    ]);
    expect(description.toolIds).toEqual(composed.tools.map((t) => t.id));
  });
});

describe('registry 形态：两级激活（origin + 最长 location 前缀）', () => {
  it('origin 精确匹配到唯一 pack + pack 内 featureIdRules 命中 featureId', async () => {
    const port = fixturePort('registry-valid');
    const a = await port.resolveFeature({ url: 'http://a.example/list' });
    expect(a).toEqual({
      packId: 'site-a',
      packVersion: '1.0.0',
      featureId: 'alpha',
      snapshotVersion: '3.0.0',
    });
    const b = await port.resolveFeature({ url: 'http://b.example/beta' });
    expect(b.packId).toBe('site-b');
    expect(b.packVersion).toBe('2.0.0');
    expect(b.featureId).toBe('beta');
  });

  it('origin 不匹配任何 pack → 仅基座（packId=null）', async () => {
    const port = fixturePort('registry-valid');
    const none = await port.resolveFeature({ url: 'http://c.example/list' });
    expect(none.packId).toBeNull();
    expect(none.featureId).toBeNull();
    expect(none.snapshotVersion).toBe('3.0.0');
  });

  it('同 origin 多 pack：最长 location 前缀胜出', async () => {
    const port = fixturePort('registry-prefix');
    const crm = await port.resolveFeature({ url: 'http://host.example/crm/leads' });
    expect(crm.packId).toBe('crm');
    expect(crm.featureId).toBe('leads');
    const home = await port.resolveFeature({ url: 'http://host.example/other' });
    expect(home.packId).toBe('root');
    expect(home.featureId).toBe('home');
    // 前缀不越段：/crmx 不落 /crm，回落最长可匹配 root
    const notCrm = await port.resolveFeature({ url: 'http://host.example/crmx' });
    expect(notCrm.packId).toBe('root');
  });

  it('pack 作用域 skills：只注入激活 pack 的 skills', async () => {
    const port = fixturePort('registry-valid');
    const a = await port.compose({ sessionId: 's', packId: 'site-a', featureId: 'alpha' });
    expect(a.skills.map((s) => s.id)).toEqual(['aid']);
    const b = await port.compose({ sessionId: 's', packId: 'site-b', featureId: 'beta' });
    expect(b.skills).toEqual([]);
  });

  it('docs 索引：有 docs/ 的 pack 注入索引块（标题+摘要），无 docs/ 的 pack 为 null', async () => {
    const port = fixturePort('registry-valid');
    const a = await port.compose({ sessionId: 's', packId: 'site-a', featureId: 'alpha' });
    expect(a.docsIndex).not.toBeNull();
    expect(a.docsIndex).toContain('guide.md');
    expect(a.docsIndex).toContain('站点 A 操作指南');
    expect(a.docsIndex).toContain('讲解 A 站的下单流程');
    const desc = await port.describeInjection({ sessionId: 's', packId: 'site-a', featureId: 'alpha' });
    expect(desc.blocks.map((x) => x.kind)).toContain('docs-index');
    const b = await port.compose({ sessionId: 's', packId: 'site-b', featureId: 'beta' });
    expect(b.docsIndex).toBeNull();
  });

  it('allTools：跨 pack 工具并集（fail-closed 闭集）', async () => {
    const port = fixturePort('registry-valid');
    const tools = await port.allTools();
    expect(tools.map((t) => t.id).sort()).toEqual(['alpha.do', 'beta.do']);
  });

  it('站点索引：≥2 带 site 的 pack → 列全站（用途/可达 URL）+ 标注当前，含 sites-index 块', async () => {
    const port = fixturePort('registry-valid');
    const a = await port.compose({ sessionId: 's', packId: 'site-a', featureId: 'alpha' });
    expect(a.sitesIndex).not.toBeNull();
    // site-a 有 summary → 用摘要；site-b 无 summary → 回退 packId。可达 URL = origin + 首个 location。
    expect(a.sitesIndex).toContain('站点 A 用途摘要：http://a.example/');
    expect(a.sitesIndex).toContain('site-b：http://b.example/');
    // 当前激活 pack（site-a）标注（当前），非当前（site-b）不标注。
    expect(a.sitesIndex).toMatch(/站点 A 用途摘要：http:\/\/a\.example\/（当前）/);
    expect(a.sitesIndex).not.toMatch(/site-b：http:\/\/b\.example\/（当前）/);
    const desc = await port.describeInjection({ sessionId: 's', packId: 'site-a', featureId: 'alpha' });
    expect(desc.blocks.map((x) => x.kind)).toContain('sites-index');
    // 换 pack 激活 → 当前标注随之移动到 site-b。
    const b = await port.compose({ sessionId: 's', packId: 'site-b', featureId: 'beta' });
    expect(b.sitesIndex).toMatch(/site-b：http:\/\/b\.example\/（当前）/);
    // packId=null（无 pack 命中）但仍 ≥2 site → 注入索引、任何站点条目都不标注当前（表头说明句除外）。
    const none = await port.compose({ sessionId: 's', packId: null, featureId: null });
    expect(none.sitesIndex).not.toBeNull();
    expect(none.sitesIndex).not.toMatch(/https?:\/\/[^\n]*（当前）/);
  });
});

describe('registry 形态：generic 兜底 pack', () => {
  it('generic pack 载入成功，站点命中永远优先（返回体不带 generic 键）', async () => {
    const port = fixturePort('registry-generic');
    const result = await port.resolveFeature({ url: 'http://site-a.example/x' });
    expect(result.packId).toBe('site-a');
    expect(result.featureId).toBe('alpha');
    expect(result).not.toHaveProperty('generic');
  });

  it('无站点 pack 命中 → 回落 generic 兜底（generic:true）', async () => {
    const port = fixturePort('registry-generic');
    await expect(
      port.resolveFeature({ url: 'https://elsewhere.example/p' }),
    ).resolves.toEqual({
      packId: 'gen',
      packVersion: '1.0.0',
      featureId: 'browse',
      snapshotVersion: '1.0.0',
      generic: true,
    });
  });

  it('URL 不可解析 → 不兜底，仅基座（packId=null）', async () => {
    const port = fixturePort('registry-generic');
    const result = await port.resolveFeature({ url: '' });
    expect(result.packId).toBeNull();
    expect(result.featureId).toBeNull();
  });

  it('registry 存在两个 generic pack → 拒载', async () => {
    const port = fixturePort('registry-generic-dup');
    await expect(port.resolveFeature({ url: 'http://x.example/' })).rejects.toThrow(
      /两个 generic pack/,
    );
  });

  it('generic pack 同时声明 site → 拒载（schema 互斥先拦）', async () => {
    const port = fixturePort('registry-generic-site');
    await expect(port.resolveFeature({ url: 'http://gen.example/' })).rejects.toThrow(
      /pack 契约|site/,
    );
  });

  it('listSites 排除 generic pack（无 origin，不进站点清单）', async () => {
    const port = fixturePort('registry-generic');
    const sites = await port.listSites();
    expect(sites.map((s) => s.packId)).toEqual(['site-a']);
  });
});

describe('registry 形态：载入期 fail-closed 拒载', () => {
  it('同 origin location 前缀重复 → 拒载', async () => {
    const port = fixturePort('registry-dup');
    await expect(port.resolveFeature({ url: 'http://dup.example/app' })).rejects.toThrow(/重复/);
  });

  it('registry 登记版本与 pack.json 版本不一致 → 拒载', async () => {
    const port = fixturePort('registry-mismatch');
    await expect(port.resolveFeature({ url: 'http://drift.example/' })).rejects.toThrow(/版本/);
  });
});

describe('pack_doc 读取围栏（readPackDoc）', () => {
  it('读当前 pack docs/ 内正文 → ok', async () => {
    const port = fixturePort('registry-valid');
    const doc = await port.readPackDoc({ packId: 'site-a', docPath: 'guide.md' });
    expect(doc.ok).toBe(true);
    expect(doc.content).toContain('A 站详细步骤正文');
    expect(doc.truncated).toBe(false);
  });

  it('路径穿越出 docs/ → fail-closed 拒读', async () => {
    const port = fixturePort('registry-valid');
    const doc = await port.readPackDoc({ packId: 'site-a', docPath: '../pack.json' });
    expect(doc.ok).toBe(false);
    expect(doc.content).toBeUndefined();
  });

  it('无激活 pack / 无文档的 pack → 拒读', async () => {
    const port = fixturePort('registry-valid');
    expect((await port.readPackDoc({ packId: null, docPath: 'guide.md' })).ok).toBe(false);
    expect((await port.readPackDoc({ packId: 'site-b', docPath: 'guide.md' })).ok).toBe(false);
  });

  it('超单次上限的正文被截断（truncated=true）', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'za-pack-doc-'));
    tmpDirs.push(tmp);
    const packRoot = join(tmp, 'packs', 'big');
    mkdirSync(join(packRoot, 'features', 'f'), { recursive: true });
    mkdirSync(join(packRoot, 'docs'), { recursive: true });
    writeFileSync(
      join(tmp, 'manifest.json'),
      JSON.stringify({ version: '1.0.0', packs: [{ packId: 'big', version: '1.0.0' }] }),
    );
    writeFileSync(
      join(packRoot, 'pack.json'),
      JSON.stringify({
        packId: 'big',
        version: '1.0.0',
        site: { origin: 'http://big.example', locations: ['/'] },
        featureIdRules: [{ urlPattern: '.*', featureId: 'f' }],
        features: ['f'],
      }),
    );
    writeFileSync(join(packRoot, 'features', 'f', 'feature.md'), 'F\n');
    writeFileSync(join(packRoot, 'features', 'f', 'facts.md'), 'F\n');
    writeFileSync(join(packRoot, 'features', 'f', 'tools.json'), '[]');
    writeFileSync(join(packRoot, 'docs', 'big.md'), 'x'.repeat(30 * 1024));
    const port = createAssemblyPort({ snapshotRoot: tmp, systemPromptPath: fixturePromptPath });
    const doc = await port.readPackDoc({ packId: 'big', docPath: 'big.md' });
    expect(doc.ok).toBe(true);
    expect(doc.truncated).toBe(true);
    expect(Buffer.byteLength(doc.content ?? '', 'utf8')).toBe(20 * 1024);
  });
});

describe('非法快照 fail-closed 拒载', () => {
  it('manifest 缺 featureIdRules → 拒载', async () => {
    const port = fixturePort('bad-manifest');
    await expect(port.resolveFeature({ url: 'http://host/x' })).rejects.toThrow(/featureIdRules/);
  });

  it('features 闭单声明的功能目录缺失 → 拒载', async () => {
    const port = fixturePort('missing-feature');
    await expect(port.resolveFeature({ url: 'http://host/x' })).rejects.toThrow(/ghost/);
  });

  it('tools.json 元素不过 tool-definition 契约 → 拒载', async () => {
    const port = fixturePort('bad-tool');
    await expect(
      port.compose({ sessionId: 's1', packId: 'default', featureId: 'broken' }),
    ).rejects.toThrow(/tools\.json/);
  });

  it('featureIdRules 指向快照外功能 → 拒载', async () => {
    const port = fixturePort('rule-unknown');
    await expect(port.resolveFeature({ url: 'http://host/x' })).rejects.toThrow(/nowhere/);
  });

  it('urlPattern 非法正则 → 拒载', async () => {
    const port = fixturePort('bad-regex');
    await expect(port.resolveFeature({ url: 'http://host/x' })).rejects.toThrow(/urlPattern/);
  });

  it('systemPromptPath 不存在 → 拒载', async () => {
    const port = createAssemblyPort({
      snapshotRoot: join(fixturesDir, 'valid'),
      systemPromptPath: join(fixturesDir, 'no-such-prompt.md'),
    });
    await expect(port.compose({ sessionId: 's1', packId: null, featureId: null })).rejects.toThrow();
  });
});
