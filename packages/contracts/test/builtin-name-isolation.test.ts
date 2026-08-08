import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { CONFIG_DRAFT_TOOL_ID, OPEN_URL_TOOL_ID, SITE_NAVIGATE_TOOL_ID } from '../src/index.js';

/**
 * 内建工具名与 pack/overlay id 空间的命名空间隔离不变量。
 *
 * 网关/门禁的内建工具（site_navigate / open_url / config_draft）由平台专路裁决与签发，
 * 先于 pack 工具面分派、且不经 pack 声明的 riskTier/adapter 与 L2 riskTierRaise。若某 pack
 * 能声明同名 toolId、或用户 overlay 能对其 riskTierRaise，内建专路会静默遮蔽 pack 定义、
 * 并使 L2「只收紧」被旁路（ZA-C-AGENT-04 / U7）。当前该攻击面结构性不可达，唯一屏障是
 * 「内建名一律 snake_case（含下划线），而 pack/overlay id 正则禁下划线」——这是跨文件的隐式
 * 约定。本不变量把它钉成显式契约：任一内建名都不得落入 pack/overlay 的 id 正则空间。
 *
 * 红灯即漂移信号：放宽 id 正则允许下划线、或把某内建工具改成能匹配该正则的形态（如 kebab），
 * 都会重新打开遮蔽/旁路面——须显式决策而非静默通过。
 */
const BUILTIN_TOOL_IDS = [SITE_NAVIGATE_TOOL_ID, OPEN_URL_TOOL_ID, CONFIG_DRAFT_TOOL_ID];

function patternFrom(schemaFile: string, pick: (schema: any) => unknown): RegExp {
  const schema = JSON.parse(
    readFileSync(new URL(`../schemas/${schemaFile}`, import.meta.url), 'utf8'),
  );
  const source = pick(schema);
  if (typeof source !== 'string') {
    throw new Error(`未从 ${schemaFile} 取到 id 正则源`);
  }
  return new RegExp(source);
}

describe('内建工具名命名空间隔离', () => {
  const toolIdPattern = patternFrom(
    'tool-definition.schema.json',
    (s) => s.properties?.id?.pattern,
  );
  const riskTierRaisePattern = patternFrom(
    'user-overlay.schema.json',
    (s) =>
      s.$defs?.scopeOverlay?.properties?.riskTierRaise?.propertyNames?.pattern ??
      findRiskTierRaisePattern(s),
  );

  it('内建名一律 snake_case（含下划线），作为隔离的前提约定', () => {
    for (const id of BUILTIN_TOOL_IDS) {
      expect(id, `${id} 应含下划线（内建名约定）`).toContain('_');
    }
  });

  it('任一内建名都不匹配 pack 工具 id 正则（不能被 pack 声明遮蔽）', () => {
    for (const id of BUILTIN_TOOL_IDS) {
      expect(toolIdPattern.test(id), `${id} 落入 pack id 空间：遮蔽面重开`).toBe(false);
    }
  });

  it('任一内建名都不匹配 overlay riskTierRaise 键正则（L2 无法对其收紧/放宽）', () => {
    for (const id of BUILTIN_TOOL_IDS) {
      expect(riskTierRaisePattern.test(id), `${id} 落入 overlay id 空间：L2 旁路面重开`).toBe(false);
    }
  });
});

/** 在 user-overlay schema 里定位 riskTierRaise 的 propertyNames.pattern（结构随版本可能移位，兜底深搜）。 */
function findRiskTierRaisePattern(schema: unknown): string | undefined {
  let found: string | undefined;
  const visit = (node: unknown): void => {
    if (found !== undefined || node === null || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    const raise = obj['riskTierRaise'];
    if (raise !== null && typeof raise === 'object') {
      const names = (raise as Record<string, unknown>)['propertyNames'];
      if (names !== null && typeof names === 'object') {
        const pattern = (names as Record<string, unknown>)['pattern'];
        if (typeof pattern === 'string') {
          found = pattern;
          return;
        }
      }
    }
    for (const value of Object.values(obj)) visit(value);
  };
  visit(schema);
  return found;
}
