#!/usr/bin/env node
/**
 * 开发期 PreToolUse Bash 闸（纯 Node ESM，仅依赖内建模块）。
 *
 * 让 LLM 更准确执行开发流程：把"验证门"做成不可静默绕过的硬约束——
 * 当 agent 想用 --no-verify 跳过 pre-commit、或把 secret/无锚点 TODO（ZA-C-WHEN-01）暂存进 commit 时，
 * 在工具执行前拦下并把"为何 + 怎么改"喂回模型，使 ZA-C-HOW-05 / ZA-C-WHEN-01/02 从"自守"升为"硬拦"。
 *
 * 两道闸（仅 tool_name == Bash 生效）：
 *   (a) git commit/push 携带 --no-verify / commit -n / -c core.hooksPath 覆写 → exit 2（绕过 pre-commit 门 = ZA-C-HOW-05）。
 *   (b) 不带 bypass 的 git commit（含 --amend）           → 扫已暂存 diff 新增行：
 *        命中 secret 值模式（ZA-C-SEC-01）或裸 TODO/FIXME（无触发锚点 = ZA-C-WHEN-01）→ exit 2。
 *
 * 设计不变量：
 * - fail-open 旁路：解析/JSON/git 调用任何失败一律 exit 0 放行，hook 自身 bug 绝不拖垮主对话；
 *   唯阻断判定明确命中才 exit 2。
 * - 只读 diff 元信息（文件名 + 行号 + 触发类别），命中样例仅回行号不回 secret 原文，避免 secret 二次入日志/Context。
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const SAMPLE_LIMIT = 10;

/** secret 值轻量模式（与 za-secret-guard 同类）：命中即视为明文凭证入仓风险。 */
const SECRET_PATTERNS = [
  { re: /sk-[A-Za-z0-9]{20,}/, name: 'OpenAI 风格 key' },
  { re: /sk-ant-[A-Za-z0-9_-]{20,}/, name: 'Anthropic key' },
  { re: /ghp_[A-Za-z0-9]{36}/, name: 'GitHub PAT' },
  { re: /AKIA[A-Z0-9]{16}/, name: 'AWS Access Key' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, name: '私钥 PEM 块' },
  { re: /(?:api[_-]?key|secret|token|password|passwd)\s*[:=]\s*["'][^"'\s]{8,}["']/i, name: '硬编码凭证赋值' },
];

/**
 * 裸 TODO/FIXME 判定（违反 ZA-C-WHEN-01）：仅当 TODO/FIXME 以标记形态出现（行首或紧跟注释开启符）
 * 且整行无触发锚点（TODO(...) 括号锚 / issue 号 / phase / ZA 红线号）才命中；
 * prose 中间提及 TODO 一词、或反引号 code span 内的例证（扫描前剥除）不算 deferral。
 */
const TODO_MARKER = /(?:^|\/\/|\/\*|\*|#|<!--|;)\s*(?:TODO|FIXME)\b(?!\s*\([^)]+\))/i;
const TODO_ANCHOR = /#\d+|ZA-C-|phase|issue/i;

/** 判定命令串里是否存在某 git 子命令；用词边界匹配 'git ... <cmd>'，避免把参数值误判为子命令。 */
function hasGitSubcommand(cmd, sub) {
  return new RegExp(`\\bgit\\b[^\\n;&|]*\\b${sub}\\b`).test(cmd);
}

/** 取含 git commit 调用的 shell 段（按 && || ; | 切分）；把短 flag 检测限定在该段，避免误伤复合命令里其它命令（如 grep -n）的 -n。 */
function commitSegment(cmd) {
  const segments = cmd.split(/&&|\|\||;|\|/);
  return segments.find((s) => /\bgit\b[^\n]*\bcommit\b/.test(s)) || '';
}

/** commit/push 是否绕过 pre-commit 门：--no-verify、commit 专有 -n（含组合短flag如 -an）、或 `-c core.hooksPath=` 覆写钩子路径。 */
function bypassesVerifyGate(cmd) {
  if (!hasGitSubcommand(cmd, 'commit') && !hasGitSubcommand(cmd, 'push')) return false;
  if (/(^|\s)--no-verify(\s|=|$)/.test(cmd)) return true;
  if (/core\.hooksPath\s*=/.test(cmd)) return true;
  if (hasGitSubcommand(cmd, 'commit')) {
    // 仅在 commit 段内拦短 flag 簇里的 'n'（commit -n / -an）；message 文本不进 flag token，
    // 复合命令里其它命令（如 grep -n）的 -n 落在别的段、不在此段，故不误伤。
    if (/(^|\s)-[A-Za-z]*n[A-Za-z]*(\s|$)/.test(commitSegment(cmd))) return true;
  }
  return false;
}

function block(reason) {
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

/** 取已暂存 diff（unified=0 只出新增/删除行），git 失败抛错由上层 fail-open 吞掉。 */
function stagedDiff(cwd) {
  return execFileSync('git', ['diff', '--cached', '--unified=0'], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
    maxBuffer: 16 * 1024 * 1024,
  }).toString('utf8');
}

/** 扫 diff 新增行（'+' 开头、非 '+++' 头），按当前 hunk 文件 + 行号定位命中。仅回类别/文件/行号，不回原文。 */
function scanAddedLines(diff) {
  const hits = [];
  let file = '';
  let lineNo = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      file = raw.slice(4).replace(/^b\//, '');
      continue;
    }
    if (raw.startsWith('---') || raw.startsWith('diff ') || raw.startsWith('index ')) continue;
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunk) {
      lineNo = Number(hunk[1]);
      continue;
    }
    if (!raw.startsWith('+')) continue;
    const text = raw.slice(1);
    const at = lineNo;
    lineNo += 1;

    for (const { re, name } of SECRET_PATTERNS) {
      if (re.test(text)) {
        hits.push(`  [secret/${name}] ${file}:${at}`);
        break;
      }
    }
    const prose = text.replace(/`[^`]*`/g, '');
    if (TODO_MARKER.test(prose) && !TODO_ANCHOR.test(prose)) {
      hits.push(`  [TODO/FIXME 无锚点·ZA-C-WHEN-01] ${file}:${at}`);
    }
  }
  return hits;
}

function main() {
  let hook;
  try {
    hook = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return;
  }
  if (hook.tool_name !== 'Bash') return;
  const cmd = hook.tool_input?.command;
  if (typeof cmd !== 'string' || !cmd) return;

  if (bypassesVerifyGate(cmd)) {
    block(
      'ZA-C-HOW-05 违反：禁用 --no-verify / commit -n 绕过 pre-commit 验证门。\n' +
        '改法：移除 bypass flag，让 hook 跑完；若 hook 误报请修根因或与人确认后再提交。',
    );
  }

  // 仅在 commit（且未被上面拦下）时扫暂存内容；push/其它子命令不扫。--amend 同样扫（改写历史仍会带入暂存的 secret / 无锚点 TODO）。
  if (!hasGitSubcommand(cmd, 'commit')) return;

  let diff;
  try {
    diff = stagedDiff(hook.cwd || process.cwd());
  } catch {
    return; // git 不可用 / 非仓库 / 无暂存 → 放行
  }
  const hits = scanAddedLines(diff);
  if (hits.length === 0) return;

  const shown = hits.slice(0, SAMPLE_LIMIT);
  const more = hits.length > SAMPLE_LIMIT ? `\n  …另有 ${hits.length - SAMPLE_LIMIT} 处` : '';
  block(
    '提交被拦：暂存内容含质量门命中（secret 明文=ZA-C-SEC-01 / 无锚点 TODO=ZA-C-WHEN-01）。\n' +
      `${shown.join('\n')}${more}\n` +
      '改法：secret 改走 .env / credentials.local.json（gitignore 强制）、代码只读环境变量；' +
      'TODO/FIXME 补具体触发锚点（issue 号 / phase / 事件）或先落实，再重新 git add 提交。',
  );
}

try {
  main();
} catch {
  /* fail-open：闸自身异常绝不拖垮主对话 */
}
process.exit(0);
