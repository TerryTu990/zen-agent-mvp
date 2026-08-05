/**
 * C7 user-overlay 规模上界：entryList maxItems=200、packs maxProperties=100。
 * 上界属只收紧类演进（U3）：既有合法制品原样通过，越界样本 schema 层与 validateUserOverlay 同时拒收——
 * 写入端点的体积/条目守卫与本层不互相替代（端点守总量，schema 守单作用域形状）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { validateUserOverlay } from '../src/index.js';

const schemasDir = new URL('../schemas/', import.meta.url).pathname;

function compileOverlay() {
  const ajv = new Ajv2020({ strict: true });
  addFormats(ajv);
  const schema = JSON.parse(readFileSync(join(schemasDir, 'user-overlay.schema.json'), 'utf8')) as object;
  return ajv.compile(schema);
}

const subject = { tenant: 'default', hostUserId: 'host-1001' };

function entries(count: number, prefix: string): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${String(index).padStart(4, '0')}`,
    text: `第 ${index} 条个人条目。`,
    origin: 'manual',
    createdAt: '2026-08-05T00:00:00.000Z',
  }));
}

function overlayWith(packs: Record<string, unknown>): Record<string, unknown> {
  return { schemaVersion: 1, subject, packs };
}

function packScopes(count: number): Record<string, unknown> {
  const packs: Record<string, unknown> = {};
  for (let index = 0; index < count; index += 1) packs[`pack-${index}`] = { enabled: false };
  return packs;
}

describe('entryList 规模上界（rules/facts 各 200 条）', () => {
  const validate = compileOverlay();

  it('pack 级 200 条规则通过（上界内）', () => {
    const overlay = overlayWith({ 'xianyu-seller': { rules: entries(200, 'r') } });
    expect(validate(overlay), JSON.stringify(validate.errors)).toBe(true);
    expect(validateUserOverlay(overlay).ok).toBe(true);
  });

  it('pack 级 201 条规则被拒（越界）', () => {
    const overlay = overlayWith({ 'xianyu-seller': { rules: entries(201, 'r') } });
    expect(validate(overlay)).toBe(false);
    expect(validateUserOverlay(overlay).ok).toBe(false);
  });

  it('pack 级 201 条事实被拒（rules/facts 各自独立计上界）', () => {
    const overlay = overlayWith({ 'xianyu-seller': { facts: entries(201, 'f') } });
    expect(validate(overlay)).toBe(false);
    expect(validateUserOverlay(overlay).ok).toBe(false);
  });

  it('"*" 全局作用域同守 200 条上界：200 通过、201 被拒', () => {
    expect(validate(overlayWith({ '*': { rules: entries(200, 'g') } }))).toBe(true);
    expect(validate(overlayWith({ '*': { rules: entries(201, 'g') } }))).toBe(false);
  });

  it('rules 与 facts 各 200 条并存仍通过（上界不跨类目合计）', () => {
    const overlay = overlayWith({
      'xianyu-seller': { rules: entries(200, 'r'), facts: entries(200, 'f') },
    });
    expect(validate(overlay), JSON.stringify(validate.errors)).toBe(true);
  });
});

describe('packs 作用域键规模上界（maxProperties=100，含 "*"）', () => {
  const validate = compileOverlay();

  it('100 个 pack 作用域键通过（上界内）', () => {
    const overlay = overlayWith(packScopes(100));
    expect(validate(overlay), JSON.stringify(validate.errors)).toBe(true);
    expect(validateUserOverlay(overlay).ok).toBe(true);
  });

  it('101 个 pack 作用域键被拒（越界）', () => {
    const overlay = overlayWith(packScopes(101));
    expect(validate(overlay)).toBe(false);
    expect(validateUserOverlay(overlay).ok).toBe(false);
  });

  it('"*" 计入上界：99 pack 键 + "*" 通过，100 pack 键 + "*" 被拒', () => {
    const withGlobal = { ...packScopes(99), '*': { rules: entries(1, 'g') } };
    expect(validate(overlayWith(withGlobal)), JSON.stringify(validate.errors)).toBe(true);
    const overBound = { ...packScopes(100), '*': { rules: entries(1, 'g') } };
    expect(validate(overlayWith(overBound))).toBe(false);
  });

  it('既有合法制品不受上界影响（U3 只收紧演进不破坏存量形状）', () => {
    const overlay = overlayWith({
      '*': { rules: entries(2, 'g'), preferences: { verbosity: 'concise' } },
      'xianyu-seller': {
        rules: entries(3, 'r'),
        facts: entries(1, 'f'),
        restrictions: { riskTierRaise: { 'xianyu-orders.page-operate': 'forbidden' } },
        preferences: { automations: { 'xianyu-auto-scan': { enabled: false } } },
      },
      'noisy-shop': { enabled: false },
    });
    expect(validate(overlay), JSON.stringify(validate.errors)).toBe(true);
    expect(validateUserOverlay(overlay).ok).toBe(true);
  });
});
