/**
 * 快捷指令库契约（R-5）：L1 站点包声明（pack.schema.json capabilities.quickActions）与
 * L2 用户覆盖层（user-overlay.schema.json 两作用域 quickActions/disabledQuickActions）同形。
 * 本文件钉死三条判据：占位符闭集（闭集外的 {{...}} 一律拒）、context=selection 时模板必含
 * {{selection}}、规模上界；以及 disabledQuickActions 的只收紧形态（只有 id 清单，无任何改写表达力）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { validateUserOverlay } from '../src/index.js';

const schemasDir = new URL('../schemas/', import.meta.url).pathname;

function compile(file: string) {
  const ajv = new Ajv2020({ strict: true });
  addFormats(ajv);
  return ajv.compile(JSON.parse(readFileSync(join(schemasDir, file), 'utf8')) as object);
}

const subject = { tenant: 'default', hostUserId: 'host-1001' };

function packWith(quickActions: unknown): Record<string, unknown> {
  return {
    packId: 'demo-pack',
    version: '1.0.0',
    site: { origin: 'https://demo.example' },
    featureIdRules: [{ urlPattern: '.*', featureId: 'browse' }],
    capabilities: { quickActions },
  };
}

function overlayWith(scope: Record<string, unknown>, key = 'demo-pack'): Record<string, unknown> {
  return { schemaVersion: 1, subject, packs: { [key]: scope } };
}

const explainSelection = {
  id: 'explain-selection',
  label: '解释选中内容',
  template: '请解释这段内容：\n{{selection}}',
  context: 'selection',
};

const summarizePage = {
  id: 'summarize-page',
  label: '总结本页',
  template: '请总结 {{title}}（{{url}}）的要点。',
  context: 'page',
};

describe('L1 pack.json capabilities.quickActions', () => {
  const validate = compile('pack.schema.json');

  it('合法声明通过（selection + page 两种 context）', () => {
    expect(validate(packWith([explainSelection, summarizePage])), JSON.stringify(validate.errors)).toBe(true);
  });

  it('featureIds 收窄到 pack 内某功能时通过', () => {
    expect(validate(packWith([{ ...summarizePage, featureIds: ['browse'] }]))).toBe(true);
  });

  it('context=selection 但模板不含 {{selection}} 即拒（右键选区正文无处落）', () => {
    expect(validate(packWith([{ ...explainSelection, template: '请解释本页内容。' }]))).toBe(false);
  });

  it('闭集外占位符即拒（刻意不收 HARPA 式整页正文内联）', () => {
    expect(validate(packWith([{ ...summarizePage, template: '总结：{{page}}' }]))).toBe(false);
  });

  it('label 超 40 字即拒', () => {
    expect(validate(packWith([{ ...summarizePage, label: 'x'.repeat(41) }]))).toBe(false);
  });

  it('模板超 2000 字即拒', () => {
    expect(validate(packWith([{ ...summarizePage, template: 'x'.repeat(2001) }]))).toBe(false);
  });

  it('超 20 条即拒', () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ ...summarizePage, id: `qa-${i}` }));
    expect(validate(packWith(many))).toBe(false);
  });

  it('未声明字段即拒（纯数据，无 execution/adapter 表达力）', () => {
    expect(validate(packWith([{ ...summarizePage, execution: 'http' }]))).toBe(false);
  });
});

describe('L2 user-overlay quickActions（两作用域同形）', () => {
  it('pack 级自建快捷提问通过', () => {
    const overlay = overlayWith({ quickActions: [explainSelection] });
    expect(validateUserOverlay(overlay).ok).toBe(true);
  });

  it('全局作用域自建快捷提问通过（跨站问法）', () => {
    const overlay = overlayWith({ quickActions: [summarizePage] }, '*');
    expect(validateUserOverlay(overlay).ok).toBe(true);
  });

  it('L2 同守占位符闭集与 selection 规则', () => {
    expect(validateUserOverlay(overlayWith({ quickActions: [{ ...summarizePage, template: '{{page}}' }] })).ok).toBe(false);
    expect(
      validateUserOverlay(overlayWith({ quickActions: [{ ...explainSelection, template: '无占位' }] })).ok,
    ).toBe(false);
  });

  it('disabledQuickActions 只是 id 清单（只收紧：结构上无法改写模板）', () => {
    const overlay = overlayWith({ disabledQuickActions: ['explain-selection'] });
    expect(validateUserOverlay(overlay).ok).toBe(true);
    const rewrite = overlayWith({ disabledQuickActions: [{ id: 'explain-selection', template: '别的' }] });
    expect(validateUserOverlay(rewrite).ok).toBe(false);
  });

  it('全局作用域同样可停用（黑名单式条目跨站生效）', () => {
    expect(validateUserOverlay(overlayWith({ disabledQuickActions: ['explain-selection'] }, '*')).ok).toBe(true);
  });

  it('L2 单作用域超 20 条即拒', () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ ...summarizePage, id: `qa-${i}` }));
    expect(validateUserOverlay(overlayWith({ quickActions: many })).ok).toBe(false);
  });
});
