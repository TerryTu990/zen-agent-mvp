import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAssemblyPort } from '../src/index.js';

const fixturesDir = new URL('./fixtures/', import.meta.url).pathname;
const repoRoot = new URL('../../../', import.meta.url).pathname;
const demoSnapshotRoot = join(repoRoot, 'examples/host-demo/config');
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

describe('resolveFeature（examples/host-demo 真实快照）', () => {
  const port = demoPort();

  it('order-list.html 命中 order-list，回写快照版本', async () => {
    await expect(
      port.resolveFeature({ url: 'http://127.0.0.1:4173/order-list.html' }),
    ).resolves.toEqual({ featureId: 'order-list', snapshotVersion: '0.2.0' });
  });

  it('order-detail.html?orderId=... 命中 order-detail', async () => {
    const result = await port.resolveFeature({
      url: 'http://127.0.0.1:4173/order-detail.html?orderId=ORD-1001',
    });
    expect(result.featureId).toBe('order-detail');
  });

  it('无规则命中 → featureId=null（fail-safe）', async () => {
    const result = await port.resolveFeature({ url: 'http://127.0.0.1:4173/index.html' });
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
    const result = await port.compose({ sessionId: 's1', featureId: 'order-list' });
    expect(result.snapshotVersion).toBe('0.2.0');
    expect(result.systemPrompt).toBe(readFileSync(baseSystemPromptPath, 'utf8'));
    expect(result.featureRules).toBe(
      readFileSync(join(demoSnapshotRoot, 'features/order-list/feature.md'), 'utf8'),
    );
    expect(result.facts).toBe(
      readFileSync(join(demoSnapshotRoot, 'features/order-list/facts.md'), 'utf8'),
    );
    expect(result.tools.map((t) => t.id)).toEqual([
      'order-list.cancel-order',
      'order-list.refresh-orders',
      'order-list.purge-orders',
    ]);
    expect(result.skills).toEqual([]);
  });

  it('order-detail：换出块随功能切换，工具面为空', async () => {
    const result = await port.compose({ sessionId: 's1', featureId: 'order-detail' });
    expect(result.featureRules).toContain('订单详情');
    expect(result.facts).toContain('#order-id');
    expect(result.facts).not.toContain('#order-table');
    expect(result.tools).toEqual([]);
  });

  it('featureId=null：仅稳定基座，功能块为 null、工具为空', async () => {
    const result = await port.compose({ sessionId: 's1', featureId: null });
    expect(result.systemPrompt).toBe(readFileSync(baseSystemPromptPath, 'utf8'));
    expect(result.featureRules).toBeNull();
    expect(result.facts).toBeNull();
    expect(result.tools).toEqual([]);
  });

  it('快照外 featureId → fail-closed 拒绝', async () => {
    await expect(port.compose({ sessionId: 's1', featureId: 'ghost' })).rejects.toThrow(/ghost/);
  });
});

describe('compose（fixture：skills 与工具过滤）', () => {
  it('skills/*/SKILL.md 全量载入并按 id 排序', async () => {
    const port = fixturePort('valid');
    const result = await port.compose({ sessionId: 's1', featureId: 'alpha' });
    expect(result.skills).toEqual([
      { id: 'aid', content: 'AID-SKILL 内容\n' },
      { id: 'greet', content: 'GREET-SKILL 内容\n' },
    ]);
  });

  it('工具按 featureIds 挂载过滤（未挂载当前功能的不可见）', async () => {
    const port = fixturePort('valid');
    const result = await port.compose({ sessionId: 's1', featureId: 'alpha' });
    expect(result.tools.map((t) => t.id)).toEqual(['alpha.do']);
  });

  it('返回值可被调用方安全变更，缓存快照不受影响（U4）', async () => {
    const port = fixturePort('valid');
    const first = await port.compose({ sessionId: 's1', featureId: 'alpha' });
    first.tools.pop();
    first.skills[0]!.content = 'MUTATED';
    const second = await port.compose({ sessionId: 's2', featureId: 'alpha' });
    expect(second.tools.map((t) => t.id)).toEqual(['alpha.do']);
    expect(second.skills[0]!.content).toBe('AID-SKILL 内容\n');
  });
});

describe('describeInjection（与 compose 同源投影）', () => {
  it('demo order-list：blocks 字节数与 toolIds 正确', async () => {
    const port = demoPort();
    const description = await port.describeInjection({ sessionId: 's1', featureId: 'order-list' });
    expect(description.snapshotVersion).toBe('0.2.0');
    expect(description.featureId).toBe('order-list');
    expect(description.blocks).toEqual([
      { kind: 'system-prompt', bytes: utf8Bytes(readFileSync(baseSystemPromptPath, 'utf8')) },
      {
        kind: 'feature-rules',
        bytes: utf8Bytes(
          readFileSync(join(demoSnapshotRoot, 'features/order-list/feature.md'), 'utf8'),
        ),
      },
      {
        kind: 'facts',
        bytes: utf8Bytes(
          readFileSync(join(demoSnapshotRoot, 'features/order-list/facts.md'), 'utf8'),
        ),
      },
    ]);
    expect(description.toolIds).toEqual([
      'order-list.cancel-order',
      'order-list.refresh-orders',
      'order-list.purge-orders',
    ]);
  });

  it('featureId=null：仅 system-prompt 块，toolIds 为空', async () => {
    const port = demoPort();
    const description = await port.describeInjection({ sessionId: 's1', featureId: null });
    expect(description.featureId).toBeNull();
    expect(description.blocks.map((b) => b.kind)).toEqual(['system-prompt']);
    expect(description.toolIds).toEqual([]);
  });

  it('fixture：skill 块带 id 与字节数，且与 compose 内容同源', async () => {
    const port = fixturePort('valid');
    const composed = await port.compose({ sessionId: 's1', featureId: 'alpha' });
    const description = await port.describeInjection({ sessionId: 's1', featureId: 'alpha' });
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
    await expect(port.compose({ sessionId: 's1', featureId: 'broken' })).rejects.toThrow(
      /tools\.json/,
    );
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
    await expect(port.compose({ sessionId: 's1', featureId: null })).rejects.toThrow();
  });
});
