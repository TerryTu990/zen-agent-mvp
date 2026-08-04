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
  const schema = JSON.parse(
    readFileSync(join(schemasDir, 'user-overlay.schema.json'), 'utf8'),
  ) as object;
  return ajv.compile(schema);
}

const subject = { tenant: 'default', hostUserId: 'host-1001' };

const rule = {
  id: 'r-pack-1',
  text: '报价一律引用运费模板，不手写邮费。',
  featureId: 'reply-buyer',
  origin: 'teach',
  sourceSessionId: 's-001',
  createdAt: '2026-08-04T03:16:25.000Z',
};

const validOverlay = {
  schemaVersion: 1,
  subject,
  packs: {
    '*': {
      rules: [
        {
          id: 'r-global-1',
          text: '所有回复使用敬语。',
          origin: 'manual',
          createdAt: '2026-08-04T03:16:25.000Z',
        },
      ],
      facts: [
        {
          id: 'f-global-1',
          text: '我的常用收货地址在杭州。',
          origin: 'manual',
          createdAt: '2026-08-04T03:16:25.000Z',
        },
      ],
      preferences: { verbosity: 'concise' },
    },
    'xianyu-seller': {
      rules: [rule],
      facts: [{ ...rule, id: 'f-pack-1', text: '主营二手键盘。' }],
      restrictions: {
        riskTierRaise: { 'reply-buyer.send-message': 'hitl' },
        disabledTools: ['reply-buyer.batch-reply'],
      },
      packConfig: { greeting: '您好，感谢咨询。' },
      preferences: {
        verbosity: 'standard',
        automations: { 'xianyu-auto-scan': { enabled: false, minutes: 10 } },
      },
    },
    'noisy-shop': { enabled: false },
  },
};

describe('C7 user-overlay schema（adr-014 §2）', () => {
  const validate = compileOverlay();

  const validOverlays: Record<string, unknown> = {
    '完整 overlay（"*" + pack 级 + enabled:false）': validOverlay,
    '空 packs 合法（零定制用户）': { schemaVersion: 1, subject, packs: {} },
    'pack 级仅 rules（最小定制）': {
      schemaVersion: 1,
      subject,
      packs: { 'xianyu-seller': { rules: [rule] } },
    },
  };

  it.each(Object.keys(validOverlays))('合法 overlay 通过校验：%s', (label) => {
    expect(validate(validOverlays[label]), JSON.stringify(validate.errors)).toBe(true);
  });

  const invalidOverlays: Record<string, unknown> = {
    '"*" 作用域含 restrictions（无对应工具面可收紧）': {
      schemaVersion: 1,
      subject,
      packs: { '*': { restrictions: { disabledTools: ['x.y'] } } },
    },
    '"*" 作用域含 packConfig（无对应 configSchema）': {
      schemaVersion: 1,
      subject,
      packs: { '*': { packConfig: { greeting: '您好' } } },
    },
    'enabled:true 越 const false（R1 只收紧，缺省即启用）': {
      schemaVersion: 1,
      subject,
      packs: { 'xianyu-seller': { enabled: true } },
    },
    'riskTierRaise 值 auto 越 hitl|forbidden 闭集（放宽面禁入）': {
      schemaVersion: 1,
      subject,
      packs: {
        'xianyu-seller': { restrictions: { riskTierRaise: { 'reply-buyer.send-message': 'auto' } } },
      },
    },
    '未知顶层字段被拒（additionalProperties:false）': {
      schemaVersion: 1,
      subject,
      packs: {},
      customTools: [],
    },
    'origin 越 manual|teach 闭集': {
      schemaVersion: 1,
      subject,
      packs: { 'xianyu-seller': { rules: [{ ...rule, origin: 'imported' }] } },
    },
  };

  it.each(Object.keys(invalidOverlays))('非法 overlay 被拒：%s', (label) => {
    expect(validate(invalidOverlays[label])).toBe(false);
  });
});

describe('C7 user-overlay 组合校验器（schema + 跨字段语义，消费方唯一入口）', () => {
  it('合法完整 overlay 通过组合校验器', () => {
    const result = validateUserOverlay(validOverlay);
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  it('同一 toolId 同时出现在 riskTierRaise 与 disabledTools → 拒（跨字段语义）', () => {
    const overlay = {
      schemaVersion: 1,
      subject,
      packs: {
        'xianyu-seller': {
          restrictions: {
            riskTierRaise: { 'reply-buyer.send-message': 'forbidden' },
            disabledTools: ['reply-buyer.send-message'],
          },
        },
      },
    };
    const result = validateUserOverlay(overlay);
    expect(result.ok).toBe(false);
  });

  it('schema 非法输入同样被组合校验器拒（不旁路 schema 层）', () => {
    const result = validateUserOverlay({
      schemaVersion: 1,
      subject,
      packs: { '*': { restrictions: { disabledTools: ['x.y'] } } },
    });
    expect(result.ok).toBe(false);
  });
});
