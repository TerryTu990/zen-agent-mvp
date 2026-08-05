// @vitest-environment jsdom
/**
 * 注入透明视图（R4「来源可追溯」/R6「如实呈现」的界面落点）：以 GET /v1/sessions/:id/injection
 * 响应为唯一数据源渲染 L0/L1/L2 分层——插件零推断、零补齐，服务端未给的字段一律不展示。
 * 类名前缀 .za-injection-*，与 sidepanel 既有卡片令牌同源。
 */
import { describe, expect, it } from 'vitest';
import { renderInjectionView, type InjectionDescriptionView } from '../src/injection-view.js';

function container(): HTMLElement {
  const el = document.createElement('div');
  document.body.append(el);
  return el;
}

function description(overrides: Partial<InjectionDescriptionView> = {}): InjectionDescriptionView {
  return {
    snapshotVersion: '1.3.0',
    packId: 'xianyu-seller',
    featureId: 'xianyu-orders',
    packName: '闲鱼卖家',
    packVersion: '0.9.0',
    packSource: 'official',
    featureTitle: '订单管理',
    userConfigRevision: 'a1b2c3d4e5f6',
    blocks: [
      { kind: 'system-prompt', bytes: 4096, origin: 'L0' },
      { kind: 'feature-rules', id: 'xianyu-orders', bytes: 2048, origin: 'L1' },
      { kind: 'facts', id: 'xianyu-orders', bytes: 1024, origin: 'L1' },
      { kind: 'user-rules', id: 'r-l2-1', bytes: 64, origin: 'L2' },
      { kind: 'user-facts', id: 'f-l2-1', bytes: 32, origin: 'L2' },
    ],
    toolIds: ['xianyu-orders.page-operate', 'xianyu-shipping.execute-intent'],
    tools: [
      {
        toolId: 'xianyu-orders.page-operate',
        baseTier: 'auto',
        effectiveTier: 'hitl',
        origin: 'L1',
        tightenedBy: 'xianyu-seller',
      },
      {
        toolId: 'xianyu-shipping.execute-intent',
        baseTier: 'hitl',
        effectiveTier: 'hitl',
        origin: 'L1',
      },
    ],
    ...overrides,
  };
}

function layers(root: HTMLElement): string[] {
  return [...root.querySelectorAll('.za-injection-layer')].map(
    (el) => el.getAttribute('data-za-layer') ?? '',
  );
}

function toolRow(root: HTMLElement, toolId: string): HTMLElement {
  const row = root.querySelector<HTMLElement>(`.za-injection-tool[data-za-tool-id="${toolId}"]`);
  expect(row, `缺少工具行 ${toolId}`).not.toBeNull();
  return row!;
}

describe('注入透明视图分层渲染（L0/L1/L2 逐 block 可见）', () => {
  it('三层分区按 L0→L1→L2 顺序渲染', () => {
    const root = container();
    renderInjectionView(root, description());
    expect(layers(root)).toEqual(['L0', 'L1', 'L2']);
  });

  it('逐 block 展示 kind、id 与字节数，并带来源徽章', () => {
    const root = container();
    renderInjectionView(root, description());

    const blocks = [...root.querySelectorAll<HTMLElement>('.za-injection-block')];
    expect(blocks).toHaveLength(5);
    expect(blocks.map((el) => el.getAttribute('data-za-block-kind'))).toEqual([
      'system-prompt',
      'feature-rules',
      'facts',
      'user-rules',
      'user-facts',
    ]);

    const userRule = root.querySelector<HTMLElement>('.za-injection-block[data-za-block-id="r-l2-1"]');
    expect(userRule).not.toBeNull();
    expect(userRule!.querySelector('.za-injection-origin')?.textContent).toContain('L2');
    expect(userRule!.querySelector('.za-injection-bytes')?.textContent).toContain('64');
  });

  it('L2 分区归集个人规则/事实 block（origin=L2 不落入 L1 分区）', () => {
    const root = container();
    renderInjectionView(root, description());

    const l2 = root.querySelector<HTMLElement>('.za-injection-layer[data-za-layer="L2"]')!;
    expect([...l2.querySelectorAll('.za-injection-block')].map((el) => el.getAttribute('data-za-block-id'))).toEqual([
      'r-l2-1',
      'f-l2-1',
    ]);
    const l1 = root.querySelector<HTMLElement>('.za-injection-layer[data-za-layer="L1"]')!;
    expect(l1.textContent).not.toContain('r-l2-1');
  });
});

describe('pack 徽章与 revision（R4 来源可追溯）', () => {
  it('pack 徽章展示人读名 · 版本 · 来源', () => {
    const root = container();
    renderInjectionView(root, description());

    const badge = root.querySelector('.za-injection-pack');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toContain('闲鱼卖家');
    expect(badge!.textContent).toContain('0.9.0');
    expect(badge!.textContent).toContain('官方');
  });

  it('packName 缺省时回退 packId（不伪造人读名）', () => {
    const root = container();
    renderInjectionView(root, description({ packName: undefined }));
    const badge = root.querySelector('.za-injection-pack')!;
    expect(badge.textContent).toContain('xianyu-seller');
  });

  it('社区/自建来源以人读徽章文案呈现', () => {
    const root = container();
    renderInjectionView(root, description({ packSource: 'community' }));
    expect(root.querySelector('.za-injection-pack')?.textContent).toContain('社区');

    const local = container();
    renderInjectionView(local, description({ packSource: 'local' }));
    expect(local.querySelector('.za-injection-pack')?.textContent).toContain('自建');
  });

  it('userConfigRevision 可见（与审计/工具判定三方互证）', () => {
    const root = container();
    renderInjectionView(root, description());
    expect(root.querySelector('.za-injection-revision')?.textContent).toContain('a1b2c3d4e5f6');
  });
});

describe('工具面收紧展示（baseTier → effectiveTier）', () => {
  it('被收紧的工具展示原档位、生效档位与收紧来源', () => {
    const root = container();
    renderInjectionView(root, description());

    const row = toolRow(root, 'xianyu-orders.page-operate');
    expect(row.querySelector('.za-injection-tier-base')?.textContent).toContain('auto');
    expect(row.querySelector('.za-injection-tier-effective')?.textContent).toContain('hitl');
    expect(row.textContent).toContain('→');
    expect(row.querySelector('.za-injection-tightened-by')?.textContent).toContain('xianyu-seller');
  });

  it('未收紧的工具不展示箭头与收紧来源（如实呈现，不制造收紧假象）', () => {
    const root = container();
    renderInjectionView(root, description());

    const row = toolRow(root, 'xianyu-shipping.execute-intent');
    expect(row.querySelector('.za-injection-tightened-by')).toBeNull();
    expect(row.textContent).not.toContain('→');
  });

  it('存储故障降级（tightenedBy=storage-failure）以人读文案标注，不冒充某个 pack 收紧', () => {
    const root = container();
    renderInjectionView(
      root,
      description({
        tools: [
          {
            toolId: 'xianyu-orders.page-operate',
            baseTier: 'auto',
            effectiveTier: 'forbidden',
            origin: 'L1',
            tightenedBy: 'storage-failure',
          },
        ],
      }),
    );

    const row = toolRow(root, 'xianyu-orders.page-operate');
    expect(row.querySelector('.za-injection-tightened-by')?.textContent).toContain('存储故障');
    expect(row.querySelector('.za-injection-tier-effective')?.textContent).toContain('forbidden');
  });

  it('降级轮真实形态（可见面为空、逐项全禁）仍逐条列出工具并说明原因，不静默留白', () => {
    const root = container();
    renderInjectionView(
      root,
      description({
        toolIds: [],
        userConfigRevision: undefined,
        // 降级轮 L2 注入段为空（rules/facts 读不到）：L2 分区须由收紧标注独立撑起，不靠遗留 block。
        blocks: [
          { kind: 'system-prompt', bytes: 4096, origin: 'L0' },
          { kind: 'feature-rules', id: 'xianyu-orders', bytes: 2048, origin: 'L1' },
        ],
        tools: [
          {
            toolId: 'xianyu-orders.page-operate',
            baseTier: 'auto',
            effectiveTier: 'forbidden',
            origin: 'L1',
            tightenedBy: 'storage-failure',
          },
          {
            toolId: 'xianyu-shipping.execute-intent',
            baseTier: 'hitl',
            effectiveTier: 'forbidden',
            origin: 'L1',
            tightenedBy: 'storage-failure',
          },
        ],
      }),
    );

    expect(root.querySelectorAll('.za-injection-tool')).toHaveLength(2);
    const row = toolRow(root, 'xianyu-orders.page-operate');
    expect(row.dataset['zaToolUnavailable']).toBe('true');
    expect(row.querySelector('.za-injection-tool-unavailable')?.textContent).toBe('本轮不可用');
    expect(row.querySelector('.za-injection-tightened-by')?.textContent).toContain('存储故障');
    expect(root.querySelector('.za-injection-degraded')?.textContent).toContain('个人定制读取失败');
    const l2 = root.querySelector('.za-injection-layer[data-za-layer="L2"]');
    expect(l2).not.toBeNull();
    expect(l2!.querySelector('.za-injection-layer-empty')?.textContent).toContain('未被清空');
  });

  it('用户长期关停的工具不说成「本轮不可用」，且基线本就禁止的工具不标收紧来源', () => {
    const root = container();
    renderInjectionView(
      root,
      description({
        toolIds: [],
        tools: [
          {
            toolId: 'xianyu-orders.page-operate',
            baseTier: 'auto',
            effectiveTier: 'forbidden',
            origin: 'L1',
            tightenedBy: 'xianyu-seller',
          },
          {
            toolId: 'xianyu-orders.purge-orders',
            baseTier: 'forbidden',
            effectiveTier: 'forbidden',
            origin: 'L1',
            tightenedBy: 'storage-failure',
          },
        ],
      }),
    );

    const disabled = toolRow(root, 'xianyu-orders.page-operate');
    expect(disabled.querySelector('.za-injection-tool-unavailable')?.textContent).toBe('已被你的定制关闭');
    expect(disabled.querySelector('.za-injection-tightened-by')?.textContent).toContain('xianyu-seller');

    const alwaysForbidden = toolRow(root, 'xianyu-orders.purge-orders');
    expect(alwaysForbidden.querySelector('.za-injection-tightened-by')).toBeNull();
    expect(alwaysForbidden.querySelector('.za-injection-tool-unavailable')?.textContent).toBe('一直不可用');
  });
});

describe('边界与降级形态', () => {
  it('无 L2 参与（无 L2 block、无 revision、无收紧）时不渲染 L2 分区', () => {
    const root = container();
    renderInjectionView(
      root,
      description({
        blocks: [
          { kind: 'system-prompt', bytes: 4096, origin: 'L0' },
          { kind: 'feature-rules', id: 'xianyu-orders', bytes: 2048, origin: 'L1' },
        ],
        userConfigRevision: undefined,
        tools: [
          { toolId: 'xianyu-orders.page-operate', baseTier: 'hitl', effectiveTier: 'hitl', origin: 'L1' },
        ],
      }),
    );

    expect(layers(root)).toEqual(['L0', 'L1']);
    expect(root.querySelector('.za-injection-layer[data-za-layer="L2"]')).toBeNull();
    expect(root.querySelector('.za-injection-revision')).toBeNull();
  });

  it('仅基座（packId=null）时不渲染 pack 徽章与 L1 分区', () => {
    const root = container();
    renderInjectionView(
      root,
      description({
        packId: null,
        featureId: null,
        packName: undefined,
        packVersion: undefined,
        packSource: undefined,
        featureTitle: undefined,
        userConfigRevision: undefined,
        blocks: [{ kind: 'system-prompt', bytes: 4096, origin: 'L0' }],
        toolIds: [],
        tools: [],
      }),
    );

    expect(layers(root)).toEqual(['L0']);
    expect(root.querySelector('.za-injection-pack')).toBeNull();
  });

  it('用户关停 pack 的轮次（packId=null + disabledPackId）如实呈现「已关停」而非「无站点包」', () => {
    const root = container();
    renderInjectionView(
      root,
      description({
        packId: null,
        featureId: null,
        packName: undefined,
        packVersion: undefined,
        packSource: undefined,
        featureTitle: undefined,
        disabledPackId: 'xianyu-seller',
        blocks: [{ kind: 'system-prompt', bytes: 4096, origin: 'L0' }],
        toolIds: [],
        tools: [],
      }),
    );

    const disabled = root.querySelector('.za-injection-disabled-pack');
    expect(disabled).not.toBeNull();
    expect(disabled!.textContent).toContain('xianyu-seller');
    expect(disabled!.textContent).toContain('已关停');
  });

  it('重复渲染同一容器为替换而非追加（面板切轮次不叠加旧视图）', () => {
    const root = container();
    renderInjectionView(root, description());
    renderInjectionView(root, description());

    expect(root.querySelectorAll('.za-injection-layer[data-za-layer="L1"]')).toHaveLength(1);
    expect(root.querySelectorAll('.za-injection-block')).toHaveLength(5);
  });

  it('缺 tools 字段（legacy 产出）时只列 toolIds，不伪造 baseTier', () => {
    const root = container();
    renderInjectionView(root, description({ tools: undefined }));

    const row = toolRow(root, 'xianyu-orders.page-operate');
    expect(row.querySelector('.za-injection-tier-base')).toBeNull();
    expect(row.querySelector('.za-injection-tier-effective')).toBeNull();
  });
});
