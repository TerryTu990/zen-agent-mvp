/**
 * 配置中心站点包页数据源：GET /v1/packs（经 AssemblyPort.listPacks 取数，网关只转发+鉴权）。
 * 输出闭集 = 已安装 pack 的 L1 自描述（人读名/版本/来源/站点围栏/功能/工具面 baseTier/自动化声明），
 * 供 packs 页卡片与个人定制页收紧矩阵渲染；L2 覆盖层不在本端点（读 GET /v1/user-config）。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../src/index.js';

const repoRoot = new URL('../../../', import.meta.url).pathname;
const snapshotRoot = join(repoRoot, 'examples/host-demo/config');
const productionRoot = join(repoRoot, 'assets');
const systemPromptPath = join(repoRoot, 'assets/system-prompt.md');
const AUDIT_SINK = join(mkdtempSync(join(tmpdir(), 'za-packs-audit-')), 'events.jsonl');

const JWT_SECRET = 'za-test-secret';
const SIGNING_SECRET = 'za-test-signing-secret';
const ISS = 'zen-agent-demo';
const key = new TextEncoder().encode(JWT_SECRET);

interface PackFeatureView {
  featureId: string;
  title?: string;
}

interface PackToolView {
  toolId: string;
  baseTier: 'auto' | 'hitl' | 'forbidden';
  description: string;
}

interface PackAutomationView {
  id: string;
  defaultPeriodMinutes?: number;
}

interface PackView {
  packId: string;
  name?: string;
  version: string;
  source: 'official' | 'community' | 'local';
  summary?: string;
  origin?: string;
  locations?: string[];
  generic?: true;
  features: PackFeatureView[];
  tools: PackToolView[];
  automations: PackAutomationView[];
  configSchema?: Record<string, unknown>;
}

function serverOptions(overrides: Record<string, unknown> = {}): Parameters<typeof startServer>[0] {
  return {
    port: 0,
    jwtSecret: JWT_SECRET,
    signingSecret: SIGNING_SECRET,
    issAllowlist: [ISS],
    snapshotRoot,
    systemPromptPath,
    auditSinkPath: AUDIT_SINK,
    allowedProviders: ['openai-compatible'],
    heartbeatMs: 60_000,
    ...overrides,
  } as Parameters<typeof startServer>[0];
}

async function signToken(): Promise<string> {
  return new SignJWT({ tenant: 'demo-tenant', roles: ['ops'], hostUserId: 'host-u1' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('user-1')
    .setIssuer(ISS)
    .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
    .sign(key);
}

async function fetchPacks(base: string, token?: string): Promise<Response> {
  const headers = token === undefined ? {} : { authorization: `Bearer ${token}` };
  return fetch(`${base}/v1/packs`, { headers });
}

let server: RunningServer;
let baseUrl = '';

beforeAll(async () => {
  server = await startServer(serverOptions());
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server?.close();
});

describe('GET /v1/packs（配置中心站点包页 L1 数据源）', () => {
  it('host-demo 快照：packId/version/来源缺省 official/站点围栏/功能清单逐项输出', async () => {
    const response = await fetchPacks(baseUrl, await signToken());
    expect(response.status).toBe(200);
    const body = (await response.json()) as { packs: PackView[] };

    expect(body.packs.map((pack) => pack.packId)).toEqual(['host-demo']);
    const pack = body.packs[0]!;
    expect(pack.version).toBe('0.2.0');
    expect(pack.source).toBe('official');
    expect(pack.summary).toBe('订单管理演示站点：查看订单列表与详情、页面代操作');
    expect(pack.origin).toBe('http://127.0.0.1:4173');
    expect(pack.locations).toEqual(['/']);
    expect(pack.generic).toBeUndefined();
    expect(pack.features.map((feature) => feature.featureId)).toEqual(['order-list', 'order-detail']);
    // host-demo 的 feature.md 无 frontmatter title：人读标题省略，UI 回退 featureId。
    expect(pack.features.every((feature) => feature.title === undefined)).toBe(true);
    // pack.json 未声明 name：人读名省略，packs 页回退 packId（不得由服务端伪造回退值）。
    expect(pack.name).toBeUndefined();
  });

  it('host-demo 快照：工具面逐项 baseTier 与 description（收紧矩阵的 pack 默认档位来源）', async () => {
    const response = await fetchPacks(baseUrl, await signToken());
    const body = (await response.json()) as { packs: PackView[] };
    const pack = body.packs[0]!;

    expect(pack.tools.map((tool) => [tool.toolId, tool.baseTier])).toEqual([
      ['order-list.cancel-order', 'hitl'],
      ['order-list.refresh-orders', 'auto'],
      ['order-list.purge-orders', 'forbidden'],
      ['order-list.page-operate', 'auto'],
    ]);
    expect(pack.tools.every((tool) => typeof tool.description === 'string' && tool.description.length > 0)).toBe(
      true,
    );
    expect(pack.automations).toEqual([]);
  });

  it('生产快照 assets：xianyu-seller 版本/来源/功能/自动化声明如实透出', async () => {
    const srv = await startServer(serverOptions({ snapshotRoot: productionRoot }));
    try {
      const response = await fetchPacks(`http://127.0.0.1:${srv.port}`, await signToken());
      expect(response.status).toBe(200);
      const body = (await response.json()) as { packs: PackView[] };
      const pack = body.packs.find((entry) => entry.packId === 'xianyu-seller');
      expect(pack).toBeDefined();
      expect(pack!.version).toBe('0.9.0');
      // assets/manifest.json 未声明 source → 归一为 official（registry 缺省语义，adr-020 §3）。
      expect(pack!.source).toBe('official');
      // assets/packs/xianyu-seller/pack.json 未声明 name → 省略（不改 assets，UI 回退 packId）。
      expect(pack!.name).toBeUndefined();
      expect(pack!.summary).toBe('闲鱼卖家 PC 端：数据导航、订单识别与受控履约');
      expect(pack!.origin).toBe('https://seller.goofish.com');
      expect(pack!.features.map((feature) => feature.featureId)).toEqual([
        'xianyu-seller-data',
        'xianyu-orders',
        'xianyu-fulfillment',
      ]);
      expect(pack!.automations).toEqual([{ id: 'xianyu-auto-scan', defaultPeriodMinutes: 5 }]);
      expect(pack!.tools.map((tool) => tool.toolId)).toContain('xianyu-orders.page-operate');
      expect(pack!.tools.every((tool) => ['auto', 'hitl', 'forbidden'].includes(tool.baseTier))).toBe(true);
    } finally {
      await srv.close();
    }
  });

  it('未鉴权请求被拒（401）', async () => {
    const response = await fetchPacks(baseUrl);
    expect(response.status).toBe(401);
  });

  it('签名不匹配的令牌被拒（401）', async () => {
    const forged = await new SignJWT({ tenant: 'demo-tenant', roles: ['ops'], hostUserId: 'host-u1' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user-1')
      .setIssuer(ISS)
      .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
      .sign(new TextEncoder().encode('another-secret'));
    const response = await fetchPacks(baseUrl, forged);
    expect(response.status).toBe(401);
  });

  it('边界：registry 无已安装 pack → packs 为空数组（非 404/非 null）', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'za-packs-empty-'));
    writeFileSync(join(tmp, 'manifest.json'), JSON.stringify({ version: '1.0.0', packs: [] }));
    const srv = await startServer(serverOptions({ snapshotRoot: tmp }));
    try {
      const response = await fetchPacks(`http://127.0.0.1:${srv.port}`, await signToken());
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ packs: [] });
    } finally {
      await srv.close();
    }
  });

  it('边界：自建来源 + 声明 name 的知识型 pack（无 tools.json）→ name/source 原样透出、tools 为空', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'za-packs-local-'));
    const packRoot = join(tmp, 'packs', 'local-crm');
    mkdirSync(join(packRoot, 'features', 'crm-notes'), { recursive: true });
    writeFileSync(
      join(tmp, 'manifest.json'),
      JSON.stringify({
        version: '1.0.0',
        packs: [{ packId: 'local-crm', version: '0.2.0', source: 'local' }],
      }),
    );
    writeFileSync(
      join(packRoot, 'pack.json'),
      JSON.stringify({
        packId: 'local-crm',
        version: '0.2.0',
        name: '公司 CRM',
        summary: '内部 CRM 字段与流程讲解。',
        site: { origin: 'http://crm.internal.example', locations: ['/'] },
        featureIdRules: [{ urlPattern: 'crm\\.internal\\.example', featureId: 'crm-notes' }],
        features: ['crm-notes'],
      }),
    );
    writeFileSync(join(packRoot, 'features', 'crm-notes', 'feature.md'), '# ZA-FEAT-01 讲解\n');
    writeFileSync(join(packRoot, 'features', 'crm-notes', 'facts.md'), 'CRM 事实\n');

    const srv = await startServer(serverOptions({ snapshotRoot: tmp }));
    try {
      const response = await fetchPacks(`http://127.0.0.1:${srv.port}`, await signToken());
      expect(response.status).toBe(200);
      const body = (await response.json()) as { packs: PackView[] };
      expect(body.packs).toHaveLength(1);
      const pack = body.packs[0]!;
      expect(pack.name).toBe('公司 CRM');
      expect(pack.source).toBe('local');
      expect(pack.tools).toEqual([]);
      expect(pack.automations).toEqual([]);
      expect(pack.features.map((feature) => feature.featureId)).toEqual(['crm-notes']);
    } finally {
      await srv.close();
    }
  });
});
