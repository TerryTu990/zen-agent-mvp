#!/usr/bin/env node
/**
 * 开发期 Stop 验证提示 hook。
 *
 * 在 turn 收尾（声称完成的时刻）把 ZA-C-WHEN-02「验证通过才称完成」推到模型面前：
 * 若工作树存在 git-dirty 的 *.ts/*.mts 改动，注入一条非阻断提示，建议先跑构建+测试再汇报完成。
 *
 * 设计不变量：
 * - 提示而非阻断：永远 exit 0，绝不 exit 2（hook 不拖垮主对话）。
 * - 防自循环：本 hook 注入的提示会唤醒主对话，其收尾再次触发 Stop 时输入带
 *   stop_hook_active=true——此时直接放行、不重复注入，否则 dirty 工作树会无限循环。
 * - 旁路吞异常：任何内部失败（git 缺失、非仓、解析失败）都静默 exit 0。
 * - 只读 git 状态，不写盘、不改文件；仅依赖 node 内建。
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const FILE_LIST_LIMIT = 5;

function projectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

/** porcelain 行形如 ' M path'、'?? path'、'R  old -> new'；取重命名箭头后的新路径，否则取尾段路径。 */
function pathFromStatusLine(line) {
  const body = line.slice(3);
  const arrow = body.indexOf(' -> ');
  return arrow >= 0 ? body.slice(arrow + 4) : body;
}

function dirtyTsFiles(cwd) {
  const out = execFileSync('git', ['status', '--porcelain'], {
    cwd,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 10_000,
  }).toString('utf8');

  const files = [];
  for (const line of out.split('\n')) {
    if (line.length < 4) continue;
    const p = pathFromStatusLine(line);
    if (/\.(ts|mts)$/.test(p)) files.push(p);
  }
  return files;
}

function emit(files) {
  const shown = files.slice(0, FILE_LIST_LIMIT).join('、');
  const more = files.length > FILE_LIST_LIMIT ? ' 等' : '';
  const additionalContext =
    `本 turn 有 ${files.length} 个未验证的 TS 改动（git dirty）：${shown}${more}。` +
    'ZA-C-WHEN-02：验证通过才称完成——建议跑 `pnpm -r build`（tsc 严格基线）' +
    '+ 命中相关包的 `pnpm -r --workspace-concurrency=1 test` 再汇报完成。';
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'Stop', additionalContext },
    }),
  );
}

function main() {
  let hook = {};
  try {
    const raw = readFileSync(0, 'utf8').trim();
    hook = raw ? JSON.parse(raw) : {};
  } catch {
    return;
  }
  if (hook.hook_event_name !== 'Stop') return;
  if (hook.stop_hook_active === true) return; // 防自循环：本 hook 续发的 Stop 一律放行

  const cwd = hook.cwd || projectDir();
  const files = dirtyTsFiles(cwd);
  if (files.length > 0) emit(files);
}

try {
  main();
} catch {
  /* 旁路吞异常：验证提示绝不拖垮主对话 */
}
process.exit(0);
