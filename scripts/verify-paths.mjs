/**
 * verify:* 脚本里显式列出的测试路径存在性自检。
 *
 * 动因：vitest 对不存在的路径过滤为静默零匹配——`verify:phase2` 曾长期引用两个已删除的测试文件，
 * 门仍然全绿而其覆盖已消失（r1 A-TEST-09 / A-DOC-16）。本脚本把「路径写错＝门失效」变成硬失败。
 */
import { existsSync, readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const TEST_PATH_RE = /[A-Za-z0-9/_.-]+\.test\.ts/g;

let missing = 0;
for (const [name, body] of Object.entries(pkg.scripts)) {
  if (!name.startsWith('verify:')) continue;
  for (const path of body.match(TEST_PATH_RE) ?? []) {
    if (existsSync(path)) continue;
    console.error(`  [MISS] ${name} 引用了不存在的测试路径：${path}`);
    missing += 1;
  }
}

if (missing > 0) {
  console.error(`\n验证脚本路径自检失败：${missing} 条路径不存在——vitest 会静默零匹配，该门实际已失效。`);
  process.exit(1);
}
console.log('验证脚本路径自检通过：verify:* 引用的测试路径全部存在。');
