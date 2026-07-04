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
  it('schemas/ 下五份契约齐备', () => {
    expect(schemaFiles.sort()).toEqual([
      'audit-event.schema.json',
      'client-access-layer.schema.json',
      'config-snapshot.schema.json',
      'identity-claims.schema.json',
      'tool-definition.schema.json',
    ]);
  });

  it.each(schemaFiles)('%s 可解析且通过 Ajv 2020-12 编译', (file) => {
    const ajv = new Ajv2020({ strict: true });
    expect(compile(ajv, file)).toBeTypeOf('function');
  });
});

describe('examples/host-demo 锚定样例过契约校验', () => {
  const manifest = loadJson(join(demoConfigDir, 'manifest.json')) as { features: string[] };

  it('manifest.json 通过 config-snapshot 校验', () => {
    const validate = compile(new Ajv2020({ strict: true }), 'config-snapshot.schema.json');
    expect(validate(manifest), JSON.stringify(validate.errors)).toBe(true);
  });

  it('manifest.features 闭单非空且覆盖 order-list 与 order-detail', () => {
    expect(manifest.features).toContain('order-list');
    expect(manifest.features).toContain('order-detail');
  });

  it.each(manifest.features)('features/%s/ 三件套齐备', (featureId) => {
    for (const file of ['feature.md', 'facts.md', 'tools.json']) {
      expect(existsSync(join(demoConfigDir, 'features', featureId, file)), `缺 ${featureId}/${file}`).toBe(
        true,
      );
    }
  });

  it.each(manifest.features)('features/%s/tools.json 为数组且逐元素通过 tool-definition 校验', (featureId) => {
    const validate = compile(new Ajv2020({ strict: true }), 'tool-definition.schema.json');
    const tools = loadJson(join(demoConfigDir, 'features', featureId, 'tools.json'));
    expect(Array.isArray(tools)).toBe(true);
    for (const tool of tools as unknown[]) {
      expect(validate(tool), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it('order-detail tools.json 空数组同样合法（零工具功能）', () => {
    const tools = loadJson(join(demoConfigDir, 'features/order-detail/tools.json'));
    expect(tools).toEqual([]);
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
    },
    'text-delta': {
      type: 'text-delta',
      sessionId: 's-001',
      delta: '在列表上方的状态筛选器中',
    },
  };

  it.each(Object.keys(validFrames))('合法 %s 帧通过校验', (frameType) => {
    expect(validate(validFrames[frameType]), JSON.stringify(validate.errors)).toBe(true);
  });

  const invalidFrames: Record<string, unknown> = {
    'user-message 缺 required text': { type: 'user-message', sessionId: 's-001' },
    'context-report 缺 required url': { type: 'context-report', sessionId: 's-001' },
    '未知帧 type 被闭集拒绝': { type: 'page-reload', sessionId: 's-001' },
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
