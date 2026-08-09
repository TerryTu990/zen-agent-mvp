import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const schemasDir = new URL('../schemas/', import.meta.url).pathname;
const demoConfigDir = new URL('../../../examples/host-demo/config/', import.meta.url).pathname;

const schemaFiles = readdirSync(schemasDir).filter((f) => f.endsWith('.schema.json'));

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function compile(ajv: Ajv2020, file: string) {
  addFormats(ajv);
  return ajv.compile(loadJson(join(schemasDir, file)) as object);
}

describe('C1-C5 schema 契约', () => {
  it('schemas/ 下契约齐备（含 ADR-013 pack/registry 扩展）', () => {
    expect(schemaFiles.sort()).toEqual([
      'activation.schema.json',
      'audit-event.schema.json',
      'client-access-layer.schema.json',
      'config-snapshot.schema.json',
      'identity-claims.schema.json',
      'pack.schema.json',
      'registry.schema.json',
      'tool-definition.schema.json',
      'user-overlay.schema.json',
    ]);
  });

  it.each(schemaFiles)('%s 可解析且通过 Ajv 2020-12 编译', (file) => {
    const ajv = new Ajv2020({ strict: true });
    expect(compile(ajv, file)).toBeTypeOf('function');
  });
});

describe('examples/host-demo 锚定样例过契约校验（ADR-013 registry + pack）', () => {
  const registry = loadJson(join(demoConfigDir, 'manifest.json')) as {
    packs: Array<{ packId: string; version: string }>;
  };
  const packDir = join(demoConfigDir, 'packs', 'host-demo');
  const packManifest = loadJson(join(packDir, 'pack.json')) as { features: string[] };
  const featuresDir = join(packDir, 'features');

  it('根 manifest.json 通过 registry 校验', () => {
    const validate = compile(new Ajv2020({ strict: true }), 'registry.schema.json');
    expect(validate(registry), JSON.stringify(validate.errors)).toBe(true);
  });

  it('registry 登记 host-demo pack', () => {
    expect(registry.packs.map((p) => p.packId)).toContain('host-demo');
  });

  it('packs/host-demo/pack.json 通过 pack 校验', () => {
    const validate = compile(new Ajv2020({ strict: true }), 'pack.schema.json');
    expect(validate(packManifest), JSON.stringify(validate.errors)).toBe(true);
  });

  it('pack.features 闭单非空且覆盖 order-list 与 order-detail', () => {
    expect(packManifest.features).toContain('order-list');
    expect(packManifest.features).toContain('order-detail');
  });

  it.each(packManifest.features)('features/%s/ 三件套齐备', (featureId) => {
    for (const file of ['feature.md', 'facts.md', 'tools.json']) {
      expect(existsSync(join(featuresDir, featureId, file)), `缺 ${featureId}/${file}`).toBe(true);
    }
  });

  it.each(packManifest.features)('features/%s/tools.json 为数组且逐元素通过 tool-definition 校验', (featureId) => {
    const validate = compile(new Ajv2020({ strict: true }), 'tool-definition.schema.json');
    const tools = loadJson(join(featuresDir, featureId, 'tools.json'));
    expect(Array.isArray(tools)).toBe(true);
    for (const tool of tools as unknown[]) {
      expect(validate(tool), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it('order-detail tools.json 空数组同样合法（零工具功能）', () => {
    const tools = loadJson(join(featuresDir, 'order-detail/tools.json'));
    expect(tools).toEqual([]);
  });
});

describe('C4 pack generic 兜底（与 site 互斥）', () => {
  const validate = compile(new Ajv2020({ strict: true }), 'pack.schema.json');
  const genericPack = {
    packId: 'generic-web',
    version: '0.1.0',
    generic: true,
    featureIdRules: [{ urlPattern: '.*', featureId: 'browse' }],
    features: ['browse'],
  };

  it('generic pack 清单合法（无 site）', () => {
    expect(validate(genericPack), JSON.stringify(validate.errors)).toBe(true);
  });

  it('generic 与 site 并存拒绝', () => {
    expect(validate({ ...genericPack, site: { origin: 'http://x.example' } })).toBe(false);
  });

  it('非 generic 缺 site 拒绝', () => {
    const { generic: _generic, ...rest } = genericPack;
    expect(validate(rest)).toBe(false);
  });

  it('generic:false 拒绝（const true）', () => {
    expect(validate({ ...genericPack, generic: false })).toBe(false);
  });

  const sitePack = {
    packId: 'shop',
    version: '0.1.0',
    site: { origin: 'https://shop.example' },
    featureIdRules: [{ urlPattern: '.*', featureId: 'orders' }],
  };
  const automation = {
    id: 'shop-auto-scan',
    prompt: '执行自动履约扫描。',
    workRoutes: ['#/orders'],
    executionPreference: 'dom-only',
    defaultPeriodMinutes: 5,
  };

  it('站点 pack 声明 automations 合法（adr-019）', () => {
    expect(
      validate({ ...sitePack, automations: [automation] }),
      JSON.stringify(validate.errors),
    ).toBe(true);
  });

  it('generic pack 声明 automations 拒绝（无固定 origin 围栏）', () => {
    expect(validate({ ...genericPack, automations: [automation] })).toBe(false);
  });

  it('automation 越 executionPreference 闭集拒绝', () => {
    expect(
      validate({ ...sitePack, automations: [{ ...automation, executionPreference: 'yolo' }] }),
    ).toBe(false);
  });
});

describe('C3 client-access-layer 消息帧', () => {
  const validate = compile(new Ajv2020({ strict: true }), 'client-access-layer.schema.json');

  const validFrames: Record<string, unknown> = {
    'context-report': {
      type: 'context-report',
      sessionId: 's-001',
      url: 'https://host.example/orders/order-list.html',
      title: '订单列表',
      featureId: 'order-list',
      snapshot: { keyword: '待发货' },
    },
    'user-message': {
      type: 'user-message',
      sessionId: 's-001',
      text: '怎么筛选待发货订单？',
      executionPreference: 'dom-only',
      automationRunId: 'scan_run_001',
      automationId: 'watch-orders',
    },
    'text-delta': {
      type: 'text-delta',
      sessionId: 's-001',
      delta: '在列表上方的状态筛选器中',
    },
    'turn-complete': {
      type: 'turn-complete',
      sessionId: 's-001',
      messageId: 'message_001',
      idle: true,
    },
    'guide-action highlight 含 message': {
      type: 'guide-action',
      sessionId: 's-001',
      action: 'highlight',
      selector: '#btn-export',
      message: '导出按钮在订单列表页的操作区',
    },
    'guide-action scroll-to 缺省 message': {
      type: 'guide-action',
      sessionId: 's-001',
      action: 'scroll-to',
      selector: '#btn-export',
    },
    'guide-action 以快照 ref 定位（无登记锚点的站点）': {
      type: 'guide-action',
      sessionId: 's-001',
      action: 'highlight',
      ref: 'za-7',
    },
    'guide-action iframe 内快照 ref': {
      type: 'guide-action',
      sessionId: 's-001',
      action: 'scroll-to',
      ref: 'f1:za-3',
      message: '目标在内嵌编辑器里',
    },
  };

  it.each(Object.keys(validFrames))('合法 %s 帧通过校验', (frameType) => {
    expect(validate(validFrames[frameType]), JSON.stringify(validate.errors)).toBe(true);
  });

  const invalidFrames: Record<string, unknown> = {
    'user-message 缺 required text': { type: 'user-message', sessionId: 's-001' },
    'user-message 执行偏好越闭集': {
      type: 'user-message',
      sessionId: 's-001',
      text: '刷新订单',
      executionPreference: 'client-decides',
    },
    'user-message 自动轮次标识过短': {
      type: 'user-message',
      sessionId: 's-001',
      text: '自动扫描',
      automationRunId: 'short',
      automationId: 'watch-orders',
    },
    // 只带 automationRunId 会让服务端的 watch 归属判定整段被跳过，无人值守轮拿到完整工具面。
    'user-message 自动回合缺 automationId': {
      type: 'user-message',
      sessionId: 's-001',
      text: '自动扫描',
      automationRunId: 'scan_run_002',
    },
    'context-report 缺 required url': { type: 'context-report', sessionId: 's-001' },
    '未知帧 type 被闭集拒绝': { type: 'page-reload', sessionId: 's-001' },
    'guide-action action 越 highlight|scroll-to 闭集': {
      type: 'guide-action',
      sessionId: 's-001',
      action: 'click',
      selector: '#btn-export',
    },
    'guide-action selector 与 ref 皆缺（无定位目标）': {
      type: 'guide-action',
      sessionId: 's-001',
      action: 'highlight',
    },
    'guide-action ref 为空串': {
      type: 'guide-action',
      sessionId: 's-001',
      action: 'highlight',
      ref: '',
    },
    'guide-action 缺 required type': {
      sessionId: 's-001',
      action: 'highlight',
      selector: '#btn-export',
    },
  };

  it.each(Object.keys(invalidFrames))('非法帧被拒：%s', (label) => {
    expect(validate(invalidFrames[label])).toBe(false);
  });
});

describe('C3 group-pages 帧（adr-023 D1 任务组页面清单上报）', () => {
  const validate = compile(new Ajv2020({ strict: true }), 'client-access-layer.schema.json');

  const page = {
    handle: 'p1',
    url: 'https://host.example/orders/order-list.html',
    title: '订单列表',
    status: 'active',
  };

  const validFrames: Record<string, unknown> = {
    '三态成员页全量清单': {
      type: 'group-pages',
      sessionId: 's-001',
      pages: [
        page,
        { handle: 'p2', url: 'https://mail.example/main', title: '邮箱', status: 'background' },
        { handle: 'p4', url: 'https://docs.example/guide', status: 'silent' },
      ],
    },
    '空组清单（全员离组后全量重建为空）': { type: 'group-pages', sessionId: 's-001', pages: [] },
    '句柄不透明：任意无结构字符串同样合法': {
      type: 'group-pages',
      sessionId: 's-001',
      pages: [{ ...page, handle: 'workspace-view-00c3' }],
    },
  };

  it.each(Object.keys(validFrames))('合法 %s 通过校验', (label) => {
    expect(validate(validFrames[label]), JSON.stringify(validate.errors)).toBe(true);
  });

  const invalidFrames: Record<string, unknown> = {
    '缺 required pages': { type: 'group-pages', sessionId: 's-001' },
    'status 越 active|background|silent 闭集': {
      type: 'group-pages',
      sessionId: 's-001',
      pages: [{ ...page, status: 'idle' }],
    },
    '句柄空串': {
      type: 'group-pages',
      sessionId: 's-001',
      pages: [{ ...page, handle: '' }],
    },
    '成员页缺 url': {
      type: 'group-pages',
      sessionId: 's-001',
      pages: [{ handle: 'p1', title: '订单列表', status: 'active' }],
    },
    '未截断标题（超 120 字符）被拒': {
      type: 'group-pages',
      sessionId: 's-001',
      pages: [{ ...page, title: '订'.repeat(121) }],
    },
    '形态私有字段（如 tabId）被 additionalProperties 拒绝': {
      type: 'group-pages',
      sessionId: 's-001',
      pages: [{ ...page, tabId: 1207 }],
    },
  };

  it.each(Object.keys(invalidFrames))('非法帧被拒：%s', (label) => {
    expect(validate(invalidFrames[label])).toBe(false);
  });
});

describe('C3 snapshot-request 定向观察 page（adr-023 D2）', () => {
  const validate = compile(new Ajv2020({ strict: true }), 'client-access-layer.schema.json');

  const baseRequest = { type: 'snapshot-request', sessionId: 's-001', requestId: 'r-01' };

  const validFrames: Record<string, unknown> = {
    '缺省无 page（现活跃页语义）': baseRequest,
    '带目标句柄定向': { ...baseRequest, page: 'p3' },
    '句柄不透明：任意无结构字符串同样合法': { ...baseRequest, page: 'workspace-view-00c3' },
    '定向 + includeText 组合': { ...baseRequest, page: 'p3', includeText: true },
  };

  it.each(Object.keys(validFrames))('合法 %s 通过校验', (label) => {
    expect(validate(validFrames[label]), JSON.stringify(validate.errors)).toBe(true);
  });

  const invalidFrames: Record<string, unknown> = {
    'page 空串': { ...baseRequest, page: '' },
    'page 超 64 字符': { ...baseRequest, page: 'a'.repeat(65) },
    'page 非字符串': { ...baseRequest, page: 3 },
  };

  it.each(Object.keys(invalidFrames))('非法帧被拒：%s', (label) => {
    expect(validate(invalidFrames[label])).toBe(false);
  });
});

describe('C3 定向副作用 page 与 HITL 目标页展示（adr-023 D3）', () => {
  const validate = compile(new Ajv2020({ strict: true }), 'client-access-layer.schema.json');

  const execBase = {
    type: 'exec-instruction',
    sessionId: 's-001',
    nonce: 'n-01',
    issuedAt: 1000,
    expiresAt: 61000,
    ttl: 60000,
    signature: 'sig-01',
    toolCallId: 'c-01',
    request: { kind: 'dom', steps: [{ action: 'navigate', url: 'https://host.example/console' }] },
  };
  const guideBase = { type: 'guide-action', sessionId: 's-001', action: 'highlight', selector: '#submit' };
  const hitlBase = {
    type: 'hitl-request',
    sessionId: 's-001',
    hitlId: 'h-01',
    toolId: 'order-list.page-operate',
    params: { task: '提交工单', steps: [] },
  };

  const validFrames: Record<string, unknown> = {
    'exec-instruction 缺省无 page（现活跃页语义）': execBase,
    'exec-instruction 带目标句柄定向': { ...execBase, page: 'p2' },
    'exec-instruction 句柄不透明：任意无结构字符串合法': { ...execBase, page: 'workspace-view-00c3' },
    'guide-action 带目标句柄定向': { ...guideBase, page: 'p2' },
    'hitl-request 目标页展示（标题+origin）': {
      ...hitlBase,
      targetPage: { title: '工单 #4521', origin: 'https://seller.example' },
    },
    'hitl-request navigate 目标 URL 呈现': { ...hitlBase, targetUrl: 'https://seller.example/console' },
    'hitl-request 缺省（活跃页，不加措辞）': hitlBase,
  };

  it.each(Object.keys(validFrames))('合法 %s 通过校验', (label) => {
    expect(validate(validFrames[label]), JSON.stringify(validate.errors)).toBe(true);
  });

  const invalidFrames: Record<string, unknown> = {
    'exec-instruction page 空串': { ...execBase, page: '' },
    'exec-instruction page 超 64 字符': { ...execBase, page: 'a'.repeat(65) },
    'exec-instruction page 非字符串': { ...execBase, page: 7 },
    'guide-action page 空串': { ...guideBase, page: '' },
    'hitl-request targetPage 带越界键': { ...hitlBase, targetPage: { title: 't', handle: 'p2' } },
    'hitl-request targetUrl 空串': { ...hitlBase, targetUrl: '' },
  };

  it.each(Object.keys(invalidFrames))('非法帧被拒：%s', (label) => {
    expect(validate(invalidFrames[label])).toBe(false);
  });
});

describe('C3 snapshot-report 帧（含页面提示文本 notices 与页面正文 text）', () => {
  const validate = compile(new Ajv2020({ strict: true }), 'client-access-layer.schema.json');

  const baseReport = {
    type: 'snapshot-report',
    sessionId: 's-001',
    requestId: 'r-01',
    url: 'https://host.example/orders/order-list.html',
    title: '订单列表',
    elements: [{ ref: 'za-1', role: 'button', label: '提交' }],
  };

  const validFrames: Record<string, unknown> = {
    'snapshot-report 缺省 notices（向后兼容）': baseReport,
    'snapshot-report 含 notices': { ...baseReport, notices: ['请选择分组'] },
    'snapshot-report notices 空数组': { ...baseReport, notices: [] },
    'snapshot-report 含结构化证据': {
      ...baseReport,
      evidence: { 'message-receipts': { count: 3, latest: '未读' } },
    },
    'snapshot-request 含 pack 证据配方': {
      type: 'snapshot-request',
      sessionId: 's-001',
      requestId: 'r-02',
      evidenceRules: [
        {
          id: 'message-receipts',
          itemSelector: '[class*="message-content"]',
          statusSelector: '[class*="read-status-text"]',
          statuses: ['未读', '已读'],
        },
      ],
    },
    'snapshot-request 缺省 includeText（向后兼容）': {
      type: 'snapshot-request',
      sessionId: 's-001',
      requestId: 'r-03',
    },
    'snapshot-request 显式请求正文': {
      type: 'snapshot-request',
      sessionId: 's-001',
      requestId: 'r-04',
      includeText: true,
    },
    'snapshot-report 缺省 text（未请求正文）': baseReport,
    'snapshot-report 含完整正文': { ...baseReport, text: '订单列表页正文内容。' },
    'snapshot-report 含正文且显式标注未截断': {
      ...baseReport,
      text: '订单列表页正文内容。',
      textTruncated: false,
    },
    'snapshot-report 含已截断正文': {
      ...baseReport,
      text: 'x'.repeat(4000),
      textTruncated: true,
    },
    'snapshot-report 正文取契约上限长度': { ...baseReport, text: 'x'.repeat(40000) },
  };

  it.each(Object.keys(validFrames))('合法 %s 通过校验', (label) => {
    expect(validate(validFrames[label]), JSON.stringify(validate.errors)).toBe(true);
  });

  const invalidFrames: Record<string, unknown> = {
    'notices 项越 200 字符上限': { ...baseReport, notices: ['x'.repeat(201)] },
    'notices 越 10 条上限': {
      ...baseReport,
      notices: Array.from({ length: 11 }, (_, i) => `提示 ${i}`),
    },
    'notices 含空串': { ...baseReport, notices: [''] },
    'notices 含非字符串项': { ...baseReport, notices: [{ text: '请选择分组' }] },
    'evidence 含正文类额外字段': {
      ...baseReport,
      evidence: { 'message-receipts': { count: 3, latest: '未读', content: '禁止' } },
    },
    'text 非字符串': { ...baseReport, text: { body: '正文' } },
    'text 为空串（无正文一律缺席而非空串）': { ...baseReport, text: '' },
    'text 越 40000 字符契约硬顶': { ...baseReport, text: 'x'.repeat(40001) },
    'textTruncated 非布尔': { ...baseReport, text: '正文', textTruncated: 'yes' },
    'textTruncated 无 text 相伴（截断标记无所依附）': { ...baseReport, textTruncated: true },
    'snapshot-report 含未声明的正文旁字段': { ...baseReport, text: '正文', textLength: 2 },
    'snapshot-request includeText 非布尔': {
      type: 'snapshot-request',
      sessionId: 's-001',
      requestId: 'r-05',
      includeText: 'true',
    },
    'snapshot-request 含未声明字段': {
      type: 'snapshot-request',
      sessionId: 's-001',
      requestId: 'r-06',
      includeText: true,
      maxTextLength: 4000,
    },
  };

  it.each(Object.keys(invalidFrames))('非法帧被拒：%s', (label) => {
    expect(validate(invalidFrames[label])).toBe(false);
  });
});

describe('C2 identity-claims', () => {
  const validate = compile(new Ajv2020({ strict: true }), 'identity-claims.schema.json');

  const validClaims = {
    sub: 'u-1001',
    tenant: 'default',
    roles: ['ops'],
    hostUserId: 'host-1001',
    iss: 'https://sso.host.example',
    exp: 1780000000,
  };

  it('合法 claims 通过校验', () => {
    expect(validate(validClaims), JSON.stringify(validate.errors)).toBe(true);
  });

  it.each(['exp', 'iss'] as const)('缺 required %s 的 claims 被拒', (field) => {
    const { [field]: _omitted, ...rest } = validClaims;
    expect(validate(rest)).toBe(false);
  });
});

describe('C3 client-access-layer M3 代执行 + HITL 帧', () => {
  const validate = compile(new Ajv2020({ strict: true }), 'client-access-layer.schema.json');

  const validFrames: Record<string, unknown> = {
    'hitl-request 含 params 与 reason': {
      type: 'hitl-request',
      sessionId: 's-001',
      hitlId: 'h-01',
      toolCallId: 'tc-01',
      toolId: 'order-list.cancel-order',
      params: { orderId: 'ORD-1001' },
      reason: 'riskTier=hitl 需人工确认',
    },
    'hitl-decision approve': {
      type: 'hitl-decision',
      sessionId: 's-001',
      hitlId: 'h-01',
      decision: 'approve',
    },
    'hitl-decision reject 含 comment': {
      type: 'hitl-decision',
      sessionId: 's-001',
      hitlId: 'h-01',
      decision: 'reject',
      comment: '不确定，先不取消',
    },
    'exec-instruction 含 nonce/ttl/signature/request': {
      type: 'exec-instruction',
      sessionId: 's-001',
      nonce: '11111111-2222-3333-4444-555555555555',
      issuedAt: 1_000,
      expiresAt: 61_000,
      ttl: 60000,
      signature: 'c2lnbmF0dXJlLWhtYWM',
      toolCallId: 'tc-01',
      request: {
        method: 'POST',
        url: '/api/orders/ORD-1001/cancel',
        headers: { 'content-type': 'application/json' },
        body: {},
      },
    },
    'exec-result ok': {
      type: 'exec-result',
      sessionId: 's-001',
      nonce: '11111111-2222-3333-4444-555555555555',
      ok: true,
      status: 200,
      body: { ok: true, orderId: 'ORD-1001' },
    },
    'exec-result 失败': {
      type: 'exec-result',
      sessionId: 's-001',
      nonce: '11111111-2222-3333-4444-555555555555',
      ok: false,
      status: 500,
      error: 'HTTP 500',
    },
    'tool-card running': {
      type: 'tool-card',
      sessionId: 's-001',
      toolCallId: 'tc-01',
      toolId: 'order-list.cancel-order',
      status: 'running',
      summary: '正在取消订单',
    },
    'tool-card succeeded': {
      type: 'tool-card',
      sessionId: 's-001',
      toolCallId: 'tc-01',
      toolId: 'order-list.cancel-order',
      status: 'succeeded',
    },
    'tool-card failed': {
      type: 'tool-card',
      sessionId: 's-001',
      toolCallId: 'tc-01',
      toolId: 'order-list.cancel-order',
      status: 'failed',
    },
  };

  it.each(Object.keys(validFrames))('合法 %s 帧通过校验', (label) => {
    expect(validate(validFrames[label]), JSON.stringify(validate.errors)).toBe(true);
  });

  const invalidFrames: Record<string, unknown> = {
    'hitl-request 缺 required params': {
      type: 'hitl-request',
      sessionId: 's-001',
      hitlId: 'h-01',
      toolId: 'order-list.cancel-order',
    },
    'hitl-decision decision 越 approve|reject 闭集': {
      type: 'hitl-decision',
      sessionId: 's-001',
      hitlId: 'h-01',
      decision: 'maybe',
    },
    'exec-instruction 缺 required signature（U7 一次性签名必含）': {
      type: 'exec-instruction',
      sessionId: 's-001',
      nonce: '11111111-2222-3333-4444-555555555555',
      ttl: 60000,
      toolCallId: 'tc-01',
      request: { method: 'POST', url: '/api/orders/ORD-1001/cancel' },
    },
    'exec-instruction request.method 越 HTTP 闭集': {
      type: 'exec-instruction',
      sessionId: 's-001',
      nonce: '11111111-2222-3333-4444-555555555555',
      ttl: 60000,
      signature: 'c2ln',
      toolCallId: 'tc-01',
      request: { method: 'TRACE', url: '/api/orders' },
    },
    'exec-result 缺 required nonce': {
      type: 'exec-result',
      sessionId: 's-001',
      ok: true,
    },
    'tool-card status 越 running|succeeded|failed 闭集': {
      type: 'tool-card',
      sessionId: 's-001',
      toolCallId: 'tc-01',
      toolId: 'order-list.cancel-order',
      status: 'pending',
    },
  };

  it.each(Object.keys(invalidFrames))('非法帧被拒：%s', (label) => {
    expect(validate(invalidFrames[label])).toBe(false);
  });
});

describe('C1 tool-definition M3 三档 riskTier', () => {
  const validate = compile(new Ajv2020({ strict: true }), 'tool-definition.schema.json');

  const validTools: Record<string, unknown> = {
    'auto refresh-orders（client GET）': {
      id: 'order-list.refresh-orders',
      featureIds: ['order-list'],
      description: '刷新当前订单列表，返回订单条数',
      params: {
        type: 'object',
        required: ['intentId'],
        properties: { intentId: { type: 'string' } },
        additionalProperties: false,
      },
      execution: 'client',
      riskTier: 'auto',
      adapter: { method: 'GET', urlTemplate: '/api/orders' },
      resultSchema: {
        type: 'object',
        required: ['ok'],
        properties: { ok: { type: 'boolean' }, count: { type: 'number' } },
      },
    },
    'hitl cancel-order（client POST 含占位符）': {
      id: 'order-list.cancel-order',
      featureIds: ['order-list'],
      description: '取消指定订单，需用户确认',
      params: { type: 'object', required: ['orderId'], properties: { orderId: { type: 'string' } } },
      execution: 'client',
      riskTier: 'hitl',
      adapter: { method: 'POST', urlTemplate: '/api/orders/{{orderId}}/cancel' },
      resultSchema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, orderId: { type: 'string' } },
      },
    },
    'forbidden purge-orders（client DELETE）': {
      id: 'order-list.purge-orders',
      featureIds: ['order-list'],
      description: '清空所有订单——危险操作，声明其存在但永拒执行',
      params: { type: 'object', properties: {}, additionalProperties: false },
      execution: 'client',
      riskTier: 'forbidden',
      adapter: { method: 'DELETE', urlTemplate: '/api/orders' },
      resultSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
    },
    'dom 工具含 pack 级结构化证据配方': {
      id: 'chat.send-message',
      featureIds: ['chat'],
      description: '发送消息并复核回执',
      params: { type: 'object', properties: {}, additionalProperties: false },
      execution: 'client',
      riskTier: 'hitl',
      adapter: {
        kind: 'dom',
        pathPrefixes: ['/'],
        snapshotEvidence: [
          {
            id: 'message-receipts',
            itemSelector: '[class*="message-content"]',
            statusSelector: '[class*="read-status-text"]',
            statuses: ['未读', '已读'],
          },
        ],
      },
      resultSchema: { type: 'object' },
    },
    'every-call 工具声明服务端有界履约授权映射': {
      id: 'chat.send-delivery',
      featureIds: ['chat'],
      description: '发送确定性履约通知',
      params: { type: 'object', properties: {}, additionalProperties: false },
      execution: 'client',
      riskTier: 'hitl',
      hitlMode: 'every-call',
      authorization: {
        kind: 'bounded-fulfillment',
        workflow: 'delivery',
        intentIdParam: 'intentId',
      },
      adapter: { kind: 'dom', pathPrefixes: ['/'] },
      resultSchema: { type: 'object' },
    },
    'delivery 授权带声明式 preparation（adr-019）': {
      id: 'chat.send-delivery-prepared',
      featureIds: ['chat'],
      description: '发送确定性履约通知',
      params: { type: 'object', properties: {}, additionalProperties: false },
      execution: 'client',
      riskTier: 'hitl',
      hitlMode: 'every-call',
      authorization: {
        kind: 'bounded-fulfillment',
        workflow: 'delivery',
        intentIdParam: 'intentId',
        preparation: {
          description: '在聊天页准备一次履约',
          routes: ['/im'],
          params: {
            orderId: { source: 'hash-query', name: 'orderId', pattern: '^[A-Za-z0-9_-]{1,128}$' },
            productId: { source: 'hash-query', name: 'itemId' },
          },
          productParam: 'productId',
          elements: {
            messageRef: { role: 'textarea' },
            sendRef: { role: 'button', label: '发送' },
          },
          evidence: { rule: 'message-receipts' },
          intentTtlMs: 45000,
        },
      },
      adapter: { kind: 'dom', pathPrefixes: ['/'] },
      resultSchema: { type: 'object' },
    },
    'shipment 授权带 element-href 参数源与状态跃迁证据': {
      id: 'orders.ship-prepared',
      featureIds: ['orders'],
      description: '受控发货',
      params: { type: 'object', properties: {}, additionalProperties: false },
      execution: 'client',
      riskTier: 'hitl',
      hitlMode: 'every-call',
      authorization: {
        kind: 'bounded-fulfillment',
        workflow: 'shipment',
        intentIdParam: 'intentId',
        preparation: {
          description: '在订单详情页准备一次发货',
          routes: ['/seller-trade/order-manage/order-detail'],
          params: {
            orderId: { source: 'hash-query', name: 'orderId', pattern: '^[A-Za-z0-9_-]{1,128}$' },
            productId: {
              source: 'element-href',
              urlOrigin: 'https://www.example.com',
              urlPath: '/item',
              queryParam: 'id',
              pattern: '^[A-Za-z0-9_-]{1,128}$',
            },
          },
          productParam: 'productId',
          elements: { actionRef: { role: 'button', label: '发货', requireEnabled: true } },
          paramEvidence: { param: 'orderId', roles: ['cell', 'td'], labelPrefixes: ['订单编号'] },
          evidence: { rule: 'order-shipment-status', before: '待发货', after: '已发货' },
          intentTtlMs: 45000,
        },
      },
      adapter: { kind: 'dom', pathPrefixes: ['/'] },
      resultSchema: { type: 'object' },
    },
  };

  it.each(Object.keys(validTools))('合法工具 %s 通过校验', (label) => {
    expect(validate(validTools[label]), JSON.stringify(validate.errors)).toBe(true);
  });

  const baseTool = validTools['auto refresh-orders（client GET）'] as Record<string, unknown>;

  const invalidTools: Record<string, unknown> = {
    'execution 越 client|server 闭集被拒': { ...baseTool, execution: 'edge' },
    'riskTier 越 auto|hitl|forbidden 闭集被拒': { ...baseTool, riskTier: 'medium' },
    'client adapter 缺 required urlTemplate 被拒': {
      ...baseTool,
      adapter: { method: 'GET' },
    },
    '有界授权映射缺意图字段被拒': {
      ...baseTool,
      authorization: {
        kind: 'bounded-fulfillment',
      },
    },
    '有界授权映射缺工作流类型被拒': {
      ...baseTool,
      authorization: { kind: 'bounded-fulfillment', intentIdParam: 'intentId' },
    },
    'delivery preparation 缺 messageRef/sendRef 元素绑定被拒': {
      ...baseTool,
      authorization: {
        kind: 'bounded-fulfillment',
        workflow: 'delivery',
        intentIdParam: 'intentId',
        preparation: {
          description: 'x',
          routes: ['/im'],
          params: { productId: { source: 'hash-query', name: 'itemId' } },
          productParam: 'productId',
          elements: { sendRef: { role: 'button' } },
          evidence: { rule: 'message-receipts' },
          intentTtlMs: 45000,
        },
      },
    },
    'shipment preparation 证据缺 before/after 被拒': {
      ...baseTool,
      authorization: {
        kind: 'bounded-fulfillment',
        workflow: 'shipment',
        intentIdParam: 'intentId',
        preparation: {
          description: 'x',
          routes: ['/detail'],
          params: { productId: { source: 'hash-query', name: 'itemId' } },
          productParam: 'productId',
          elements: { actionRef: { role: 'button' } },
          evidence: { rule: 'order-shipment-status' },
          intentTtlMs: 45000,
        },
      },
    },
    'preparation 参数源越 hash-query|element-href 闭集被拒': {
      ...baseTool,
      authorization: {
        kind: 'bounded-fulfillment',
        workflow: 'delivery',
        intentIdParam: 'intentId',
        preparation: {
          description: 'x',
          routes: ['/im'],
          params: { productId: { source: 'script', expr: '1+1' } },
          productParam: 'productId',
          elements: { messageRef: { role: 'textarea' }, sendRef: { role: 'button' } },
          evidence: { rule: 'message-receipts' },
          intentTtlMs: 45000,
        },
      },
    },
  };

  it.each(Object.keys(invalidTools))('非法工具被拒：%s', (label) => {
    expect(validate(invalidTools[label])).toBe(false);
  });
});

describe('C5 audit-event M3 门禁/裁决/执行事件', () => {
  const validate = compile(new Ajv2020({ strict: true }), 'audit-event.schema.json');

  const base = {
    eventId: 'e-0001',
    ts: '2026-07-04T03:16:25.000Z',
    sessionId: 's-001',
    userId: 'host-1001',
    tenant: 'default',
    featureId: 'order-list',
  };

  const validEvents: Record<string, unknown> = {
    'tool-decision hitl': {
      ...base,
      type: 'tool-decision',
      data: {
        toolCallId: 'tc-01',
        toolId: 'order-list.cancel-order',
        riskTier: 'hitl',
        verdict: 'hitl',
        reason: 'riskTier=hitl',
      },
    },
    'hitl-verdict approve': {
      ...base,
      type: 'hitl-verdict',
      data: { hitlId: 'h-01', toolCallId: 'tc-01', decision: 'approve' },
    },
    'tool-execution ok': {
      ...base,
      type: 'tool-execution',
      data: {
        toolCallId: 'tc-01',
        toolId: 'order-list.cancel-order',
        execution: 'client',
        nonce: '11111111-2222-3333-4444-555555555555',
        outcome: 'ok',
        status: 200,
        durationMs: 12,
      },
    },
    // 自动回合「本轮没看到被监测页」的结局：与 ok 分开，否则运行历史会把「没看成」渲染成「看过没变」。
    'tool-execution skipped': {
      ...base,
      type: 'tool-execution',
      data: {
        toolCallId: 'watch_run_2',
        toolId: 'watch-orders',
        execution: 'server',
        outcome: 'skipped',
        durationMs: 8,
      },
    },
  };

  it.each(Object.keys(validEvents))('合法事件 %s 通过校验', (label) => {
    expect(validate(validEvents[label]), JSON.stringify(validate.errors)).toBe(true);
  });

  const invalidEvents: Record<string, unknown> = {
    'tool-decision verdict 越 allow|hitl|deny 闭集被拒': {
      ...base,
      type: 'tool-decision',
      data: { toolCallId: 'tc-01', toolId: 'order-list.cancel-order', riskTier: 'hitl', verdict: 'maybe' },
    },
    'tool-execution outcome 越闭集被拒': {
      ...base,
      type: 'tool-execution',
      data: { toolCallId: 'tc-01', toolId: 'order-list.cancel-order', execution: 'client', outcome: 'partial' },
    },
    'event type 越六段链路闭集被拒': {
      ...base,
      type: 'tool-invoke',
      data: {},
    },
  };

  it.each(Object.keys(invalidEvents))('非法事件被拒：%s', (label) => {
    expect(validate(invalidEvents[label])).toBe(false);
  });
});

describe('C5 audit 事件页标注 page（adr-023，additive）', () => {
  const validate = compile(new Ajv2020({ strict: true }), 'audit-event.schema.json');

  const base = {
    eventId: 'e-0003',
    ts: '2026-08-09T08:00:00.000Z',
    sessionId: 's-001',
    type: 'tool-execution',
    data: { toolCallId: 'tc-01', toolId: 'order-list.cancel-order', execution: 'client', outcome: 'ok' },
  };

  const validEvents: Record<string, unknown> = {
    '带 handle+origin 的页标注': {
      ...base,
      page: { handle: 'p2', origin: 'https://host.example' },
    },
    'origin 不可解析时仅 handle': { ...base, page: { handle: 'p2' } },
    '缺省 page 依旧合法（additive 回归锚）': base,
    '句柄不透明：任意无结构字符串同样合法': {
      ...base,
      page: { handle: 'workspace-view-00c3', origin: 'https://host.example' },
    },
  };

  it.each(Object.keys(validEvents))('合法事件 %s 通过校验', (label) => {
    expect(validate(validEvents[label]), JSON.stringify(validate.errors)).toBe(true);
  });

  const invalidEvents: Record<string, unknown> = {
    'page 缺 required handle 被拒': { ...base, page: { origin: 'https://host.example' } },
    'page.handle 空串被拒': { ...base, page: { handle: '', origin: 'https://host.example' } },
    '形态私有字段（如 tabId）被 additionalProperties 拒绝': {
      ...base,
      page: { handle: 'p2', tabId: 1207 },
    },
  };

  it.each(Object.keys(invalidEvents))('非法事件被拒：%s', (label) => {
    expect(validate(invalidEvents[label])).toBe(false);
  });
});

describe('C4 registry v2 登记项来源归属（adr-020 §3）', () => {
  const validate = compile(new Ajv2020({ strict: true }), 'registry.schema.json');

  const entry = { packId: 'shop', version: '1.0.0' };

  const validRegistries: Record<string, unknown> = {
    'source 缺省依旧合法（U3 回归锚）': { version: '1.0.0', packs: [entry] },
    'source official': { version: '1.0.0', packs: [{ ...entry, source: 'official' }] },
    'source community': { version: '1.0.0', packs: [{ ...entry, source: 'community' }] },
    'source local': { version: '1.0.0', packs: [{ ...entry, source: 'local' }] },
    'hash 登记合法（装配端启用锚点 P3.5）': {
      version: '1.0.0',
      packs: [{ ...entry, source: 'official', hash: 'a'.repeat(64) }],
    },
  };

  it.each(Object.keys(validRegistries))('合法 registry 通过校验：%s', (label) => {
    expect(validate(validRegistries[label]), JSON.stringify(validate.errors)).toBe(true);
  });

  const invalidRegistries: Record<string, unknown> = {
    'source 越 official|community|local 闭集被拒': {
      version: '1.0.0',
      packs: [{ ...entry, source: 'vendor' }],
    },
  };

  it.each(Object.keys(invalidRegistries))('非法 registry 被拒：%s', (label) => {
    expect(validate(invalidRegistries[label])).toBe(false);
  });
});

describe('C5 audit L2 事件（adr-014：user-config-write + userConfigRevision）', () => {
  const validate = compile(new Ajv2020({ strict: true }), 'audit-event.schema.json');

  const base = {
    eventId: 'e-0002',
    ts: '2026-08-04T03:16:25.000Z',
    sessionId: 's-001',
    userId: 'host-1001',
    tenant: 'default',
  };

  const validEvents: Record<string, unknown> = {
    'user-config-write 含写后完整脱敏快照与 revision': {
      ...base,
      type: 'user-config-write',
      data: {
        subject: { tenant: 'default', hostUserId: 'host-1001' },
        origin: 'panel',
        revision: 'rev-3f6a2c',
        overlay: {
          schemaVersion: 1,
          subject: { tenant: 'default', hostUserId: 'host-1001' },
          packs: {
            'xianyu-seller': {
              restrictions: { riskTierRaise: { 'reply-buyer.send-message': 'hitl' } },
            },
          },
        },
      },
    },
    'assembly 事件携带 userConfigRevision（注入/审计/判定三方互证）': {
      ...base,
      featureId: 'order-list',
      type: 'assembly',
      data: {
        snapshotVersion: '0.2.0',
        featureId: 'order-list',
        toolIds: ['order-list.cancel-order'],
        skillIds: [],
        userConfigRevision: 'rev-3f6a2c',
      },
    },
    'assembly 事件缺省 userConfigRevision 依旧合法（U3 回归锚）': {
      ...base,
      type: 'assembly',
      data: { snapshotVersion: '0.2.0', featureId: null, toolIds: [], skillIds: [] },
    },
    'tool-decision 事件携带 userConfigRevision（与 assembly/user-config-write 同值互证）': {
      ...base,
      type: 'tool-decision',
      data: {
        toolCallId: 'tc-01',
        toolId: 'order-list.cancel-order',
        riskTier: 'hitl',
        verdict: 'hitl',
        userConfigRevision: 'rev-3f6a2c',
      },
    },
    'tool-decision 事件自解释 L2 收紧（riskTier 静态值 + effectiveTier 生效值）': {
      ...base,
      type: 'tool-decision',
      data: {
        toolCallId: 'tc-02',
        toolId: 'order-list.refresh-orders',
        riskTier: 'auto',
        effectiveTier: 'hitl',
        verdict: 'hitl',
        userConfigRevision: 'rev-3f6a2c',
      },
    },
    'degraded 轮 tool-decision 与 assembly 事件同以 userConfigDegraded 标注（无伪 hash）': {
      ...base,
      type: 'tool-decision',
      data: {
        toolCallId: 'tc-03',
        toolId: 'order-list.refresh-orders',
        riskTier: 'auto',
        effectiveTier: 'forbidden',
        verdict: 'deny',
        reason: 'user-config-unavailable',
        userConfigDegraded: 'fail-open-closed',
      },
    },
    'assembly 事件标注用户关停 pack（packDisabled 区分「无 pack」与「已关停」）': {
      ...base,
      type: 'assembly',
      data: {
        snapshotVersion: '0.2.0',
        featureId: null,
        toolIds: [],
        skillIds: [],
        userConfigRevision: 'rev-3f6a2c',
        packDisabled: true,
      },
    },
  };

  it.each(Object.keys(validEvents))('合法事件 %s 通过校验', (label) => {
    expect(validate(validEvents[label]), JSON.stringify(validate.errors)).toBe(true);
  });

  const invalidEvents: Record<string, unknown> = {
    '未知事件 type 仍被闭集拒绝': { ...base, type: 'user-config-read', data: {} },
  };

  it.each(Object.keys(invalidEvents))('非法事件被拒：%s', (label) => {
    expect(validate(invalidEvents[label])).toBe(false);
  });
});

describe('C3 config-draft / config-decision 帧（adr-014 §5 teach 写入通道）', () => {
  const validate = compile(new Ajv2020({ strict: true }), 'client-access-layer.schema.json');

  const draftFrame = {
    type: 'config-draft',
    sessionId: 's-001',
    draftId: 'd-01',
    scope: { packId: 'xianyu-seller', featureId: 'reply-buyer' },
    change: {
      packs: {
        'xianyu-seller': {
          rules: [
            {
              id: 'r-1',
              text: '报价一律引用运费模板。',
              featureId: 'reply-buyer',
              origin: 'teach',
              sourceSessionId: 's-001',
              createdAt: '2026-08-04T03:16:25.000Z',
            },
          ],
        },
      },
    },
    summary: '新增个人规则：报价一律引用运费模板',
  };

  const validFrames: Record<string, unknown> = {
    'config-draft 全字段': draftFrame,
    'config-draft scope 缺省 featureId（整 pack 生效）': {
      ...draftFrame,
      scope: { packId: 'xianyu-seller' },
    },
    'config-decision accept': {
      type: 'config-decision',
      sessionId: 's-001',
      draftId: 'd-01',
      decision: 'accept',
    },
    'config-decision reject': {
      type: 'config-decision',
      sessionId: 's-001',
      draftId: 'd-01',
      decision: 'reject',
    },
  };

  it.each(Object.keys(validFrames))('合法 %s 帧通过校验', (label) => {
    expect(validate(validFrames[label]), JSON.stringify(validate.errors)).toBe(true);
  });

  const invalidFrames: Record<string, unknown> = {
    'config-decision decision 越 accept|reject 闭集': {
      type: 'config-decision',
      sessionId: 's-001',
      draftId: 'd-01',
      decision: 'maybe',
    },
    'config-decision 缺 required draftId': {
      type: 'config-decision',
      sessionId: 's-001',
      decision: 'accept',
    },
    'config-draft 缺 required summary（人读摘要必含）': (() => {
      const { summary: _summary, ...rest } = draftFrame;
      return rest;
    })(),
    'config-draft 缺 required change': (() => {
      const { change: _change, ...rest } = draftFrame;
      return rest;
    })(),
    '未知帧 type 仍被闭集拒绝（config-teach）': {
      type: 'config-teach',
      sessionId: 's-001',
      draftId: 'd-01',
    },
  };

  it.each(Object.keys(invalidFrames))('非法帧被拒：%s', (label) => {
    expect(validate(invalidFrames[label])).toBe(false);
  });
});
