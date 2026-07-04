import { readFileSync, readdirSync } from 'node:fs';
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
  it('manifest.json 通过 config-snapshot 校验', () => {
    const validate = compile(new Ajv2020({ strict: true }), 'config-snapshot.schema.json');
    const manifest = loadJson(join(demoConfigDir, 'manifest.json'));
    expect(validate(manifest), JSON.stringify(validate.errors)).toBe(true);
  });

  it('features/order-list/tools.json 各元素通过 tool-definition 校验', () => {
    const validate = compile(new Ajv2020({ strict: true }), 'tool-definition.schema.json');
    const tools = loadJson(join(demoConfigDir, 'features/order-list/tools.json')) as unknown[];
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(validate(tool), JSON.stringify(validate.errors)).toBe(true);
    }
  });
});
