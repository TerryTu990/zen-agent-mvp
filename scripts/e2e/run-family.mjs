/**
 * 浏览器 E2E 家族串行 runner：一次 pnpm -r build → 逐脚本串行执行 → 汇总退出码/耗时/git rev。
 * 识别 ZA_E2E_SKIP_BUILD 的脚本以 1 起（复用本次构建产物），其余脚本仍各自构建。
 * 任一脚本非零即家族非零，但不中断——后续脚本照跑，一次拿到全家族结果。
 * 结果落 .za/e2e/family-<rev>.json（工作区有未提交改动时为 family-<rev>-dirty.json 并记 dirty:true）；
 * 各脚本自己的证据仍在 .za/e2e/e2e-evidence/<case>/。
 *
 * 运行：node scripts/e2e/run-family.mjs [--only=a,b] [--skip=c]（名称见 FAMILY）。
 * 端口隔离：各脚本读各自的 ZA_E2E_* 端口 env，家族 runner 原样透传。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitCommit, gitDirty } from './evidence.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const OUT_DIR = join(REPO_ROOT, '.za', 'e2e');

/** 顺序即执行顺序；skipBuildAware=该脚本识别 ZA_E2E_SKIP_BUILD。 */
const FAMILY = [
  { name: 'sidepanel', script: 'run-sidepanel.mjs', skipBuildAware: false },
  { name: 'coldstart', script: 'run-coldstart-open-url.mjs', skipBuildAware: true },
  { name: 'nav-attach', script: 'run-nav-attach.mjs', skipBuildAware: true },
  { name: 'task-grant', script: 'run-task-grant.mjs', skipBuildAware: true },
  { name: 'd3', script: 'run-d3-directed.mjs', skipBuildAware: true },
  { name: 'm1', script: 'run-m1.mjs', skipBuildAware: false },
  { name: 'm2', script: 'run-m2.mjs', skipBuildAware: false },
  { name: 'm3', script: 'run-m3.mjs', skipBuildAware: false },
  { name: 'm5', script: 'run-m5.mjs', skipBuildAware: false },
  { name: 'explain-pack', script: 'run-g6-explain-pack.mjs', skipBuildAware: true },
  { name: 'user-config', script: 'run-g6-user-config.mjs', skipBuildAware: false },
];

function listArg(flag) {
  const raw = process.argv.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1) ?? '';
  return raw === '' ? [] : raw.split(',').map((item) => item.trim()).filter((item) => item !== '');
}

function runProcess(command, args, env) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { cwd: REPO_ROOT, stdio: 'inherit', env });
    child.once('error', () => resolveRun(1));
    child.once('exit', (code, signal) => resolveRun(code ?? (signal ? 1 : 0)));
  });
}

function formatMs(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

async function main() {
  const only = listArg('--only');
  const skip = listArg('--skip');
  const known = new Set(FAMILY.map((entry) => entry.name));
  for (const name of [...only, ...skip]) {
    if (!known.has(name)) {
      console.error(`未知用例名「${name}」；可用：${[...known].join(', ')}`);
      process.exit(2);
    }
  }
  const selected = FAMILY.filter(
    (entry) => (only.length === 0 || only.includes(entry.name)) && !skip.includes(entry.name),
  );
  const commit = gitCommit();
  const dirty = gitDirty();
  const startedAt = new Date();
  const report = { commit, dirty, startedAt: startedAt.toISOString(), build: null, cases: [], passed: false };
  mkdirSync(OUT_DIR, { recursive: true });
  const reportPath = join(OUT_DIR, `family-${commit}${dirty ? '-dirty' : ''}.json`);
  const flush = () => writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log(`E2E 家族（commit ${commit}${dirty ? '，工作区 dirty' : ''}）：${selected.map((entry) => entry.name).join(' → ')}`);
  console.log('[0] 夹具与端口守卫自检…');
  const selfCheckStart = Date.now();
  const selfCheck = await runProcess(
    'node',
    ['--test', join(REPO_ROOT, 'scripts', 'e2e', 'extension-fixture.test.mjs'), join(REPO_ROOT, 'scripts', 'e2e', 'port-guard.test.mjs')],
    process.env,
  );
  report.fixtureSelfCheck = { exitCode: selfCheck, durationMs: Date.now() - selfCheckStart };
  console.log('[1] pnpm -r build…');
  const buildStart = Date.now();
  const buildCode = await runProcess('pnpm', ['-r', 'build'], process.env);
  report.build = { exitCode: buildCode, durationMs: Date.now() - buildStart };
  flush();
  if (buildCode !== 0 || selfCheck !== 0) {
    report.finishedAt = new Date().toISOString();
    flush();
    console.error(buildCode !== 0 ? `构建失败（退出码 ${buildCode}），家族终止。` : `自检失败（退出码 ${selfCheck}），家族终止。`);
    process.exit(1);
  }

  for (const [index, entry] of selected.entries()) {
    console.log(`\n[${index + 2}/${selected.length + 1}] ${entry.name}（${entry.script}）…`);
    const env = entry.skipBuildAware ? { ...process.env, ZA_E2E_SKIP_BUILD: '1' } : { ...process.env };
    const caseStart = Date.now();
    const exitCode = await runProcess('node', [join(REPO_ROOT, 'scripts', 'e2e', entry.script)], env);
    const record = {
      name: entry.name,
      script: entry.script,
      exitCode,
      durationMs: Date.now() - caseStart,
      startedAt: new Date(caseStart).toISOString(),
    };
    report.cases.push(record);
    flush();
    console.log(`  → ${entry.name} ${exitCode === 0 ? '通过' : `失败（退出码 ${exitCode}）`}，${formatMs(record.durationMs)}`);
  }

  const finishedAt = new Date();
  report.finishedAt = finishedAt.toISOString();
  report.totalMs = finishedAt.getTime() - startedAt.getTime();
  report.passed = report.cases.every((record) => record.exitCode === 0);
  flush();

  console.log('\n家族汇总：');
  for (const record of report.cases) {
    console.log(`  ${record.exitCode === 0 ? 'PASS' : 'FAIL'}  ${record.name.padEnd(14)} ${formatMs(record.durationMs).padStart(8)}`);
  }
  console.log(`  构建 ${formatMs(report.build.durationMs)}，合计 ${formatMs(report.totalMs)}（${(report.totalMs / 60_000).toFixed(1)} 分钟）`);
  console.log(`  报告：${reportPath}`);
  console.log(report.passed ? '家族全绿 ✅' : '家族存在失败 ❌');
  process.exit(report.passed ? 0 : 1);
}

main().catch((error) => {
  console.error(`家族 runner 异常：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
