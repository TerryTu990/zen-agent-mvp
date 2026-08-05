// @vitest-environment jsdom
/**
 * 配置中心四页（站点包 / 个人定制 / 自动化 / 全局设置）：同一 options 页内的 tab 切换。
 * 治理语义机械体现：R1 只收紧（低于 baseTier 的档位在 UI 层不可选、周期不得低于 pack 预设）、
 * R4 逐条来源可追溯、R6 未实现能力如实呈现为禁用占位；令牌值不入 DOM（SEC-04）。
 * 读写链路：GET /v1/packs + GET /v1/user-config → 待保存态 → PUT /v1/user-config?expectedRevision=。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  describeSaveFailure,
  isTierSelectable,
  minPeriodMinutes,
  mountConfigCenter,
  type ConfigCenterDeps,
  type ConfigCenterHandle,
  type PackView,
  type UserOverlayView,
} from '../src/config-center.js';

const SUBJECT = { tenant: 'demo-tenant', hostUserId: 'host-u1' };
/** 轮换场景的另一枚假值（非真实凭证，只用于断言请求头随保存即时更新）。 */
const ROTATED_FIXTURE = 'eyJ-fake-rotated-value';
const AUTH_TOKEN = 'eyJ-fake-token-for-dom-leak-assertion';

const PACKS: PackView[] = [
  {
    packId: 'host-demo',
    name: '订单演示',
    version: '0.2.0',
    source: 'official',
    summary: '订单管理演示站点',
    origin: 'http://127.0.0.1:4173',
    locations: ['/'],
    features: [
      { featureId: 'order-list', title: '订单列表' },
      { featureId: 'order-detail' },
    ],
    tools: [
      { toolId: 'order-list.cancel-order', baseTier: 'hitl', description: '取消一笔待发货订单。' },
      { toolId: 'order-list.refresh-orders', baseTier: 'auto', description: '刷新订单列表。' },
      { toolId: 'order-list.purge-orders', baseTier: 'forbidden', description: '清空全部订单。' },
    ],
    automations: [{ id: 'demo-scan', defaultPeriodMinutes: 5 }],
  },
  {
    packId: 'local-crm',
    version: '0.1.0',
    source: 'local',
    origin: 'http://crm.internal.example',
    features: [{ featureId: 'crm-notes' }],
    tools: [],
    automations: [],
  },
];

function overlayFixture(): UserOverlayView {
  return {
    schemaVersion: 1,
    subject: SUBJECT,
    packs: {
      '*': {
        rules: [
          {
            id: 'r-global',
            text: '所有回复使用敬语。',
            origin: 'manual',
            createdAt: '2026-08-01T00:00:00.000Z',
          },
        ],
      },
      'host-demo': {
        rules: [
          {
            id: 'r-1',
            text: '议价统一回复：满 50 包邮。',
            origin: 'teach',
            sourceSessionId: 's-1',
            featureId: 'order-list',
            createdAt: '2026-08-02T00:00:00.000Z',
          },
        ],
        restrictions: { riskTierRaise: { 'order-list.cancel-order': 'forbidden' } },
      },
    },
  };
}

interface FetchCall {
  url: string;
  method: string;
  body?: Record<string, unknown>;
  authorization?: string;
}

interface StubResponse {
  status: number;
  body: unknown;
}

interface Harness {
  root: HTMLElement;
  deps: ConfigCenterDeps;
  calls: FetchCall[];
  putQueue: StubResponse[];
  /** 服务端当前态：409 后的自动重载读到的就是此对象。 */
  stored: { overlay: UserOverlayView | null; revision: string; subject: typeof SUBJECT };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function createHarness(overrides: Partial<ConfigCenterDeps> = {}): Harness {
  const root = document.createElement('main');
  document.body.replaceChildren(root);
  const calls: FetchCall[] = [];
  const putQueue: StubResponse[] = [];
  const stored: Harness['stored'] = { overlay: overlayFixture(), revision: 'rev-1', subject: SUBJECT };

  const fetchStub: ConfigCenterDeps['fetch'] = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const rawBody = init?.body;
    const authorization = (init?.headers as Record<string, string> | undefined)?.['authorization'];
    calls.push({
      url,
      method,
      ...(typeof rawBody === 'string' ? { body: JSON.parse(rawBody) as Record<string, unknown> } : {}),
      ...(authorization !== undefined ? { authorization } : {}),
    });
    // 鉴权按真实语义判定：无有效 Bearer 一律 401——首装/令牌过期路径据此可测。
    if (authorization === undefined || authorization === 'Bearer ') {
      return jsonResponse(401, { error: '身份校验未通过' });
    }
    if (url.includes('/v1/packs')) return jsonResponse(200, { packs: PACKS });
    if (url.includes('/v1/user-config') && method === 'GET') return jsonResponse(200, stored);
    if (url.includes('/v1/user-config') && method === 'PUT') {
      const next = putQueue.shift() ?? { status: 200, body: { revision: 'rev-2' } };
      if (next.status === 200) {
        stored.overlay = (calls[calls.length - 1]!.body ?? null) as UserOverlayView | null;
        stored.revision = (next.body as { revision: string }).revision;
      }
      return jsonResponse(next.status, next.body);
    }
    return jsonResponse(404, { error: '未知路由' });
  };

  const deps: ConfigCenterDeps = {
    fetch: fetchStub,
    baseUrl: 'http://127.0.0.1:8787',
    authToken: AUTH_TOKEN,
    tokenConfigured: true,
    serverBaseUrl: 'http://127.0.0.1:8787',
    saveSettings: async () => undefined,
    ...overrides,
  };
  return { root, deps, calls, putQueue, stored };
}

async function mounted(harness: Harness): Promise<ConfigCenterHandle> {
  const handle = mountConfigCenter(harness.root, harness.deps);
  await handle.ready;
  return handle;
}

function panel(root: HTMLElement, tab: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`.za-cc-panel[data-za-panel="${tab}"]`);
  expect(el, `缺少 ${tab} 面板`).not.toBeNull();
  return el!;
}

function putCalls(harness: Harness): FetchCall[] {
  return harness.calls.filter((call) => call.method === 'PUT');
}

function lastPutOverlay(harness: Harness): UserOverlayView {
  const puts = putCalls(harness);
  expect(puts.length).toBeGreaterThan(0);
  return puts[puts.length - 1]!.body as unknown as UserOverlayView;
}

function setValue(input: HTMLInputElement | HTMLSelectElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('纯逻辑：R1 只收紧的机械判定', () => {
  it('低于 pack 默认档位的选项不可选，等于/高于可选', () => {
    expect(isTierSelectable('hitl', 'auto')).toBe(false);
    expect(isTierSelectable('hitl', 'hitl')).toBe(true);
    expect(isTierSelectable('hitl', 'forbidden')).toBe(true);
    expect(isTierSelectable('auto', 'auto')).toBe(true);
    expect(isTierSelectable('forbidden', 'hitl')).toBe(false);
    expect(isTierSelectable('forbidden', 'forbidden')).toBe(true);
  });

  it('周期下限恒为 max(pack 预设, 平台下限 1)', () => {
    expect(minPeriodMinutes(5)).toBe(5);
    expect(minPeriodMinutes(undefined)).toBe(1);
    expect(minPeriodMinutes(0)).toBe(1);
  });

  it('保存失败文案：409 提示重载、400 呈现服务端 issues（不吞错误）', () => {
    expect(describeSaveFailure(409, { error: 'revision 不符' })).toContain('已重新加载');
    const message = describeSaveFailure(400, {
      error: 'overlay 未通过写入期校验',
      issues: [
        {
          path: '/packs/host-demo/restrictions/riskTierRaise/order-list.cancel-order',
          message: '声明分级 "auto" 低于 L1 基线 "hitl"，只收紧不放宽，写入期拒绝',
        },
      ],
    });
    expect(message).toContain('只收紧不放宽');
    expect(message).toContain('order-list.cancel-order');
  });
});

describe('四页 tab 切换', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = createHarness();
  });

  it('四个入口齐备，缺省展示站点包页，其余面板隐藏', async () => {
    await mounted(harness);
    const tabs = [...harness.root.querySelectorAll('.za-cc-nav-item')].map((el) =>
      el.getAttribute('data-za-tab'),
    );
    expect(tabs).toEqual(['packs', 'overlay', 'automation', 'global']);
    expect(harness.root.textContent).toContain('站点包');
    expect(harness.root.textContent).toContain('个人定制');
    expect(harness.root.textContent).toContain('自动化');
    expect(harness.root.textContent).toContain('全局设置');

    expect(panel(harness.root, 'packs').hidden).toBe(false);
    for (const tab of ['overlay', 'automation', 'global']) {
      expect(panel(harness.root, tab).hidden).toBe(true);
    }
  });

  it('点击导航项切换可见面板（互斥）', async () => {
    await mounted(harness);
    harness.root
      .querySelector<HTMLElement>('.za-cc-nav-item[data-za-tab="automation"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(panel(harness.root, 'automation').hidden).toBe(false);
    expect(panel(harness.root, 'packs').hidden).toBe(true);
  });
});

describe('站点包页（L1 自描述 + 启停）', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = createHarness();
  });

  it('逐 pack 卡片渲染人读名/版本/来源徽章/站点 origin/功能与工具计数', async () => {
    await mounted(harness);
    const card = panel(harness.root, 'packs').querySelector<HTMLElement>(
      '.za-cc-pack[data-za-pack-id="host-demo"]',
    )!;
    expect(card).not.toBeNull();
    expect(card.querySelector('.za-cc-pack-name')?.textContent).toContain('订单演示');
    expect(card.querySelector('.za-cc-pack-version')?.textContent).toContain('0.2.0');
    expect(card.querySelector('.za-cc-badge-source')?.textContent).toContain('官方');
    expect(card.querySelector('.za-cc-pack-origin')?.textContent).toContain('http://127.0.0.1:4173');
    expect(card.querySelector('.za-cc-pack-features')?.textContent).toContain('2');
    expect(card.querySelector('.za-cc-pack-tools')?.textContent).toContain('3');
  });

  it('未声明 name 的 pack 回退展示 packId，自建来源徽章为「自建」', async () => {
    await mounted(harness);
    const card = harness.root.querySelector<HTMLElement>('.za-cc-pack[data-za-pack-id="local-crm"]')!;
    expect(card.querySelector('.za-cc-pack-name')?.textContent).toContain('local-crm');
    expect(card.querySelector('.za-cc-badge-source')?.textContent).toContain('自建');
  });

  it('关停开关产生待保存态 packs[packId].enabled=false', async () => {
    const handle = await mounted(harness);
    const toggle = harness.root.querySelector<HTMLInputElement>(
      '.za-cc-pack[data-za-pack-id="host-demo"] .za-cc-pack-toggle',
    )!;
    expect(toggle.checked).toBe(true);
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));

    await handle.save();
    expect(lastPutOverlay(harness).packs['host-demo']?.enabled).toBe(false);
  });

  it('重新启用后不再下发 enabled 键（缺省即启用，不写 true）', async () => {
    const handle = await mounted(harness);
    const toggle = harness.root.querySelector<HTMLInputElement>(
      '.za-cc-pack[data-za-pack-id="host-demo"] .za-cc-pack-toggle',
    )!;
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));

    await handle.save();
    expect(lastPutOverlay(harness).packs['host-demo']).not.toHaveProperty('enabled');
  });

  it('P3.5 未实现能力（导入/社区浏览/导出）显示为禁用占位，不做假跳转', async () => {
    await mounted(harness);
    const placeholders = [
      ...panel(harness.root, 'packs').querySelectorAll<HTMLElement>('.za-cc-unavailable'),
    ];
    expect(placeholders.length).toBeGreaterThanOrEqual(3);
    for (const el of placeholders) {
      expect((el as HTMLButtonElement).disabled).toBe(true);
      expect(el.getAttribute('href')).toBeNull();
    }
    const text = placeholders.map((el) => el.textContent ?? '').join(' ');
    expect(text).toContain('导入');
    expect(text).toContain('社区');
    expect(text).toContain('导出');
  });
});

describe('个人定制页（规则清单 + 收紧矩阵 + 全局作用域）', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = createHarness();
  });

  it('规则逐条展示文本、来源徽章、作用域与创建时间，并带删除入口', async () => {
    await mounted(harness);
    const row = panel(harness.root, 'overlay').querySelector<HTMLElement>(
      '.za-cc-rule[data-za-rule-id="r-1"]',
    )!;
    expect(row).not.toBeNull();
    expect(row.querySelector('.za-cc-rule-text')?.textContent).toContain('议价统一回复：满 50 包邮。');
    expect(row.querySelector('.za-cc-badge-origin')?.textContent).toContain('对话沉淀');
    expect(row.querySelector('.za-cc-rule-scope')?.textContent).toContain('订单演示');
    expect(row.querySelector('.za-cc-rule-scope')?.textContent).toContain('订单列表');
    expect(row.querySelector('.za-cc-rule-created')?.textContent).toContain('2026-08-02');
    expect(row.querySelector('.za-cc-rule-delete')).not.toBeNull();
  });

  it('手动来源规则徽章为「手动添加」，"*" 作用域展示为全部站点且无收紧矩阵', async () => {
    await mounted(harness);
    const scope = panel(harness.root, 'overlay').querySelector<HTMLElement>(
      '.za-cc-scope[data-za-scope="*"]',
    )!;
    expect(scope).not.toBeNull();
    expect(scope.textContent).toContain('全部站点');
    expect(scope.querySelector('.za-cc-rule[data-za-rule-id="r-global"] .za-cc-badge-origin')?.textContent).toContain(
      '手动添加',
    );
    expect(scope.querySelector('.za-cc-tier')).toBeNull();
  });

  it('删除规则后该条不再下发（待保存态即时反映）', async () => {
    const handle = await mounted(harness);
    harness.root
      .querySelector<HTMLElement>('.za-cc-rule[data-za-rule-id="r-1"] .za-cc-rule-delete')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(harness.root.querySelector('.za-cc-rule[data-za-rule-id="r-1"]')).toBeNull();
    await handle.save();
    const overlay = lastPutOverlay(harness);
    expect(overlay.packs['host-demo']?.rules ?? []).toHaveLength(0);
  });

  it('收紧矩阵逐工具一行：展示 pack 默认档位，低于默认的档位 option 为 disabled', async () => {
    await mounted(harness);
    const select = panel(harness.root, 'overlay').querySelector<HTMLSelectElement>(
      '.za-cc-tier[data-za-tool-id="order-list.cancel-order"]',
    )!;
    expect(select).not.toBeNull();
    const row = select.closest('.za-cc-tool')!;
    expect(row.querySelector('.za-cc-tool-base')?.textContent).toContain('hitl');

    const options = new Map(
      [...select.options].map((option) => [option.value, option.disabled] as const),
    );
    expect(options.get('auto')).toBe(true);
    expect(options.get('hitl')).toBe(false);
    expect(options.get('forbidden')).toBe(false);
    // 既有 L2 收紧回显为当前生效档位。
    expect(select.value).toBe('forbidden');
  });

  it('baseTier=forbidden 的工具只剩 forbidden 可选（无可收紧空间）', async () => {
    await mounted(harness);
    const select = harness.root.querySelector<HTMLSelectElement>(
      '.za-cc-tier[data-za-tool-id="order-list.purge-orders"]',
    )!;
    expect([...select.options].filter((option) => !option.disabled).map((option) => option.value)).toEqual([
      'forbidden',
    ]);
  });

  it('选择更严档位产生待保存 riskTierRaise；选 forbidden 等价于禁用该工具', async () => {
    const handle = await mounted(harness);
    setValue(
      harness.root.querySelector<HTMLSelectElement>('.za-cc-tier[data-za-tool-id="order-list.refresh-orders"]')!,
      'hitl',
    );
    await handle.save();

    const raise = lastPutOverlay(harness).packs['host-demo']?.restrictions?.riskTierRaise ?? {};
    expect(raise['order-list.refresh-orders']).toBe('hitl');
    expect(raise['order-list.cancel-order']).toBe('forbidden');
  });

  it('档位回到 pack 默认时移除该条收紧（不写等值噪音）', async () => {
    const handle = await mounted(harness);
    setValue(
      harness.root.querySelector<HTMLSelectElement>('.za-cc-tier[data-za-tool-id="order-list.cancel-order"]')!,
      'hitl',
    );
    await handle.save();

    const restrictions = lastPutOverlay(harness).packs['host-demo']?.restrictions;
    expect(restrictions?.riskTierRaise?.['order-list.cancel-order']).toBeUndefined();
  });
});

describe('自动化页（周期偏好写 L2）', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = createHarness();
  });

  it('逐 automation 一行：开关 + 周期输入，min 属性为 pack 预设周期', async () => {
    await mounted(harness);
    const row = panel(harness.root, 'automation').querySelector<HTMLElement>(
      '.za-cc-automation[data-za-automation-id="demo-scan"]',
    )!;
    expect(row).not.toBeNull();
    expect(row.querySelector<HTMLInputElement>('.za-cc-automation-enabled')).not.toBeNull();
    expect(row.querySelector<HTMLInputElement>('.za-cc-automation-minutes')?.min).toBe('5');
  });

  it('周期低于 max(pack 预设, 1) 时禁止提交并提示下限', async () => {
    const handle = await mounted(harness);
    setValue(
      harness.root.querySelector<HTMLInputElement>('.za-cc-automation-minutes[data-za-automation-id="demo-scan"]')!,
      '2',
    );
    await handle.save();

    expect(putCalls(harness)).toHaveLength(0);
    const status = harness.root.querySelector('.za-cc-status')?.textContent ?? '';
    expect(status).toContain('5');
    expect(status).toContain('下限');
  });

  it('合法周期与开关写入 preferences.automations', async () => {
    const handle = await mounted(harness);
    const row = harness.root.querySelector<HTMLElement>(
      '.za-cc-automation[data-za-automation-id="demo-scan"]',
    )!;
    const enabled = row.querySelector<HTMLInputElement>('.za-cc-automation-enabled')!;
    enabled.checked = true;
    enabled.dispatchEvent(new Event('change', { bubbles: true }));
    setValue(row.querySelector<HTMLInputElement>('.za-cc-automation-minutes')!, '10');

    await handle.save();
    expect(lastPutOverlay(harness).packs['host-demo']?.preferences?.automations?.['demo-scan']).toEqual({
      enabled: true,
      minutes: 10,
    });
  });
});

describe('全局设置页（令牌不回显 + verbosity 偏好）', () => {
  it('令牌已配置时只显示状态，输入框与整页 DOM 均不含令牌明文（SEC-04）', async () => {
    const harness = createHarness();
    await mounted(harness);
    const tokenInput = panel(harness.root, 'global').querySelector<HTMLInputElement | HTMLTextAreaElement>(
      '#za-cc-token',
    )!;
    expect(tokenInput).not.toBeNull();
    expect(tokenInput.value).toBe('');
    expect(harness.root.innerHTML).not.toContain(AUTH_TOKEN);
    expect(harness.root.querySelector('.za-cc-token-state')?.textContent).toContain('已配置');
  });

  it('令牌未配置时状态如实呈现为未配置', async () => {
    const harness = createHarness({ tokenConfigured: false, authToken: '' });
    await mounted(harness);
    expect(harness.root.querySelector('.za-cc-token-state')?.textContent).toContain('未配置');
  });

  it('verbosity 选择写入 "*" 作用域偏好', async () => {
    const harness = createHarness();
    const handle = await mounted(harness);
    setValue(harness.root.querySelector<HTMLSelectElement>('.za-cc-verbosity')!, 'concise');
    await handle.save();
    expect(lastPutOverlay(harness).packs['*']?.preferences?.verbosity).toBe('concise');
  });
});

describe('保存链路（乐观并发 + 服务端校验反馈）', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = createHarness();
  });

  it('初次载入并行读取 /v1/packs 与 /v1/user-config，均带鉴权头', async () => {
    await mounted(harness);
    const packsCall = harness.calls.find((call) => call.url.includes('/v1/packs'));
    const configCall = harness.calls.find((call) => call.url.includes('/v1/user-config'));
    expect(packsCall).toBeDefined();
    expect(configCall).toBeDefined();
    // 只断言 Bearer 前缀，不断言令牌值（SEC-04）
    expect(packsCall?.authorization?.startsWith('Bearer ')).toBe(true);
    expect(configCall?.authorization?.startsWith('Bearer ')).toBe(true);
  });

  it('PUT 带 expectedRevision（定格自最近一次读取），body 为完整 overlay 且 subject 与服务端一致', async () => {
    const handle = await mounted(harness);
    await handle.save();

    const put = putCalls(harness)[0]!;
    expect(put.url).toContain('/v1/user-config');
    expect(new URL(put.url).searchParams.get('expectedRevision')).toBe('rev-1');
    const overlay = put.body as unknown as UserOverlayView;
    expect(overlay.schemaVersion).toBe(1);
    expect(overlay.subject).toEqual(SUBJECT);
  });

  it('零定制用户（overlay=null）仍可保存：subject 取自 GET 响应，客户端不臆造归属键', async () => {
    harness.stored.overlay = null;
    const handle = await mounted(harness);
    const toggle = harness.root.querySelector<HTMLInputElement>(
      '.za-cc-pack[data-za-pack-id="host-demo"] .za-cc-pack-toggle',
    )!;
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));

    await handle.save();
    const overlay = lastPutOverlay(harness);
    expect(overlay.subject).toEqual(SUBJECT);
    expect(overlay.packs['host-demo']?.enabled).toBe(false);
  });

  it('409 → 提示配置已在别处更新并自动重载（重新读取后 revision 定格为新值）', async () => {
    const handle = await mounted(harness);
    harness.putQueue.push({ status: 409, body: { error: 'revision 不符' } });
    harness.stored.revision = 'rev-9';

    await handle.save();
    const status = harness.root.querySelector('.za-cc-status')?.textContent ?? '';
    expect(status).toContain('配置已在别处更新');
    expect(status).toContain('已重新加载');

    const getsAfterPut = harness.calls
      .slice(harness.calls.findIndex((call) => call.method === 'PUT'))
      .filter((call) => call.method === 'GET' && call.url.includes('/v1/user-config'));
    expect(getsAfterPut).toHaveLength(1);

    await handle.save();
    expect(new URL(putCalls(harness)[1]!.url).searchParams.get('expectedRevision')).toBe('rev-9');
  });

  it('400 → 逐条展示服务端 issues（不吞错误、不自称已保存）', async () => {
    const handle = await mounted(harness);
    harness.putQueue.push({
      status: 400,
      body: {
        error: 'overlay 未通过写入期校验',
        issues: [
          {
            path: '/packs/host-demo/restrictions/riskTierRaise/order-list.cancel-order',
            message: '声明分级 "auto" 低于 L1 基线 "hitl"，只收紧不放宽，写入期拒绝',
          },
        ],
      },
    });

    await handle.save();
    const status = harness.root.querySelector('.za-cc-status')?.textContent ?? '';
    expect(status).toContain('只收紧不放宽');
    expect(status).not.toContain('已保存');
  });

  it('保存成功后以服务端返回的新 revision 定格下一次写入', async () => {
    const handle = await mounted(harness);
    await handle.save();
    await handle.save();

    const puts = putCalls(harness);
    expect(new URL(puts[0]!.url).searchParams.get('expectedRevision')).toBe('rev-1');
    expect(new URL(puts[1]!.url).searchParams.get('expectedRevision')).toBe('rev-2');
    expect(harness.root.querySelector('.za-cc-status')?.textContent).toContain('已保存');
  });

  it('存储不可用（503）如实提示且不冒充成功', async () => {
    const handle = await mounted(harness);
    harness.putQueue.push({ status: 503, body: { error: '用户配置存储不可用' } });
    await handle.save();
    const status = harness.root.querySelector('.za-cc-status')?.textContent ?? '';
    expect(status).toContain('用户配置存储不可用');
    expect(status).not.toContain('已保存');
  });

  it('首装（无凭证、读取全 401）：填入凭证后保存即落盘并以新凭证重读，一次完成配置', async () => {
    const saved: Array<Record<string, string>> = [];
    const fresh = createHarness({
      authToken: '',
      tokenConfigured: false,
      saveSettings: async (patch) => {
        saved.push(patch as Record<string, string>);
      },
    });
    const handle = await mounted(fresh);
    // 首屏因未鉴权失败，但页面可用且如实说明
    expect(fresh.root.querySelector('.za-cc-status')?.textContent ?? '').not.toContain('已保存');
    const input = fresh.root.querySelector<HTMLInputElement>('#za-cc-token');
    expect(input, '全局设置须有凭证输入框').not.toBeNull();
    input!.value = ROTATED_FIXTURE;
    await handle.save();

    expect(saved).toHaveLength(1);
    expect(Object.values(saved[0]!)).toContain(ROTATED_FIXTURE);
    // 保存后以新凭证重读成功 → 归属键可得 → 个人配置随即提交
    expect(fresh.calls.some((call) => call.authorization === `Bearer ${ROTATED_FIXTURE}`)).toBe(true);
    expect(fresh.root.querySelector('.za-cc-status')?.textContent ?? '').toContain('已保存');
  });

  it('凭证仍无效时：本机设置照样落盘，个人配置如实标注未提交（不静默吞掉用户操作）', async () => {
    const saved: Array<Record<string, string>> = [];
    const unreachable = createHarness({
      authToken: '',
      tokenConfigured: false,
      saveSettings: async (patch) => {
        saved.push(patch as Record<string, string>);
      },
      fetch: async () => jsonResponse(401, { error: '身份校验未通过' }),
    });
    const handle = await mounted(unreachable);
    const input = unreachable.root.querySelector<HTMLInputElement>('#za-cc-token')!;
    input.value = ROTATED_FIXTURE;
    await handle.save();

    expect(saved).toHaveLength(1);
    const status = unreachable.root.querySelector('.za-cc-status')?.textContent ?? '';
    expect(status).toContain('本机设置已保存');
    expect(status).toContain('个人配置未提交');
  });

  it('轮换凭证后同一页面的后续请求即用新值（无需重开）', async () => {
    const fresh = createHarness({ authToken: '', tokenConfigured: false });
    const handle = await mounted(fresh);
    const input = fresh.root.querySelector<HTMLInputElement>('#za-cc-token')!;
    input.value = ROTATED_FIXTURE;
    await handle.save();
    await handle.save();
    const authed = fresh.calls.filter((call) => call.authorization === `Bearer ${ROTATED_FIXTURE}`);
    expect(authed.length).toBeGreaterThan(0);
  });

  it('自动化本机镜像只在 PUT 成功后落盘：保存失败不得让闹钟先跑起来', async () => {
    const mirrored: Array<Record<string, { enabled: boolean; minutes: number }>> = [];
    const withMirror = createHarness({
      localAutomations: {},
      saveAutomations: async (prefs) => {
        mirrored.push(prefs);
      },
    });
    const handle = await mounted(withMirror);
    const toggle = withMirror.root.querySelector<HTMLInputElement>(
      '.za-cc-automation .za-cc-automation-enabled',
    );
    expect(toggle, '自动化页须有启用开关').not.toBeNull();
    toggle!.checked = true;
    toggle!.dispatchEvent(new Event('change', { bubbles: true }));

    withMirror.putQueue.push({ status: 503, body: { error: '用户配置存储不可用' } });
    await handle.save();
    expect(mirrored).toHaveLength(0);

    await handle.save();
    expect(mirrored.length).toBeGreaterThan(0);
  });

  it('周期上界与调度端一致：超界拒绝提交（否则调度端会回落成更密的周期）', async () => {
    const handle = await mounted(harness);
    const minutes = harness.root.querySelector<HTMLInputElement>('.za-cc-automation-minutes');
    expect(minutes, '自动化页须有周期输入').not.toBeNull();
    expect(minutes!.max).toBe('60');
    minutes!.value = '120';
    minutes!.dispatchEvent(new Event('change', { bubbles: true }));

    const before = putCalls(harness).length;
    await handle.save();
    expect(putCalls(harness)).toHaveLength(before);
    expect(harness.root.querySelector('.za-cc-status')?.textContent ?? '').toContain('60');
  });

  it('本机显式暂停的自动化不被 L2 启用态覆盖，并渲染「本机已暂停」', async () => {
    const paused = createHarness({ localAutomations: { 'demo-scan': { enabled: false } } });
    paused.stored.overlay = {
      schemaVersion: 1,
      subject: SUBJECT,
      packs: {
        'host-demo': { preferences: { automations: { 'demo-scan': { enabled: true, minutes: 10 } } } },
      },
    };
    await mounted(paused);
    const row = paused.root.querySelector<HTMLElement>(
      '.za-cc-automation[data-za-automation-id="demo-scan"]',
    );
    expect(row, '自动化行须存在').not.toBeNull();
    const toggle = row!.querySelector<HTMLInputElement>('.za-cc-automation-enabled');
    expect(toggle, '自动化行须有启用开关').not.toBeNull();
    expect(toggle!.checked).toBe(false);
    expect(row!.querySelector('.za-cc-badge-paused')).not.toBeNull();
  });

  it('本机从未配置（键缺省）不得判为已暂停：L2 启用态照常回显', async () => {
    const fresh = createHarness({ localAutomations: { 'demo-scan': {} } });
    fresh.stored.overlay = {
      schemaVersion: 1,
      subject: SUBJECT,
      packs: {
        'host-demo': { preferences: { automations: { 'demo-scan': { enabled: true, minutes: 10 } } } },
      },
    };
    await mounted(fresh);
    const row = fresh.root.querySelector<HTMLElement>(
      '.za-cc-automation[data-za-automation-id="demo-scan"]',
    )!;
    expect(row.querySelector<HTMLInputElement>('.za-cc-automation-enabled')!.checked).toBe(true);
    expect(row.querySelector('.za-cc-badge-paused')).toBeNull();
  });

  it('存量 disabledTools 如实呈现为「已禁用」，零编辑保存不改变任何 restrictions（只收紧不被撤销）', async () => {
    const withDisabled = createHarness();
    withDisabled.stored.overlay = {
      schemaVersion: 1,
      subject: SUBJECT,
      packs: {
        'host-demo': {
          restrictions: { disabledTools: ['order-list.refresh-orders'] },
        },
      },
    };
    const handle = await mounted(withDisabled);
    const select = withDisabled.root.querySelector<HTMLSelectElement>(
      '.za-cc-tool[data-za-tool-id="order-list.refresh-orders"] .za-cc-tier',
    );
    expect(select, '收紧矩阵须有该工具行').not.toBeNull();
    expect(select!.value).toBe('forbidden');

    await handle.save();
    const overlay = lastPutOverlay(withDisabled);
    const scope = overlay.packs['host-demo']!;
    const tier =
      scope.restrictions?.riskTierRaise?.['order-list.refresh-orders'] ??
      (scope.restrictions?.disabledTools?.includes('order-list.refresh-orders') === true
        ? 'forbidden'
        : undefined);
    expect(tier).toBe('forbidden');
  });
});
