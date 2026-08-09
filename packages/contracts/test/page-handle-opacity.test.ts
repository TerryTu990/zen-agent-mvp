import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';

/**
 * 页面句柄不透明性不变量（adr-023 / U5）。
 *
 * 句柄是会话作用域的不透明字符串：服务端与审计消费方只作等值比对，禁解析内部结构。
 * schema 对 handle 刻意不设 pattern/format/enum——任何结构约束都会把「p<N>」这类实现
 * 细节升格为契约，让 Chrome tabId 形态的假设有机会渗入服务端（adr-012 已否决的路径）。
 * 本测试把这份「刻意的不约束」钉成显式契约：约束闭集只有 type/minLength/maxLength。
 *
 * 红灯即漂移信号：给 handle 加 pattern（哪怕是 ^p\d+$）、或让异形句柄过不了校验，
 * 都意味着句柄不透明性被收紧——须显式决策而非静默通过。
 */
const schemasDir = new URL('../schemas/', import.meta.url).pathname;

function loadSchema(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(`${schemasDir}${file}`, 'utf8')) as Record<string, unknown>;
}

function subschemaAt(schema: Record<string, unknown>, path: string[]): Record<string, unknown> {
  let node: unknown = schema;
  for (const key of path) {
    expect(node, `路径 ${path.join('.')} 在 ${key} 处断裂`).toBeTypeOf('object');
    node = (node as Record<string, unknown>)[key];
  }
  expect(node, `路径 ${path.join('.')} 未命中子 schema`).toBeTypeOf('object');
  return node as Record<string, unknown>;
}

const OPAQUE_HANDLE_KEYS = ['maxLength', 'minLength', 'type'];

const HANDLE_SITES: Array<{ name: string; file: string; path: string[] }> = [
  {
    name: 'C3 group-pages 上报条目 handle',
    file: 'client-access-layer.schema.json',
    path: ['$defs', 'groupPages', 'properties', 'pages', 'items', 'properties', 'handle'],
  },
  {
    name: 'C3 snapshot-request 定向目标 page',
    file: 'client-access-layer.schema.json',
    path: ['$defs', 'snapshotRequest', 'properties', 'page'],
  },
  {
    name: 'C3 exec-instruction 定向目标 page',
    file: 'client-access-layer.schema.json',
    path: ['$defs', 'execInstruction', 'properties', 'page'],
  },
  {
    name: 'C3 guide-action 定向目标 page',
    file: 'client-access-layer.schema.json',
    path: ['$defs', 'guideAction', 'properties', 'page'],
  },
  {
    name: 'C5 审计事件 page.handle',
    file: 'audit-event.schema.json',
    path: ['properties', 'page', 'properties', 'handle'],
  },
];

/** 非 p<N> 形态的合法句柄样本：tabId 形态数字、结构化字符串、Unicode、边界长度。 */
const OPAQUE_HANDLES = [
  '1847292645',
  'workspace-view-00c3',
  'iframe:main/2',
  '页面-α.7',
  'p12',
  'a'.repeat(64),
];

describe('页面句柄不透明性（adr-023 / U5）', () => {
  for (const site of HANDLE_SITES) {
    describe(site.name, () => {
      const handleSchema = subschemaAt(loadSchema(site.file), site.path);

      it('约束闭集只有 type/minLength/maxLength——无 pattern/format/enum 等结构约束', () => {
        const keys = Object.keys(handleSchema)
          .filter((key) => key !== '$comment')
          .sort();
        expect(keys).toEqual(OPAQUE_HANDLE_KEYS);
        expect(handleSchema['type']).toBe('string');
        expect(handleSchema['minLength']).toBe(1);
        expect(handleSchema['maxLength']).toBe(64);
      });

      it('任意不透明字符串句柄合法；仅长度越界不合法', () => {
        const ajv = new Ajv2020({ strict: false });
        const validate = ajv.compile(handleSchema);
        for (const handle of OPAQUE_HANDLES) {
          expect(validate(handle), `句柄 ${JSON.stringify(handle)} 应合法`).toBe(true);
        }
        expect(validate('')).toBe(false);
        expect(validate('a'.repeat(65))).toBe(false);
      });
    });
  }

  it('C3 条目级：tabId 形态数字句柄的完整条目过校验（不透明=不许按形态拒收）', () => {
    const entrySchema = subschemaAt(loadSchema('client-access-layer.schema.json'), [
      '$defs',
      'groupPages',
      'properties',
      'pages',
      'items',
    ]);
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(entrySchema);
    for (const handle of OPAQUE_HANDLES) {
      const entry = { handle, url: 'https://host.example/page', status: 'background' };
      expect(validate(entry), JSON.stringify(validate.errors)).toBe(true);
    }
  });
});
