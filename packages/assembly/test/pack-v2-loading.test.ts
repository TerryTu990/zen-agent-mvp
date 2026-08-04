import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createAssemblyPort } from '../src/index.js';

const fixturesDir = new URL('./fixtures/', import.meta.url).pathname;
const fixturePromptPath = join(fixturesDir, 'base-prompt.md');

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function fixturePort(name: string) {
  return createAssemblyPort({
    snapshotRoot: join(fixturesDir, name),
    systemPromptPath: fixturePromptPath,
  });
}

interface V2SnapshotOptions {
  skills?: Record<string, string>;
  /** 键可含 / 子目录相对路径（docs 闭单对账的递归语义）。 */
  docs?: Record<string, string>;
  /** registry 登记项的额外字段（如 source）。 */
  registryExtras?: Record<string, unknown>;
  /** feature.md 内容覆盖（如带 frontmatter title）。 */
  featureMd?: string;
}

function v2Snapshot(packOverrides: Record<string, unknown>, options: V2SnapshotOptions = {}): string {
  const tmp = mkdtempSync(join(tmpdir(), 'za-pack-v2-'));
  tmpDirs.push(tmp);
  const packRoot = join(tmp, 'packs', 'p');
  mkdirSync(join(packRoot, 'features', 'f'), { recursive: true });
  writeFileSync(
    join(tmp, 'manifest.json'),
    JSON.stringify({
      version: '1.0.0',
      packs: [{ packId: 'p', version: '1.0.0', ...(options.registryExtras ?? {}) }],
    }),
  );
  writeFileSync(
    join(packRoot, 'pack.json'),
    JSON.stringify({
      packId: 'p',
      version: '1.0.0',
      site: { origin: 'http://p.example', locations: ['/'] },
      featureIdRules: [{ urlPattern: '.*', featureId: 'f' }],
      features: ['f'],
      ...packOverrides,
    }),
  );
  writeFileSync(join(packRoot, 'features', 'f', 'feature.md'), options.featureMd ?? 'F\n');
  writeFileSync(join(packRoot, 'features', 'f', 'facts.md'), 'F\n');
  writeFileSync(join(packRoot, 'features', 'f', 'tools.json'), '[]');
  for (const [id, content] of Object.entries(options.skills ?? {})) {
    mkdirSync(join(packRoot, 'skills', id), { recursive: true });
    writeFileSync(join(packRoot, 'skills', id, 'SKILL.md'), content);
  }
  for (const [name, content] of Object.entries(options.docs ?? {})) {
    const docPath = join(packRoot, 'docs', name);
    mkdirSync(join(docPath, '..'), { recursive: true });
    writeFileSync(docPath, content);
  }
  return tmp;
}

function portOf(tmp: string) {
  return createAssemblyPort({ snapshotRoot: tmp, systemPromptPath: fixturePromptPath });
}

describe('pack v2 载入：site.exclude 排除判定（adr-020 §2）', () => {
  const tmp = v2Snapshot({
    site: { origin: 'http://p.example', locations: ['/'], exclude: ['/admin'] },
  });

  it('exclude 前缀命中 → 本 pack 不激活（仅基座）', async () => {
    const result = await portOf(tmp).resolveFeature({ url: 'http://p.example/admin/panel' });
    expect(result.packId).toBeNull();
    expect(result.featureId).toBeNull();
  });

  it('exclude 未命中路径照常激活（回归锚）', async () => {
    const result = await portOf(tmp).resolveFeature({ url: 'http://p.example/shop/list' });
    expect(result.packId).toBe('p');
    expect(result.featureId).toBe('f');
  });
});

describe('pack v2 载入：engines.contract 兼容判定（fail-closed）', () => {
  it('contract 范围不满足平台契约版本 → 拒载且错误可定位（含 packId 与字段名）', async () => {
    const tmp = v2Snapshot({ engines: { contract: '^99.0.0' } });
    await expect(portOf(tmp).resolveFeature({ url: 'http://p.example/x' })).rejects.toThrow(
      /engines\.contract|contract/,
    );
  });

  it('contract 范围满足 → 照常载入（边界）', async () => {
    const tmp = v2Snapshot({ engines: { contract: '^1.0.0' } });
    await expect(portOf(tmp).resolveFeature({ url: 'http://p.example/x' })).resolves.toMatchObject({
      packId: 'p',
      featureId: 'f',
    });
  });
});

describe('pack v2 载入：capabilities 闭单对账（skills/docs）', () => {
  it('capabilities.skills 声明与 skills/ 目录一致 → 载入成功', async () => {
    const tmp = v2Snapshot(
      { capabilities: { skills: ['greet'], docs: ['guide.md'] } },
      { skills: { greet: 'GREET\n' }, docs: { 'guide.md': '# 指南\n正文\n' } },
    );
    await expect(portOf(tmp).resolveFeature({ url: 'http://p.example/x' })).resolves.toMatchObject({
      packId: 'p',
    });
  });

  it('capabilities.skills 闭单含目录缺失项 → 拒载', async () => {
    const tmp = v2Snapshot({ capabilities: { skills: ['ghost'] } });
    await expect(portOf(tmp).resolveFeature({ url: 'http://p.example/x' })).rejects.toThrow(/ghost/);
  });

  it('skills/ 目录含闭单外条目 → 拒载（对账双向）', async () => {
    const tmp = v2Snapshot(
      { capabilities: { skills: ['greet'] } },
      { skills: { greet: 'GREET\n', rogue: 'ROGUE\n' } },
    );
    await expect(portOf(tmp).resolveFeature({ url: 'http://p.example/x' })).rejects.toThrow(/rogue/);
  });

  it('capabilities.docs 闭单含目录缺失项 → 拒载', async () => {
    const tmp = v2Snapshot({ capabilities: { docs: ['ghost.md'] } });
    await expect(portOf(tmp).resolveFeature({ url: 'http://p.example/x' })).rejects.toThrow(
      /ghost\.md/,
    );
  });
});

describe('pack v2 载入：preparation.workflows 服务端闭集交叉校验', () => {
  it('声明服务端未实现的 workflow → 拒载', async () => {
    const tmp = v2Snapshot({ capabilities: { preparation: { workflows: ['card-magic'] } } });
    await expect(portOf(tmp).resolveFeature({ url: 'http://p.example/x' })).rejects.toThrow(
      /card-magic/,
    );
  });

  it('声明服务端闭集内 workflow → 载入成功（边界）', async () => {
    const tmp = v2Snapshot({ capabilities: { preparation: { workflows: ['delivery', 'shipment'] } } });
    await expect(portOf(tmp).resolveFeature({ url: 'http://p.example/x' })).resolves.toMatchObject({
      packId: 'p',
    });
  });
});

describe('pack v2 载入：configSchema 合法性校验', () => {
  it('configSchema 不是合法 JSON Schema → 拒载', async () => {
    const tmp = v2Snapshot({
      configSchema: { type: 'object', properties: { x: { type: 'no-such-type' } } },
    });
    await expect(portOf(tmp).resolveFeature({ url: 'http://p.example/x' })).rejects.toThrow(
      /configSchema/,
    );
  });

  it('合法 configSchema 照常载入（边界）', async () => {
    const tmp = v2Snapshot({
      configSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { greeting: { type: 'string', default: '您好' } },
      },
    });
    await expect(portOf(tmp).resolveFeature({ url: 'http://p.example/x' })).resolves.toMatchObject({
      packId: 'p',
    });
  });
});

describe('pack v2 载入：docs 子目录闭单（对账/索引/围栏同一文件集）', () => {
  it('capabilities.docs 声明子目录相对路径且文件存在 → 载入成功', async () => {
    const tmp = v2Snapshot(
      { capabilities: { docs: ['guides/howto.md', 'top.md'] } },
      { docs: { 'guides/howto.md': '# 指南\n', 'top.md': '# 顶层\n' } },
    );
    await expect(portOf(tmp).resolveFeature({ url: 'http://p.example/x' })).resolves.toMatchObject({
      packId: 'p',
    });
  });

  it('docs/ 子目录含闭单外文件 → 拒载（递归对账双向）', async () => {
    const tmp = v2Snapshot(
      { capabilities: { docs: ['top.md'] } },
      { docs: { 'top.md': '# 顶层\n', 'guides/rogue.md': 'ROGUE\n' } },
    );
    await expect(portOf(tmp).resolveFeature({ url: 'http://p.example/x' })).rejects.toThrow(
      /guides\/rogue\.md/,
    );
  });
});

describe('注入自省元数据（R4 来源徽章/人读名数据源）', () => {
  it('describeInjection 透出 packVersion/packSource/packName/featureTitle', async () => {
    const tmp = v2Snapshot(
      { name: '示例商店' },
      {
        registryExtras: { source: 'community' },
        featureMd: '---\ntitle: 订单处理\n---\nF\n',
      },
    );
    const description = await portOf(tmp).describeInjection({
      sessionId: 's1',
      packId: 'p',
      featureId: 'f',
    });
    expect(description.packVersion).toBe('1.0.0');
    expect(description.packSource).toBe('community');
    expect(description.packName).toBe('示例商店');
    expect(description.featureTitle).toBe('订单处理');
  });

  it('registry 未声明 source → 缺省 official；pack 未声明 name → 省略回退 packId', async () => {
    const tmp = v2Snapshot({});
    const description = await portOf(tmp).describeInjection({
      sessionId: 's1',
      packId: 'p',
      featureId: 'f',
    });
    expect(description.packSource).toBe('official');
    expect(description.packName).toBeUndefined();
  });
});

describe('knowledge-only pack（仅 feature.md + facts.md，无 tools.json）', () => {
  const port = fixturePort('registry-knowledge');

  it('载入成功且 resolveFeature 正常激活', async () => {
    await expect(port.resolveFeature({ url: 'http://wiki.example/page/1' })).resolves.toEqual({
      packId: 'wiki-notes',
      packVersion: '1.0.0',
      featureId: 'reading',
      snapshotVersion: '1.0.0',
    });
  });

  it('讲解注入可用：feature/facts 注入齐备、工具面为空', async () => {
    const result = await port.compose({
      sessionId: 's1',
      packId: 'wiki-notes',
      featureId: 'reading',
    });
    expect(result.featureRules).toContain('阅读讲解规则');
    expect(result.facts).toContain('#wiki-search');
    expect(result.tools).toEqual([]);
    expect(result.skills).toEqual([]);
  });
});
