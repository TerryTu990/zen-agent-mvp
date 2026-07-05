/**
 * CLI 入口：env → ServerOptions → startServer。
 * ZA_LLM_BASE_URL / ZA_LLM_API_KEY / ZA_LLM_MODEL 由 llm-port 在调用时读取，此处只做启动期提示。
 */
import { startServer } from './index.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} 未设置，拒绝启动`);
    process.exit(1);
  }
  return value;
}

/**
 * server 通道凭证解析：credentialRef → env `ZA_CRED_<UPPER_SNAKE(ref)>` 的真值（如 codeflowPlatformKey → ZA_CRED_CODEFLOW_PLATFORM_KEY）。
 * 真值只在执行器边界经此惰性读取、注入本次请求，不落配置/日志/审计（SEC-01/02）。
 */
function resolveCredential(ref: string): string | undefined {
  const key = `ZA_CRED_${ref.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[-\s]+/g, '_').toUpperCase()}`;
  const value = process.env[key];
  return value && value !== '' ? value : undefined;
}

const jwtSecret = requireEnv('ZA_JWT_SECRET');
const signingSecret = requireEnv('ZA_SIGNING_SECRET');
const snapshotRoot = requireEnv('ZA_SNAPSHOT_ROOT');
const port = Number(process.env['ZA_PORT'] ?? 8787);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('ZA_PORT 不是合法端口号，拒绝启动');
  process.exit(1);
}
const maxTurnRounds = Number(process.env['ZA_MAX_TURN_ROUNDS'] ?? 12);
if (!Number.isInteger(maxTurnRounds) || maxTurnRounds < 1) {
  console.error('ZA_MAX_TURN_ROUNDS 不是正整数，拒绝启动');
  process.exit(1);
}
const sessionTtlMs = Number(process.env['ZA_SESSION_TTL_MS'] ?? 3_600_000);
if (!Number.isInteger(sessionTtlMs) || sessionTtlMs < 1) {
  console.error('ZA_SESSION_TTL_MS 不是正整数，拒绝启动');
  process.exit(1);
}
if (!process.env['ZA_LLM_BASE_URL']) {
  console.warn('ZA_LLM_BASE_URL 未设置：LLM 调用将以"服务暂时不可用"降级');
}

startServer({
  port,
  jwtSecret,
  signingSecret,
  issAllowlist: (process.env['ZA_JWT_ISS_ALLOWLIST'] ?? 'zen-agent-demo')
    .split(',')
    .map((iss) => iss.trim())
    .filter((iss) => iss !== ''),
  snapshotRoot,
  maxTurnRounds,
  corsOrigin: process.env['ZA_CORS_ORIGIN'] ?? '*',
  systemPromptPath: process.env['ZA_SYSTEM_PROMPT_PATH'] ?? 'assets/system-prompt.md',
  auditSinkPath: process.env['ZA_AUDIT_SINK'] ?? '.za/events.jsonl',
  sessionDir: process.env['ZA_SESSION_DIR'] ?? '.za/sessions',
  sessionTtlMs,
  allowedProviders: ['openai-compatible'],
  demoToken: {
    enabled: process.env['ZA_DEMO_TOKEN_ENABLED'] === '1',
    iss: process.env['ZA_JWT_ISS'] ?? 'zen-agent-demo',
  },
  resolveCredential,
}).then(
  ({ port: boundPort }) => {
    console.log(`zen-agent server listening on http://127.0.0.1:${boundPort}`);
  },
  (cause) => {
    console.error(`启动失败：${cause instanceof Error ? cause.message : String(cause)}`);
    process.exit(1);
  },
);
