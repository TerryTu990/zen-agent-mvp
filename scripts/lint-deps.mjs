/**
 * 依赖 lint（U2 / ZA-C-WHERE-02）：星形组装约束的自动判定。
 * - packages/contracts：零 @zen-agent 依赖（底座）。
 * - packages/*（其余）：workspace 依赖仅允许 @zen-agent/contracts。
 * - apps/extension：零 @zen-agent 依赖（只经 HTTP/SSE 通信）。
 * - apps/server：唯一组装点，不受限。
 * - 所有包：相对 import 不得越出本包根目录。
 * 同时检查 package.json 声明依赖与 src/test 源码 import 说明符；违规 exit 1。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACTS = '@zen-agent/contracts';
const SCOPE = '@zen-agent/';

function allowedWorkspaceDeps(group, name) {
  if (group === 'apps') return name === 'server' ? null : new Set();
  return name === 'contracts' ? new Set() : new Set([CONTRACTS]);
}

function listPackages(group) {
  const dir = join(root, group);
  return readdirSync(dir).filter((name) => existsSync(join(dir, name, 'package.json')));
}

function walkTs(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== 'node_modules' && entry !== 'dist') walkTs(full, out);
    } else if (/\.(ts|tsx|mts|cts)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

const violations = [];

for (const group of ['packages', 'apps']) {
  for (const name of listPackages(group)) {
    const pkgDir = join(root, group, name);
    const allowed = allowedWorkspaceDeps(group, name);
    if (allowed === null) continue;

    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const dep of Object.keys(pkg[section] ?? {})) {
        if (dep.startsWith(SCOPE) && !allowed.has(dep)) {
          violations.push(`${group}/${name}/package.json ${section} 声明了 ${dep}（U2 禁止）`);
        }
      }
    }

    for (const file of walkTs(pkgDir)) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(IMPORT_RE)) {
        const spec = match[1];
        if (spec.startsWith(SCOPE)) {
          const depName = spec.split('/').slice(0, 2).join('/');
          if (!allowed.has(depName)) {
            violations.push(`${file.slice(root.length + 1)} import 了 ${depName}（U2 禁止）`);
          }
        } else if (spec.startsWith('.')) {
          const target = resolve(dirname(file), spec);
          if (!target.startsWith(pkgDir + '/') && target !== pkgDir) {
            violations.push(`${file.slice(root.length + 1)} 相对 import 越出包边界：${spec}`);
          }
        }
      }
    }
  }
}

if (violations.length > 0) {
  console.error('依赖 lint（U2）违规：');
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log('依赖 lint（U2）通过：星形组装约束成立。');
