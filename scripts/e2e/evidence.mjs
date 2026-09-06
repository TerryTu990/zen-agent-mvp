/**
 * E2E 证据落盘的公共件：每个用例在 .za/e2e/e2e-evidence/<case>/result.json 留一条
 * { case, status, ranAt, commit }，家族 runner 与人工复盘据此定位「哪一版代码、何时、跑成什么样」。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
export const EVIDENCE_ROOT = join(REPO_ROOT, '.za', 'e2e', 'e2e-evidence');

export function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

/** 工作区含未提交改动（含未跟踪文件）即 true；git 不可用时按 dirty 处理，宁可多标不可漏标。 */
export function gitDirty() {
  try {
    return execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim() !== '';
  } catch {
    return true;
  }
}

/** status ∈ passed | failed；failed 时由调用方在 extra 里带 reason。返回该用例的证据目录。 */
export function writeCaseResult(caseName, status, extra = {}) {
  const dir = join(EVIDENCE_ROOT, caseName);
  mkdirSync(dir, { recursive: true });
  const record = { case: caseName, status, ranAt: new Date().toISOString(), commit: gitCommit(), ...extra };
  writeFileSync(join(dir, 'result.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return dir;
}

export function failureReason(error) {
  return error instanceof Error ? error.message : String(error);
}
