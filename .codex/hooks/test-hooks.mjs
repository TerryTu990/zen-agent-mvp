#!/usr/bin/env node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const hookDir = fileURLToPath(new URL('.', import.meta.url));

function run(script, input) {
  return spawnSync(process.execPath, [join(hookDir, script)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const harmless = run('za-secret-guard.mjs', {
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'git status --short' },
});
assert(harmless.status === 0, 'secret guard should allow harmless Bash input');

const credentialAssignment = `${['api', 'Key'].join('')}: "${['fixture', 'value'].join('-')}"`;
const guardedPatch = run('za-secret-guard.mjs', {
  hook_event_name: 'PreToolUse',
  tool_name: 'apply_patch',
  tool_input: { patch: credentialAssignment },
});
assert(guardedPatch.status === 2, 'secret guard should block Codex apply_patch input');
assert(guardedPatch.stderr.includes('ZA-C-SEC-02'), 'secret guard should report SEC-02');

const bypass = run('za-bash-guard.mjs', {
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: `git commit --${['no', 'verify'].join('-')}` },
});
assert(bypass.status === 2, 'bash guard should block verification bypass');

const repo = mkdtempSync(join(tmpdir(), 'za-codex-hooks-'));
try {
  const initialized = spawnSync('git', ['init', '-q'], { cwd: repo, encoding: 'utf8' });
  assert(initialized.status === 0, 'temporary git repository should initialize');
  writeFileSync(join(repo, 'changed.ts'), 'export const changed = true;\n');

  const stop = run('za-verify-on-stop.mjs', {
    hook_event_name: 'Stop',
    stop_hook_active: false,
    cwd: repo,
  });
  assert(stop.status === 0, 'Stop hook should exit successfully');
  const output = JSON.parse(stop.stdout);
  assert(output.decision === 'block', 'Stop hook should use Codex decision:block');
  assert(typeof output.reason === 'string' && output.reason.includes('ZA-C-WHEN-02'),
    'Stop hook should return the verification rule');

  const repeatedStop = run('za-verify-on-stop.mjs', {
    hook_event_name: 'Stop',
    stop_hook_active: true,
    cwd: repo,
  });
  assert(repeatedStop.status === 0 && repeatedStop.stdout === '',
    'Stop hook should suppress recursive continuation');
} finally {
  rmSync(repo, { recursive: true, force: true });
}

process.stdout.write('Codex hook contract tests passed.\n');
