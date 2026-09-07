import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { stripRetiredOverlayKeys, validateUserOverlay } from '../src/index.js';

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
      preferences: { verbosity: 'standard' },
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
    '"*" 作用域含 siteDenylist（精确 origin + 子域通配 + 带端口）': {
      schemaVersion: 1,
      subject,
      packs: {
        '*': {
          siteDenylist: ['https://bank.example.com', 'https://*.corp.example', 'http://localhost:3000'],
        },
      },
    },
    '"*" 作用域含 grantedOrigins（站点注入授权集，精确 origin + 带端口）': {
      schemaVersion: 1,
      subject,
      packs: { '*': { grantedOrigins: ['https://shop.example', 'http://127.0.0.1:8787'] } },
    },
    'grantedOrigins 与 siteDenylist 可并存（准入与拉黑是两个维度，交叠由运行期按黑名单优先处置）': {
      schemaVersion: 1,
      subject,
      packs: {
        '*': { grantedOrigins: ['https://shop.example'], siteDenylist: ['https://bank.example.com'] },
      },
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
    'siteDenylist 含 "*" 全通配被拒（等于关停整个产品，文法层就不给这个表达）': {
      schemaVersion: 1,
      subject,
      packs: { '*': { siteDenylist: ['*'] } },
    },
    'siteDenylist 含裸通配 host（scheme://* 不在两形态内）': {
      schemaVersion: 1,
      subject,
      packs: { '*': { siteDenylist: ['https://*'] } },
    },
    'siteDenylist 条目缺 scheme（非 origin 文法）': {
      schemaVersion: 1,
      subject,
      packs: { '*': { siteDenylist: ['bank.example.com'] } },
    },
    'siteDenylist 条目带路径（origin 之外的成分不参与判定，拒收）': {
      schemaVersion: 1,
      subject,
      packs: { '*': { siteDenylist: ['https://bank.example.com/login'] } },
    },
    'grantedOrigins 含子域通配（授权是正向集合，通配等于把注入面放回 <all_urls>）': {
      schemaVersion: 1,
      subject,
      packs: { '*': { grantedOrigins: ['https://*.shop.example'] } },
    },
    'grantedOrigins 含非 http(s) 协议（协议闭集之外）': {
      schemaVersion: 1,
      subject,
      packs: { '*': { grantedOrigins: ['file:///Users'] } },
    },
    'grantedOrigins 条目带路径（origin 之外的成分不参与判定，拒收）': {
      schemaVersion: 1,
      subject,
      packs: { '*': { grantedOrigins: ['https://shop.example/orders'] } },
    },
    'grantedOrigins 居 pack 级作用域（准入是跨站点声明，不锚定任何 pack）': {
      schemaVersion: 1,
      subject,
      packs: { 'xianyu-seller': { grantedOrigins: ['https://shop.example'] } },
    },
    'siteDenylist 条目重复（uniqueItems）': {
      schemaVersion: 1,
      subject,
      packs: { '*': { siteDenylist: ['https://bank.example.com', 'https://bank.example.com'] } },
    },
    'pack 级作用域含 siteDenylist（黑名单只有全局语义）': {
      schemaVersion: 1,
      subject,
      packs: { 'xianyu-seller': { siteDenylist: ['https://bank.example.com'] } },
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

describe('C7 已退役键剥离（读路径存量兼容）', () => {
  const legacy = {
    schemaVersion: 1,
    subject,
    packs: {
      'xianyu-seller': {
        preferences: { verbosity: 'concise', automations: { 'scan-orders': { enabled: false } } },
      },
    },
    watches: [
      {
        id: 'watch-1',
        templateId: 'page-watch',
        url: 'https://example.com/a',
        minutes: 15,
        enabled: true,
      },
    ],
  };

  it('带退役键的存量 overlay 直接校验被拒——剥离后通过（剥离是唯一兼容口）', () => {
    expect(validateUserOverlay(legacy).ok).toBe(false);
    const { value, dropped } = stripRetiredOverlayKeys(legacy);
    expect(dropped).toEqual(['/watches', '/packs/xianyu-seller/preferences/automations']);
    const result = validateUserOverlay(value);
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  it('剥离只删退役键、不改其余内容，且入参不被修改', () => {
    const snapshot = JSON.stringify(legacy);
    const { value } = stripRetiredOverlayKeys(legacy);
    expect(value).toEqual({
      schemaVersion: 1,
      subject,
      packs: { 'xianyu-seller': { preferences: { verbosity: 'concise' } } },
    });
    expect(JSON.stringify(legacy)).toBe(snapshot);
  });

  it('无退役键时 dropped 为空；非对象输入原样返回', () => {
    expect(stripRetiredOverlayKeys(validOverlay).dropped).toEqual([]);
    expect(stripRetiredOverlayKeys(null)).toEqual({ value: null, dropped: [] });
  });

  it('剥离不放宽结构校验：退役键之外的未知键剥离后仍被拒', () => {
    const { value } = stripRetiredOverlayKeys({ ...legacy, bogusTopLevel: 1 });
    expect(validateUserOverlay(value).ok).toBe(false);
  });
});
