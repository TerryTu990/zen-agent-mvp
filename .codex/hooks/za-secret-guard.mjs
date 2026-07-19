#!/usr/bin/env node
/**
 * 开发期写期安全闸：把 ZA-C-SEC-01/02/03 从"自觉"变为 fail-closed 硬拦。
 *
 * Codex PreToolUse hook，作用于会落盘/执行的写工具（Bash|apply_patch|Edit|Write|MultiEdit）
 * 与会取值的读工具（Read|Grep）。
 * 写/执行面从 tool_input 取待写内容（apply_patch.patch、Edit/Write 的 content/new_string、
 * MultiEdit 遍历 edits、Bash.command）扫 SEC-01/02/03；读面从 Read.file_path / Grep.path
 * 判 SEC-03 凭证闭集；
 * 命中即把"红线编号 + 修法"写 stderr 并 exit 2
 * （Codex 契约：PreToolUse exit 2 拦截工具并将 stderr 作为阻断理由反馈给模型）。
 *
 * 设计不变量：
 * - 自身合规 SEC-03：只解析命令串里的"访问意图"字面量，绝不 read/open 凭证闭集内容。
 * - 旁路吞异常：除"阻断判定明确命中"外的任何内部失败一律 exit 0，不因 hook 自身 bug
 *   拖垮主对话；唯命中 exit 2。
 * - stderr 仅输出命中类型与修法指引，不回显命中的原始 secret 值（避免 secret 入日志/Context）。
 * - 纯 node 内建、无落盘：写期闸是无状态判定，不需要 session 状态。
 */
import { readFileSync } from 'node:fs';

const GUARDED_TOOLS = new Set([
  'Bash',
  'apply_patch',
  'Edit',
  'Write',
  'MultiEdit',
  'Read',
  'Grep',
]);

const SEC03_MSG =
  '试图读取凭证闭集（credentials.local.json / .env* / .git/config）。该闭集禁 read/grep/cat 取值；如需配置请改用环境变量注入，代码只读 process.env，勿在开发期读取密钥文件内容。';

/** SEC-01 已知 secret 值形态：高置信前缀/结构特征；password 赋值类走 SEC-02 分流，避免双重命中噪声。 */
const SEC01_PATTERNS = [
  { id: 'aws-access-key', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { id: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'private-key-block', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/ },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { id: 'generic-sk-key', re: /\bsk-[A-Za-z0-9]{20,}\b/ },
];

/**
 * SEC-02 凭证明文赋值：键名形如 apiKey/password/secret/token，值是单行字符串字面量。
 * 收窄两点，避免把 HTTP 头名/URL query 参数名误判为赋值：
 * - 值段禁跨行（`[^"'\n]`）：真凭证字面量必在单行内；跨行会借到远处无关引号，把 `?token=`+变量拼接误配成"赋值"。
 * - 键前不接 URL 分隔符（`(?<![?&])`）：`?token=`/`&token=` 是 query 参数名而非凭证键，其后紧跟的引号是所在串的闭合引号、非值起始引号。
 */
const SEC02_ASSIGN_RE =
  /["']?(?<![?&])\b(?:api[_-]?key|apikey|password|passwd|secret|token|access[_-]?token|client[_-]?secret)\b["']?\s*[:=]\s*(["'])([^"'\n]{6,})\1/i;

/**
 * SEC-03 凭证闭集访问意图。只匹配命令串里出现"读类命令 + 闭集文件名"的迹象；
 * 闭集 = credentials.local.json / .env 及 .env.* / .git/config。
 * 重定向（< file）也视为读意图。本 hook 不解析文件内容，仅看命令文本。
 */
const SEC03_READ_CMD_RE = /\b(?:cat|less|more|head|tail|grep|rg|ag|xxd|od|strings|bat|nl|sort|uniq|awk|sed|cp|dd|source)\b/;
const SEC03_REDIRECT_RE = /<\s*[^<]*(?:credentials\.local\.json|\.env(?:\.[A-Za-z0-9_.-]+)?|\.git\/config)\b/;
const SEC03_TARGET_RE = /(?:credentials\.local\.json|(?:^|[\s='"/])\.env(?:\.[A-Za-z0-9_.-]+)?(?=$|[\s'":)])|\.git\/config)\b/;

/** 从 MultiEdit edits 数组拼出全部 new_string；非数组/非对象元素安全跳过。 */
function collectMultiEdit(edits) {
  if (!Array.isArray(edits)) return '';
  return edits
    .map((e) => (e && typeof e === 'object' && typeof e.new_string === 'string' ? e.new_string : ''))
    .join('\n');
}

/** 取本次工具的待写文本：Codex apply_patch→patch，其余兼容 Claude Code 字段；Bash 单独走命令检测。 */
function extractWriteText(toolName, input) {
  if (typeof input !== 'object' || input === null) return '';
  if (toolName === 'apply_patch') return typeof input.patch === 'string' ? input.patch : '';
  if (toolName === 'MultiEdit') return collectMultiEdit(input.edits);
  const content = typeof input.content === 'string' ? input.content : '';
  const newString = typeof input.new_string === 'string' ? input.new_string : '';
  return `${content}\n${newString}`;
}

/** SEC-02 命中：凭证键被赋明文字面量。allowShellVar 时放行 $VAR/${VAR}（Bash 面用环境变量引用是合规写法，非明文）。 */
function matchSec02(text, allowShellVar) {
  if (typeof text !== 'string') return null;
  const m = SEC02_ASSIGN_RE.exec(text);
  if (!m) return null;
  if (allowShellVar && /^\$[A-Za-z_{]/.test(m[2])) return null;
  return {
    rule: 'ZA-C-SEC-02',
    msg: '检测到凭证键被赋以明文字符串字面量。配置/用例/mock 内凭证一律运行时注入不写真值——LLM 密钥走 .env 由 llm-port 托管、代码只读 process.env；宿主身份只经短期 JWT 与用户页面会话透传。请移除该明文值。',
  };
}

/** 返回首个命中的红线编号 + 修法文案；无命中返回 null。Read/Grep 走 SEC-03(按目标路径)；Bash 走 SEC-01/02/03；写类走 SEC-01/02。 */
function detectViolation(toolName, input) {
  if (toolName === 'Read' || toolName === 'Grep') {
    const target =
      toolName === 'Read'
        ? typeof input?.file_path === 'string'
          ? input.file_path
          : ''
        : typeof input?.path === 'string'
          ? input.path
          : '';
    if (target && SEC03_TARGET_RE.test(target)) return { rule: 'ZA-C-SEC-03', msg: SEC03_MSG };
    return null;
  }

  if (toolName === 'Bash') {
    const command = typeof input?.command === 'string' ? input.command : '';
    const sec01 = matchSec01(command);
    if (sec01) return sec01;
    const sec02 = matchSec02(command, true);
    if (sec02) return sec02;
    if (
      SEC03_TARGET_RE.test(command) &&
      (SEC03_READ_CMD_RE.test(command) || SEC03_REDIRECT_RE.test(command))
    ) {
      return { rule: 'ZA-C-SEC-03', msg: SEC03_MSG };
    }
    return null;
  }

  const text = extractWriteText(toolName, input);
  const sec01 = matchSec01(text);
  if (sec01) return sec01;
  return matchSec02(text, false);
}

function matchSec01(text) {
  if (typeof text !== 'string' || !text) return null;
  for (const { id, re } of SEC01_PATTERNS) {
    if (re.test(text)) {
      return {
        rule: 'ZA-C-SEC-01',
        msg: `检测到疑似 secret 明文值（模式: ${id}）。secret/凭证值禁入仓库/Context/日志；密钥走 .env 或 credentials.local.json（gitignore 强制），代码只读环境变量。请移除该明文值。`,
      };
    }
  }
  return null;
}

function main() {
  let hook;
  try {
    const raw = readFileSync(0, 'utf8');
    hook = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return; // 读/解析失败：旁路放行
  }
  if (hook.hook_event_name && hook.hook_event_name !== 'PreToolUse') return;
  const toolName = hook.tool_name || '';
  if (!GUARDED_TOOLS.has(toolName)) return;

  const violation = detectViolation(toolName, hook.tool_input || {});
  if (violation) {
    process.stderr.write(`[za-secret-guard] ${violation.rule} 拦截：${violation.msg}\n`);
    process.exit(2);
  }
}

try {
  main();
} catch {
  /* 旁路吞异常：除明确命中外不阻塞主对话 */
}
process.exit(0);
