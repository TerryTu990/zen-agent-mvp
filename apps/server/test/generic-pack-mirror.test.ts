/**
 * generic-web 双份镜像对拍：生产快照 `assets/packs/generic-web` 与验收夹具
 * `examples/acceptance/packs/generic-web` MUST 逐字节一致。
 * 两份并存是因为快照根自包含（生产与夹具各是一个独立快照），不是有意分叉——
 * 一旦分叉，E2E/评测验的就不是发布出去的那份规则，绿灯将失去意义。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = new URL('../../../', import.meta.url).pathname;
const PRODUCTION = join(repoRoot, 'assets/packs/generic-web');
const FIXTURE = join(repoRoot, 'examples/acceptance/packs/generic-web');

function filesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(root, full));
    }
  };
  walk(root);
  return out;
}

describe('generic-web 生产快照与验收夹具对拍', () => {
  it('文件清单一致', () => {
    expect(filesUnder(FIXTURE)).toEqual(filesUnder(PRODUCTION));
  });

  it('每个文件内容逐字节一致', () => {
    const files = filesUnder(PRODUCTION);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(
        readFileSync(join(FIXTURE, file), 'utf8'),
        `${file} 两份不一致：改一处必须同步另一处`,
      ).toBe(readFileSync(join(PRODUCTION, file), 'utf8'));
    }
  });
});
