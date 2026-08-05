import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type {
  AssemblyPort,
  ComposeInput,
  ComposeResult,
  InjectionToolDescriptor,
  RiskTier,
  UserConfigReadResult,
  UserConfigStore,
  UserConfigSubject,
  UserInjectionEntry,
  UserOverlay,
  UserOverlayEntry,
} from '@zen-agent/contracts';
import { createAssemblyPort, type AssemblyOptions } from '../src/index.js';

const fixturesDir = new URL('./fixtures/', import.meta.url).pathname;
const fixturePromptPath = join(fixturesDir, 'base-prompt.md');

/** L2 渲染条目 → 断言用文本（逐条 id + 渲染文本，顺序即注入序）。 */
function entriesText(entries: UserInjectionEntry[] | undefined): string {
  return (entries ?? []).map((entry) => `${entry.id} ${entry.text}`).join('\n');
}

// ---- 内存 UserConfigStore（revision = sha256(JSON.stringify(overlay, null, 2))；缺失 = sha256('null')） ----

function revisionOf(overlay: UserOverlay | null): string {
  return createHash('sha256')
    .update(overlay === null ? 'null' : JSON.stringify(overlay, null, 2))
    .digest('hex');
}

function subjectKey(subject: UserConfigSubject): string {
  return `${subject.tenant}/${subject.hostUserId}`;
}

class MemoryUserConfigStore implements UserConfigStore {
  private readonly overlays = new Map<string, UserOverlay>();

  seed(subject: UserConfigSubject, overlay: UserOverlay): void {
    this.overlays.set(subjectKey(subject), overlay);
  }

  async read(subject: UserConfigSubject): Promise<UserConfigReadResult> {
    const stored = this.overlays.get(subjectKey(subject)) ?? null;
    return { overlay: structuredClone(stored), revision: revisionOf(stored) };
  }

  async write(subject: UserConfigSubject, overlay: UserOverlay) {
    this.overlays.set(subjectKey(subject), structuredClone(overlay));
    return { revision: revisionOf(overlay) };
  }
}

class ThrowingUserConfigStore implements UserConfigStore {
  async read(): Promise<UserConfigReadResult> {
    throw new Error('user-config-storage-failure');
  }

  async write(): Promise<{ revision: string }> {
    throw new Error('user-config-storage-failure');
  }
}

/** 模拟 fs 实现的 stale 降级：读失败但有 lastGood → 返回旧值 + stale 标注。 */
class StaleUserConfigStore implements UserConfigStore {
  constructor(private readonly lastGood: UserOverlay) {}

  async read(): Promise<UserConfigReadResult> {
    return {
      overlay: structuredClone(this.lastGood),
      revision: revisionOf(this.lastGood),
      stale: true,
    } as UserConfigReadResult;
  }

  async write(): Promise<{ revision: string }> {
    throw new Error('user-config-storage-failure');
  }
}

// ---- 快照与 overlay 夹具 ----

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function shopTool(id: string, riskTier: RiskTier): object {
  return {
    id,
    featureIds: ['f'],
    description: `${id} 示例工具`,
    params: { type: 'object' },
    execution: 'client',
    riskTier,
    adapter: { method: 'GET', urlTemplate: '/api/x' },
    resultSchema: { type: 'object' },
  };
}

/** 单 pack 快照：feature f 挂三档工具 + 一个 skill（注入序断言需要 skills 段）。 */
function shopSnapshot(): string {
  const tmp = mkdtempSync(join(tmpdir(), 'za-l2-merge-'));
  tmpDirs.push(tmp);
  const packRoot = join(tmp, 'packs', 'shop');
  mkdirSync(join(packRoot, 'features', 'f'), { recursive: true });
  mkdirSync(join(packRoot, 'features', 'g'), { recursive: true });
  mkdirSync(join(packRoot, 'skills', 'greet'), { recursive: true });
  writeFileSync(
    join(tmp, 'manifest.json'),
    JSON.stringify({ version: '1.0.0', packs: [{ packId: 'shop', version: '1.0.0' }] }),
  );
  writeFileSync(
    join(packRoot, 'pack.json'),
    JSON.stringify({
      packId: 'shop',
      version: '1.0.0',
      site: { origin: 'http://shop.example', locations: ['/'] },
      featureIdRules: [{ urlPattern: '.*', featureId: 'f' }],
      features: ['f', 'g'],
      capabilities: { skills: ['greet'] },
    }),
  );
  writeFileSync(join(packRoot, 'features', 'f', 'feature.md'), 'L1 功能规则\n');
  writeFileSync(join(packRoot, 'features', 'f', 'facts.md'), 'L1 站点事实\n');
  writeFileSync(
    join(packRoot, 'features', 'f', 'tools.json'),
    JSON.stringify([
      shopTool('shop.list', 'auto'),
      shopTool('shop.cancel', 'hitl'),
      shopTool('shop.purge', 'forbidden'),
    ]),
  );
  writeFileSync(join(packRoot, 'features', 'g', 'feature.md'), '另一功能规则\n');
  writeFileSync(join(packRoot, 'features', 'g', 'facts.md'), '另一功能事实\n');
  writeFileSync(
    join(packRoot, 'features', 'g', 'tools.json'),
    JSON.stringify([{ ...shopTool('shop.export', 'auto'), featureIds: ['g'] }]),
  );
  writeFileSync(join(packRoot, 'skills', 'greet', 'SKILL.md'), 'GREET 技能\n');
  return tmp;
}

function l2Port(tmp: string, store?: UserConfigStore): AssemblyPort {
  const options: AssemblyOptions = {
    snapshotRoot: tmp,
    systemPromptPath: fixturePromptPath,
    ...(store !== undefined ? { userConfigStore: store } : {}),
  };
  return createAssemblyPort(options);
}

const subjectA: UserConfigSubject = { tenant: 'default', hostUserId: 'user-a' };
const subjectB: UserConfigSubject = { tenant: 'default', hostUserId: 'user-b' };

function entry(id: string, text: string, featureId?: string): UserOverlayEntry {
  return {
    id,
    text,
    origin: 'manual',
    createdAt: '2026-08-05T00:00:00.000Z',
    ...(featureId !== undefined ? { featureId } : {}),
  };
}

function overlayOf(subject: UserConfigSubject, packs: UserOverlay['packs']): UserOverlay {
  return { schemaVersion: 1, subject, packs };
}

const composeShop: ComposeInput = { sessionId: 's1', packId: 'shop', featureId: 'f', subject: subjectA };

async function composeL2(port: AssemblyPort, input: ComposeInput = composeShop): Promise<ComposeResult> {
  return await port.compose(input);
}

function toolOf(result: ComposeResult, toolId: string): InjectionToolDescriptor {
  const found = result.effectiveTools?.find((tool) => tool.toolId === toolId);
  expect(found, `effectiveTools 应含 ${toolId}`).toBeDefined();
  return found!;
}

// ---- 用例矩阵 ----

describe('L2 riskTier 合并 = max(L1, L2)（adr-014 §3）', () => {
  const tmp = shopSnapshot();

  it('L2 hitl 覆盖 L1 auto → effectiveTier=hitl 且 tightenedBy=shop（正常）', async () => {
    const store = new MemoryUserConfigStore();
    store.seed(
      subjectA,
      overlayOf(subjectA, {
        shop: { restrictions: { riskTierRaise: { 'shop.list': 'hitl' } } },
      }),
    );
    const result = await composeL2(l2Port(tmp, store));
    const tool = toolOf(result, 'shop.list');
    expect(tool.baseTier).toBe('auto');
    expect(tool.effectiveTier).toBe('hitl');
    expect(tool.tightenedBy).toBe('shop');
  });

  it('L1=forbidden 时 L2 任何值不改变结果（边界）', async () => {
    const store = new MemoryUserConfigStore();
    store.seed(
      subjectA,
      overlayOf(subjectA, {
        shop: { restrictions: { riskTierRaise: { 'shop.purge': 'hitl' } } },
      }),
    );
    const result = await composeL2(l2Port(tmp, store));
    const tool = toolOf(result, 'shop.purge');
    expect(tool.baseTier).toBe('forbidden');
    expect(tool.effectiveTier).toBe('forbidden');
    expect(tool.tightenedBy).toBeUndefined();
  });

  it('未收紧工具保持 L1 原值（回归锚）', async () => {
    const store = new MemoryUserConfigStore();
    store.seed(
      subjectA,
      overlayOf(subjectA, {
        shop: { restrictions: { riskTierRaise: { 'shop.list': 'hitl' } } },
      }),
    );
    const result = await composeL2(l2Port(tmp, store));
    const untouched = toolOf(result, 'shop.cancel');
    expect(untouched.effectiveTier).toBe('hitl');
    expect(untouched.tightenedBy).toBeUndefined();
  });
});

describe('L2 disabledTools：agent 可见面移除 + effectiveTools 保留为 forbidden', () => {
  const tmp = shopSnapshot();

  it('禁用工具从 tools 移除、effectiveTools 条目置 forbidden（幻觉调用仍被拒的数据源）', async () => {
    const store = new MemoryUserConfigStore();
    store.seed(
      subjectA,
      overlayOf(subjectA, {
        shop: { restrictions: { disabledTools: ['shop.cancel'] } },
      }),
    );
    const result = await composeL2(l2Port(tmp, store));
    expect(result.tools.map((tool) => tool.id)).not.toContain('shop.cancel');
    expect(result.tools.map((tool) => tool.id)).toContain('shop.list');
    const disabled = toolOf(result, 'shop.cancel');
    expect(disabled.effectiveTier).toBe('forbidden');
  });
});

describe('L2 越界引用：逐条失效不阻断其余（adr-014 §3）', () => {
  const tmp = shopSnapshot();

  it('toolId 不在 L1 面 → invalidRefs 含该条，其余收紧照常生效', async () => {
    const store = new MemoryUserConfigStore();
    store.seed(
      subjectA,
      overlayOf(subjectA, {
        shop: {
          restrictions: {
            riskTierRaise: { 'shop.ghost': 'forbidden', 'shop.list': 'hitl' },
          },
        },
      }),
    );
    const result = await composeL2(l2Port(tmp, store));
    expect(result.invalidRefs).toContain('shop.ghost');
    expect(toolOf(result, 'shop.list').effectiveTier).toBe('hitl');
    expect(result.effectiveTools?.map((tool) => tool.toolId)).not.toContain('shop.ghost');
  });

  it('引用同 pack 其他 feature 的合法收紧不算越界（判定基线=pack 工具闭集，与写入期同口径）', async () => {
    const store = new MemoryUserConfigStore();
    store.seed(
      subjectA,
      overlayOf(subjectA, {
        shop: { restrictions: { riskTierRaise: { 'shop.export': 'hitl' } } },
      }),
    );
    const result = await composeL2(l2Port(tmp, store));
    expect(result.invalidRefs ?? []).not.toContain('shop.export');
    // 本轮 feature=f 不含该工具：条目不参与本轮合并，但不落审计噪音。
    expect(result.effectiveTools?.map((tool) => tool.toolId)).not.toContain('shop.export');
  });
});

describe('"*" 全局作用域注入', () => {
  const tmp = shopSnapshot();

  it('无 pack 站点（packId=null）时全局规则仍注入（正常）', async () => {
    const store = new MemoryUserConfigStore();
    store.seed(
      subjectA,
      overlayOf(subjectA, {
        '*': { rules: [entry('r-global-1', '所有回复使用敬语。')] },
      }),
    );
    const result = await composeL2(l2Port(tmp, store), {
      sessionId: 's1',
      packId: null,
      featureId: null,
      subject: subjectA,
    });
    const rules = entriesText(result.userRules);
    expect(rules).toContain('所有回复使用敬语。');
    expect(rules).toContain('r-global-1');
  });

  it('全局规则先于 pack 级规则注入（边界：注入序）', async () => {
    const store = new MemoryUserConfigStore();
    store.seed(
      subjectA,
      overlayOf(subjectA, {
        '*': { rules: [entry('r-global-1', '所有回复使用敬语。')] },
        shop: { rules: [entry('r-shop-1', '报价引用运费模板。')] },
      }),
    );
    const port = l2Port(tmp, store);
    const result = await composeL2(port);
    const rules = entriesText(result.userRules);
    expect(rules).toContain('所有回复使用敬语。');
    expect(rules).toContain('报价引用运费模板。');
    expect(rules.indexOf('所有回复使用敬语。')).toBeLessThan(rules.indexOf('报价引用运费模板。'));
    const description = await port.describeInjection(composeShop);
    const ruleBlockIds = description.blocks
      .filter((block) => block.kind === 'user-rules')
      .map((block) => block.id);
    expect(ruleBlockIds).toEqual(['r-global-1', 'r-shop-1']);
  });
});

describe('L2 featureId 过滤（缺省=整 pack 生效）', () => {
  const tmp = shopSnapshot();

  it('featureId 匹配与缺省条目注入；不匹配条目不注入', async () => {
    const store = new MemoryUserConfigStore();
    store.seed(
      subjectA,
      overlayOf(subjectA, {
        shop: {
          rules: [
            entry('r-pack-wide', '整 pack 生效的规则。'),
            entry('r-feat-match', '仅 f 功能生效的规则。', 'f'),
            entry('r-feat-other', '其它功能才生效的规则。', 'other-feature'),
          ],
        },
      }),
    );
    const result = await composeL2(l2Port(tmp, store));
    const rules = entriesText(result.userRules);
    expect(rules).toContain('整 pack 生效的规则。');
    expect(rules).toContain('仅 f 功能生效的规则。');
    expect(rules).not.toContain('其它功能才生效的规则。');
  });
});

describe('L2 enabled:false → 该 pack 按未激活装配（回落仅基座）', () => {
  const tmp = shopSnapshot();

  it('featureRules/facts/tools/skills 全部回落', async () => {
    const store = new MemoryUserConfigStore();
    store.seed(subjectA, overlayOf(subjectA, { shop: { enabled: false } }));
    const result = await composeL2(l2Port(tmp, store));
    expect(result.featureRules).toBeNull();
    expect(result.facts).toBeNull();
    expect(result.tools).toEqual([]);
    expect(result.skills).toEqual([]);
  });
});

describe('revision 定格与两视图同源（R4 三方互证）', () => {
  const tmp = shopSnapshot();

  it('compose.userConfigRevision === describeInjection 同源值；effectiveTools 与 description.tools 同值', async () => {
    const store = new MemoryUserConfigStore();
    store.seed(
      subjectA,
      overlayOf(subjectA, {
        shop: { restrictions: { riskTierRaise: { 'shop.list': 'hitl' } } },
      }),
    );
    const port = l2Port(tmp, store);
    const result = await composeL2(port);
    const description = await port.describeInjection(composeShop);
    expect(result.userConfigRevision).toBeDefined();
    expect(description.userConfigRevision).toBe(result.userConfigRevision);
    expect(description.tools).toEqual(result.effectiveTools);
  });

  it('空 overlay 的 revision 稳定（边界：两次 compose 同值 = sha256("null")）', async () => {
    const port = l2Port(tmp, new MemoryUserConfigStore());
    const first = await composeL2(port);
    const second = await composeL2(port);
    expect(first.userConfigRevision).toBe(revisionOf(null));
    expect(second.userConfigRevision).toBe(first.userConfigRevision);
  });

  it('未注入 store 时 compose 携 subject 仍纯 L1 装配（回归锚）', async () => {
    const result = await composeL2(l2Port(tmp));
    expect(result.featureRules).toContain('L1 功能规则');
    expect(result.userConfigRevision).toBeUndefined();
    expect(result.userRules).toBeUndefined();
  });
});

describe('双用户隔离（subject 维度）', () => {
  const tmp = shopSnapshot();

  it('subject A 的规则不出现在 subject B 的装配；revision 各自独立', async () => {
    const store = new MemoryUserConfigStore();
    store.seed(
      subjectA,
      overlayOf(subjectA, { shop: { rules: [entry('r-a-1', 'A 的私有规则。')] } }),
    );
    const port = l2Port(tmp, store);
    const forA = await composeL2(port);
    const forB = await composeL2(port, { ...composeShop, subject: subjectB });
    expect(entriesText(forA.userRules)).toContain('A 的私有规则。');
    expect(entriesText(forB.userRules)).not.toContain('A 的私有规则。');
    expect(forB.userConfigRevision).toBe(revisionOf(null));
    expect(forA.userConfigRevision).not.toBe(forB.userConfigRevision);
  });
});

describe('存储故障语义（adr-014 §6：按数据类别拆分）', () => {
  const tmp = shopSnapshot();

  it('read throw（无缓存）→ rules/facts fail-open 纯 L1 + 工具面全 forbidden（U7 不放宽）+ degraded 标注', async () => {
    const result = await composeL2(l2Port(tmp, new ThrowingUserConfigStore()));
    expect(result.featureRules).toContain('L1 功能规则');
    // ComposeResult 契约：读失败 fail-open 时 userRules 缺省（无任何 L2 文本注入）。
    expect(result.userRules).toBeUndefined();
    expect(result.userConfigDegraded).toBe('fail-open-closed');
    // 可见工具面清空：agent 不在注定失败的调用上空转；descriptors 保留全量 forbidden 作幻觉调用拒绝数据源。
    expect(result.tools).toEqual([]);
    expect(result.effectiveTools?.length).toBeGreaterThan(0);
    for (const tool of result.effectiveTools ?? []) {
      expect(tool.effectiveTier).toBe('forbidden');
      expect(tool.tightenedBy).toBe('storage-failure');
    }
  });

  it('stale 降级 → 正常用 lastGood 合并 + userConfigStale 标注', async () => {
    const lastGood = overlayOf(subjectA, {
      shop: {
        rules: [entry('r-stale-1', '缓存里的规则。')],
        restrictions: { riskTierRaise: { 'shop.list': 'hitl' } },
      },
    });
    const result = await composeL2(l2Port(tmp, new StaleUserConfigStore(lastGood)));
    expect(result.userConfigStale).toBe(true);
    expect(entriesText(result.userRules)).toContain('缓存里的规则。');
    expect(toolOf(result, 'shop.list').effectiveTier).toBe('hitl');
    expect(result.userConfigRevision).toBe(revisionOf(lastGood));
  });
});

describe('注入序与来源标注（L0 → L1 → L2 全局 → L2 pack → skills）', () => {
  const tmp = shopSnapshot();

  it('user-rules 在 feature-rules 之后、skill 之前；L0/L1/L2 origin 逐段标注', async () => {
    const store = new MemoryUserConfigStore();
    store.seed(
      subjectA,
      overlayOf(subjectA, {
        '*': { rules: [entry('r-global-1', '所有回复使用敬语。')] },
        shop: { rules: [entry('r-shop-1', '报价引用运费模板。')] },
      }),
    );
    const description = await l2Port(tmp, store).describeInjection(composeShop);
    const blocks = description.blocks;
    const kinds = blocks.map((block) => block.kind);

    const featureRulesAt = kinds.indexOf('feature-rules');
    const firstUserRulesAt = kinds.indexOf('user-rules');
    const lastUserRulesAt = kinds.lastIndexOf('user-rules');
    const firstSkillAt = kinds.indexOf('skill');
    expect(featureRulesAt).toBeGreaterThanOrEqual(0);
    expect(firstUserRulesAt).toBeGreaterThan(featureRulesAt);
    expect(firstSkillAt).toBeGreaterThan(lastUserRulesAt);

    expect(blocks.find((block) => block.kind === 'system-prompt')?.origin).toBe('L0');
    expect(blocks.find((block) => block.kind === 'feature-rules')?.origin).toBe('L1');
    expect(blocks.find((block) => block.kind === 'facts')?.origin).toBe('L1');
    for (const block of blocks.filter((item) => item.kind === 'user-rules')) {
      expect(block.origin).toBe('L2');
      expect(block.id).toBeDefined();
    }
  });
});
