import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { contractVersion } from '../src/index.js';

const schemasDir = new URL('../schemas/', import.meta.url).pathname;

function compilePack() {
  const ajv = new Ajv2020({ strict: true });
  addFormats(ajv);
  const schema = JSON.parse(readFileSync(join(schemasDir, 'pack.schema.json'), 'utf8')) as object;
  return ajv.compile(schema);
}

const sitePackV1 = {
  packId: 'shop',
  version: '0.1.0',
  site: { origin: 'https://shop.example' },
  featureIdRules: [{ urlPattern: '.*', featureId: 'orders' }],
};

const genericPackV1 = {
  packId: 'generic-web',
  version: '0.1.0',
  generic: true,
  featureIdRules: [{ urlPattern: '.*', featureId: 'browse' }],
  features: ['browse'],
};

const packV2 = {
  packId: 'shop',
  version: '1.2.0',
  summary: '示例商城站点包',
  site: { origin: 'https://shop.example', locations: ['/'], exclude: ['/admin', '/internal'] },
  engines: { contract: '^1.0.0' },
  capabilities: {
    anchors: {
      orders: [{ id: 'export-btn', role: 'button', label: '导出', selectorHint: '#btn-export' }],
    },
    skills: ['greet'],
    docs: ['guide.md'],
    preparation: { workflows: ['delivery'] },
  },
  configSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { greeting: { type: 'string', default: '您好' } },
  },
  featureIdRules: [{ urlPattern: '.*', featureId: 'orders' }],
  features: ['orders'],
};

describe('平台契约版本导出', () => {
  it('contractVersion 为 semver（engines.contract 的比对基准）', () => {
    expect(contractVersion).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+$/);
    expect(contractVersion).toBe('1.0.0');
  });
});

describe('C4 pack v2 字段（adr-020 §2）', () => {
  const validate = compilePack();

  const validPacks: Record<string, unknown> = {
    'v2 字段齐备（exclude/engines/capabilities/configSchema）': packV2,
    '旧站点 pack 无新增字段依旧合法（U3 回归锚）': sitePackV1,
    '旧 generic pack 无新增字段依旧合法（U3 回归锚）': genericPackV1,
    '仅 engines.contract 的最小 v2 增量': { ...sitePackV1, engines: { contract: '>=1.0.0 <2.0.0' } },
    'capabilities 各子键均可缺省（仅 skills 闭单）': {
      ...sitePackV1,
      capabilities: { skills: ['greet'] },
    },
    'integrity 文件清单声明合法（装配端启用锚点 P3.5）': {
      ...sitePackV1,
      integrity: { 'features/orders/feature.md': 'a'.repeat(64) },
    },
    'name 人读名合法（packs 页/注入视图/确认卡展示）': { ...sitePackV1, name: '示例商店' },
  };

  it.each(Object.keys(validPacks))('合法 pack 通过校验：%s', (label) => {
    expect(validate(validPacks[label]), JSON.stringify(validate.errors)).toBe(true);
  });

  const invalidPacks: Record<string, unknown> = {
    'engines.contract 非 semver range 串被拒': {
      ...sitePackV1,
      engines: { contract: 'not a range!!' },
    },
    'engines 未知子键被拒': { ...sitePackV1, engines: { node: '>=22' } },
    'capabilities 未知子键被拒（闭集 fail-closed）': {
      ...sitePackV1,
      capabilities: { teleport: {} },
    },
    'site.exclude 项非 / 起被拒': {
      ...sitePackV1,
      site: { origin: 'https://shop.example', exclude: ['admin'] },
    },
    'site.exclude 空数组被拒（声明即须有项）': {
      ...sitePackV1,
      site: { origin: 'https://shop.example', exclude: [] },
    },
    'configSchema 非对象被拒': { ...sitePackV1, configSchema: 'x' },
    'name 空串被拒（minLength 1）': { ...sitePackV1, name: '' },
    'capabilities.preparation.workflows 非字符串数组被拒': {
      ...sitePackV1,
      capabilities: { preparation: { workflows: [42] } },
    },
  };

  it.each(Object.keys(invalidPacks))('非法 pack 被拒：%s', (label) => {
    expect(validate(invalidPacks[label])).toBe(false);
  });
});
